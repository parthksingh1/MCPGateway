import { newId, sha256Canonical, type CanonicalValue } from '@mcpgateway/shared';
import type { Database } from '@mcpgateway/shared/db';
import { auditWrites, GatewayAttr, annotate } from '@mcpgateway/telemetry';
import { sql } from 'drizzle-orm';

import { computeRowHash, genesisHash, type AuditRowInput } from './hash.js';

export interface AppendAuditInput {
  readonly tenantId: string;
  readonly userId: string;
  readonly actorTokenJti: string;
  readonly mcpServer: string;
  readonly toolName: string;
  /** Raw tool arguments. Only their digest is stored unless capture is on. */
  readonly arguments: Record<string, unknown>;
  readonly decision: 'allow' | 'deny';
  readonly denyReason?: string | null;
  readonly latencyMs: number;
  readonly traceId?: string | null;
  readonly occurredAt?: Date;
  /** Per-tenant opt-in. Overrides the writer default for this one row. */
  readonly capturePayload?: boolean;
}

export interface AppendedAuditRow {
  readonly id: string;
  readonly seq: number;
  readonly prevHash: string;
  readonly rowHash: string;
  readonly ts: Date;
}

export interface AuditWriterOptions {
  /** Default for argument capture when a call does not specify one. */
  readonly capturePayloads?: boolean;
}

interface HeadRow extends Record<string, unknown> {
  prev_hash: string;
  length: number;
}

interface InsertedRow extends Record<string, unknown> {
  seq: number | string;
}

/**
 * Appends rows to the tamper-evident audit log.
 *
 * Every append runs in one transaction that:
 *   1. locks the tenant's chain head (`SELECT ... FOR UPDATE`)
 *   2. computes `row_hash` from the locked `prev_hash`
 *   3. inserts the row
 *   4. advances the head
 *
 * The lock is what makes the chain well defined under concurrency: without it
 * two replicas would read the same `prev_hash` and produce two rows claiming
 * the same predecessor, which is indistinguishable from tampering. Holding it
 * per tenant rather than globally keeps tenants from serialising against each
 * other.
 *
 * Arguments are hashed, not stored. Tool arguments routinely carry customer
 * data, and the chain only needs the digest to prove the call was not altered.
 * Tenants that need the full payload for their own compliance reasons opt in,
 * and it lands in a separate table that is not part of the chain.
 */
export class AuditWriter {
  private readonly capturePayloads: boolean;

  constructor(
    private readonly db: Database,
    options: AuditWriterOptions = {},
  ) {
    this.capturePayloads = options.capturePayloads ?? false;
  }

  async append(input: AppendAuditInput): Promise<AppendedAuditRow> {
    const id = newId();
    const ts = input.occurredAt ?? new Date();
    const argumentsHash = sha256Canonical(input.arguments as CanonicalValue);

    const row: AuditRowInput = {
      id,
      ts,
      tenantId: input.tenantId,
      userId: input.userId,
      actorTokenJti: input.actorTokenJti,
      mcpServer: input.mcpServer,
      toolName: input.toolName,
      argumentsHash,
      decision: input.decision,
      denyReason: input.denyReason ?? null,
      latencyMs: Math.max(0, Math.round(input.latencyMs)),
      traceId: input.traceId ?? null,
    };

    const genesis = genesisHash(input.tenantId);
    const capture = input.capturePayload ?? this.capturePayloads;

    try {
      const result = await this.db.transaction(async (tx) => {
        // Create the chain lazily on a tenant's first ever event.
        await tx.execute(sql`
          INSERT INTO audit_chain_heads (tenant_id, prev_hash, length)
          VALUES (${input.tenantId}, ${genesis}, 0)
          ON CONFLICT (tenant_id) DO NOTHING
        `);

        const head = await tx.execute<HeadRow>(sql`
          SELECT prev_hash, length
          FROM audit_chain_heads
          WHERE tenant_id = ${input.tenantId}
          FOR UPDATE
        `);

        const prevHash = head.rows[0]?.prev_hash ?? genesis;
        const rowHash = computeRowHash(prevHash, row);

        const inserted = await tx.execute<InsertedRow>(sql`
          INSERT INTO audit_events (
            id, ts, tenant_id, user_id, actor_token_jti, mcp_server, tool_name,
            arguments_hash, decision, deny_reason, latency_ms, trace_id,
            prev_hash, row_hash
          ) VALUES (
            ${row.id}, ${row.ts.toISOString()}, ${row.tenantId}, ${row.userId},
            ${row.actorTokenJti}, ${row.mcpServer}, ${row.toolName},
            ${row.argumentsHash}, ${row.decision}, ${row.denyReason},
            ${row.latencyMs}, ${row.traceId}, ${prevHash}, ${rowHash}
          )
          RETURNING seq
        `);

        await tx.execute(sql`
          UPDATE audit_chain_heads
          SET prev_hash = ${rowHash}, length = length + 1, updated_at = now()
          WHERE tenant_id = ${input.tenantId}
        `);

        if (capture) {
          // No ON CONFLICT clause: `event_id` is freshly generated for this
          // append, so a conflict is not reachable. An inference clause would
          // also force a SELECT privilege the audit role deliberately lacks.
          await tx.execute(sql`
            INSERT INTO audit_payloads (event_id, tenant_id, payload)
            VALUES (${row.id}, ${row.tenantId}, ${JSON.stringify(input.arguments)}::jsonb)
          `);
        }

        return { seq: Number(inserted.rows[0]?.seq ?? 0), prevHash, rowHash };
      });

      auditWrites.add(1, { outcome: 'appended', decision: row.decision });
      annotate({ [GatewayAttr.AUDIT_SEQ]: result.seq });

      return { id, seq: result.seq, prevHash: result.prevHash, rowHash: result.rowHash, ts };
    } catch (error) {
      auditWrites.add(1, { outcome: 'failed', decision: row.decision });
      throw error;
    }
  }
}
