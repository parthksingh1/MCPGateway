import { canonicalize, sha256Hex, type CanonicalValue } from '@mcpgateway/shared';

/**
 * The hash chain.
 *
 * Each row commits to the row before it:
 *
 *     row_hash = sha256( prev_hash || canonical(row without its hashes) )
 *
 * Changing any historical field changes that row's hash, which breaks the
 * `prev_hash` link every later row depends on. An attacker who wants a
 * consistent-looking log has to rewrite the entire tail, and the verifier names
 * the exact row where the recomputation first diverges.
 *
 * Canonical JSON does the load-bearing work here: two structurally identical
 * rows must serialise byte-identically or verification would fail on rows that
 * were never touched.
 */

/** Domain separator, so a hash from this chain cannot be replayed elsewhere. */
const CHAIN_DOMAIN = 'mcpgateway:audit:v1';

export interface AuditRowInput {
  readonly id: string;
  readonly ts: Date;
  readonly tenantId: string;
  readonly userId: string;
  readonly actorTokenJti: string;
  readonly mcpServer: string;
  readonly toolName: string;
  readonly argumentsHash: string;
  readonly decision: 'allow' | 'deny';
  readonly denyReason: string | null;
  readonly latencyMs: number;
  readonly traceId: string | null;
}

/**
 * The first `prev_hash` in a tenant's chain.
 *
 * Chains are per tenant rather than global. A single global chain would force
 * every audit write in the system through one lock; per-tenant chains let
 * tenants append concurrently while keeping the tamper-evidence property
 * inside each tenant's own history, which is the boundary an auditor cares
 * about. Deriving the genesis value from the tenant id also means a row cannot
 * be lifted from one tenant's chain and spliced into another's.
 */
export function genesisHash(tenantId: string): string {
  return sha256Hex(`${CHAIN_DOMAIN}:genesis:${tenantId}`);
}

/**
 * Canonical representation of a row for hashing.
 *
 * Explicitly enumerated rather than spread from the row object: adding a
 * column should be a deliberate decision about whether it is covered by the
 * chain, not something that silently invalidates every existing hash.
 */
export function canonicalRow(row: AuditRowInput): string {
  const value: CanonicalValue = {
    actor_token_jti: row.actorTokenJti,
    arguments_hash: row.argumentsHash,
    decision: row.decision,
    deny_reason: row.denyReason,
    id: row.id,
    latency_ms: row.latencyMs,
    mcp_server: row.mcpServer,
    tenant_id: row.tenantId,
    tool_name: row.toolName,
    trace_id: row.traceId,
    ts: row.ts.toISOString(),
    user_id: row.userId,
  };
  return canonicalize(value);
}

export function computeRowHash(prevHash: string, row: AuditRowInput): string {
  return sha256Hex(`${prevHash}${canonicalRow(row)}`);
}

export interface ChainLink extends AuditRowInput {
  readonly prevHash: string;
  readonly rowHash: string;
  readonly seq?: number;
}

export interface VerificationBreak {
  readonly seq: number | null;
  readonly id: string;
  readonly tenantId: string;
  readonly reason: 'row_hash_mismatch' | 'prev_hash_mismatch' | 'ordering_violation';
  readonly expected: string;
  readonly actual: string;
}

/** Recompute one link. Returns the break if it does not hold. */
export function verifyLink(link: ChainLink, expectedPrevHash: string): VerificationBreak | null {
  if (link.prevHash !== expectedPrevHash) {
    return {
      seq: link.seq ?? null,
      id: link.id,
      tenantId: link.tenantId,
      reason: 'prev_hash_mismatch',
      expected: expectedPrevHash,
      actual: link.prevHash,
    };
  }

  const recomputed = computeRowHash(link.prevHash, link);
  if (recomputed !== link.rowHash) {
    return {
      seq: link.seq ?? null,
      id: link.id,
      tenantId: link.tenantId,
      reason: 'row_hash_mismatch',
      expected: recomputed,
      actual: link.rowHash,
    };
  }

  return null;
}

/**
 * Walk a tenant's chain in order and report the first break.
 *
 * Stops at the first divergence: every subsequent row is derived from a value
 * that is already known to be wrong, so reporting them all would be noise.
 */
export function verifyChain(
  tenantId: string,
  links: readonly ChainLink[],
): { valid: boolean; checked: number; break: VerificationBreak | null } {
  let expected = genesisHash(tenantId);
  let checked = 0;

  for (const link of links) {
    const failure = verifyLink(link, expected);
    if (failure) return { valid: false, checked, break: failure };
    expected = link.rowHash;
    checked += 1;
  }

  return { valid: true, checked, break: null };
}
