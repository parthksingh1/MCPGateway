import type { Database } from '@mcpgateway/shared/db';
import { sql } from 'drizzle-orm';

import { genesisHash, verifyLink, type ChainLink, type VerificationBreak } from './hash.js';

export interface ChainVerificationResult {
  readonly tenantId: string;
  readonly valid: boolean;
  readonly rowsChecked: number;
  readonly firstBreak: VerificationBreak | null;
  readonly headHash: string;
  /** Head recorded in `audit_chain_heads`, for cross-checking against the walk. */
  readonly recordedHeadHash: string | null;
  readonly durationMs: number;
}

interface RawRow extends Record<string, unknown> {
  seq: number | string;
  id: string;
  ts: string | Date;
  tenant_id: string;
  user_id: string;
  actor_token_jti: string;
  mcp_server: string;
  tool_name: string;
  arguments_hash: string;
  decision: string;
  deny_reason: string | null;
  latency_ms: number | string;
  trace_id: string | null;
  prev_hash: string;
  row_hash: string;
}

function toLink(raw: RawRow): ChainLink {
  return {
    seq: Number(raw.seq),
    id: raw.id,
    ts: raw.ts instanceof Date ? raw.ts : new Date(raw.ts),
    tenantId: raw.tenant_id,
    userId: raw.user_id,
    actorTokenJti: raw.actor_token_jti,
    mcpServer: raw.mcp_server,
    toolName: raw.tool_name,
    argumentsHash: raw.arguments_hash.trim(),
    decision: raw.decision === 'deny' ? 'deny' : 'allow',
    denyReason: raw.deny_reason,
    latencyMs: Number(raw.latency_ms),
    traceId: raw.trace_id,
    prevHash: raw.prev_hash.trim(),
    rowHash: raw.row_hash.trim(),
  };
}

/**
 * Walk one tenant's chain from genesis and report the first row that does not
 * verify.
 *
 * Rows are read in batches ordered by `seq` rather than loaded all at once, so
 * verification is bounded in memory and can run against a log with millions of
 * rows.
 */
export async function verifyTenantChain(
  db: Database,
  tenantId: string,
  options: { batchSize?: number } = {},
): Promise<ChainVerificationResult> {
  const batchSize = options.batchSize ?? 1_000;
  const startedAt = performance.now();

  let expected = genesisHash(tenantId);
  let afterSeq = 0;
  let rowsChecked = 0;
  let firstBreak: VerificationBreak | null = null;
  let lastSeq = -1;

  for (;;) {
    const page = await db.execute<RawRow>(sql`
      SELECT seq, id, ts, tenant_id, user_id, actor_token_jti, mcp_server, tool_name,
             arguments_hash, decision, deny_reason, latency_ms, trace_id, prev_hash, row_hash
      FROM audit_events
      WHERE tenant_id = ${tenantId} AND seq > ${afterSeq}
      ORDER BY seq ASC
      LIMIT ${batchSize}
    `);

    const rows = page.rows;
    if (rows.length === 0) break;

    for (const raw of rows) {
      const link = toLink(raw);
      const seq = link.seq ?? 0;

      if (seq <= lastSeq) {
        firstBreak = {
          seq,
          id: link.id,
          tenantId,
          reason: 'ordering_violation',
          expected: `> ${lastSeq}`,
          actual: String(seq),
        };
        break;
      }
      lastSeq = seq;

      const failure = verifyLink(link, expected);
      if (failure) {
        firstBreak = failure;
        break;
      }

      expected = link.rowHash;
      rowsChecked += 1;
      afterSeq = seq;
    }

    if (firstBreak) break;
    if (rows.length < batchSize) break;
  }

  const head = await db.execute<{ prev_hash: string } & Record<string, unknown>>(sql`
    SELECT prev_hash FROM audit_chain_heads WHERE tenant_id = ${tenantId}
  `);
  const recordedHeadHash = head.rows[0]?.prev_hash.trim() ?? null;

  // A walk that verifies but ends somewhere other than the recorded head means
  // rows were removed from the tail — deletion the per-row hashes alone cannot
  // detect, since the surviving prefix is internally consistent.
  const truncated =
    firstBreak === null && recordedHeadHash !== null && recordedHeadHash !== expected;

  return {
    tenantId,
    valid: firstBreak === null && !truncated,
    rowsChecked,
    firstBreak: truncated
      ? {
          seq: null,
          id: '(chain tail)',
          tenantId,
          reason: 'prev_hash_mismatch',
          expected: recordedHeadHash,
          actual: expected,
        }
      : firstBreak,
    headHash: expected,
    recordedHeadHash,
    durationMs: performance.now() - startedAt,
  };
}

/** Verify every tenant that has at least one audit row. */
export async function verifyAllChains(
  db: Database,
  options: { batchSize?: number } = {},
): Promise<ChainVerificationResult[]> {
  const tenants = await db.execute<{ tenant_id: string } & Record<string, unknown>>(sql`
    SELECT DISTINCT tenant_id FROM audit_events ORDER BY tenant_id
  `);
  const results: ChainVerificationResult[] = [];
  for (const row of tenants.rows) {
    results.push(await verifyTenantChain(db, row.tenant_id, options));
  }
  return results;
}
