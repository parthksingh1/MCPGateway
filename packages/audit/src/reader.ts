import type { Database } from '@mcpgateway/shared/db';
import { sql, type SQL } from 'drizzle-orm';

export interface AuditQuery {
  readonly tenantId?: string;
  readonly userId?: string;
  readonly toolName?: string;
  readonly mcpServer?: string;
  readonly decision?: 'allow' | 'deny';
  readonly from?: Date;
  readonly to?: Date;
  /** Free-text match across user, tool and deny reason. */
  readonly search?: string;
  readonly limit?: number;
  readonly offset?: number;
}

export interface AuditEventView {
  readonly id: string;
  readonly seq: number;
  readonly ts: string;
  readonly tenantId: string;
  readonly userId: string;
  readonly userName: string | null;
  readonly actorTokenJti: string;
  readonly mcpServer: string;
  readonly toolName: string;
  readonly argumentsHash: string;
  readonly decision: 'allow' | 'deny';
  readonly denyReason: string | null;
  readonly latencyMs: number;
  readonly traceId: string | null;
  readonly prevHash: string;
  readonly rowHash: string;
}

export interface AuditPage {
  readonly rows: AuditEventView[];
  readonly total: number;
}

interface RawRow extends Record<string, unknown> {
  id: string;
  seq: number | string;
  ts: Date | string;
  tenant_id: string;
  user_id: string;
  user_name: string | null;
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

function buildFilters(query: AuditQuery): SQL {
  const clauses: SQL[] = [sql`TRUE`];
  if (query.tenantId) clauses.push(sql`e.tenant_id = ${query.tenantId}`);
  if (query.userId) clauses.push(sql`e.user_id = ${query.userId}`);
  if (query.toolName) clauses.push(sql`e.tool_name = ${query.toolName}`);
  if (query.mcpServer) clauses.push(sql`e.mcp_server = ${query.mcpServer}`);
  if (query.decision) clauses.push(sql`e.decision = ${query.decision}`);
  if (query.from) clauses.push(sql`e.ts >= ${query.from.toISOString()}`);
  if (query.to) clauses.push(sql`e.ts <= ${query.to.toISOString()}`);
  if (query.search) {
    const pattern = `%${query.search}%`;
    clauses.push(
      sql`(e.user_id ILIKE ${pattern} OR e.tool_name ILIKE ${pattern} OR COALESCE(e.deny_reason, '') ILIKE ${pattern} OR COALESCE(u.name, '') ILIKE ${pattern})`,
    );
  }
  return sql.join(clauses, sql` AND `);
}

/** Read side of the audit log, used by the console's table and filters. */
export async function queryAuditEvents(db: Database, query: AuditQuery): Promise<AuditPage> {
  const limit = Math.min(Math.max(query.limit ?? 50, 1), 500);
  const offset = Math.max(query.offset ?? 0, 0);
  const where = buildFilters(query);

  const [page, count] = await Promise.all([
    db.execute<RawRow>(sql`
      SELECT e.id, e.seq, e.ts, e.tenant_id, e.user_id, u.name AS user_name, e.actor_token_jti,
             e.mcp_server, e.tool_name, e.arguments_hash, e.decision, e.deny_reason,
             e.latency_ms, e.trace_id, e.prev_hash, e.row_hash
      FROM audit_events e
      LEFT JOIN users u ON u.id = e.user_id
      WHERE ${where}
      ORDER BY e.ts DESC, e.seq DESC
      LIMIT ${limit} OFFSET ${offset}
    `),
    db.execute<{ total: number | string } & Record<string, unknown>>(sql`
      SELECT COUNT(*)::bigint AS total
      FROM audit_events e
      LEFT JOIN users u ON u.id = e.user_id
      WHERE ${where}
    `),
  ]);

  return {
    rows: page.rows.map(toView),
    total: Number(count.rows[0]?.total ?? 0),
  };
}

function toView(raw: RawRow): AuditEventView {
  return {
    id: raw.id,
    seq: Number(raw.seq),
    ts: (raw.ts instanceof Date ? raw.ts : new Date(raw.ts)).toISOString(),
    tenantId: raw.tenant_id,
    userId: raw.user_id,
    userName: raw.user_name,
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

export interface AuditStats {
  readonly total: number;
  readonly allowed: number;
  readonly denied: number;
  readonly p50LatencyMs: number;
  readonly p95LatencyMs: number;
  readonly p99LatencyMs: number;
  readonly topTools: { tool: string; count: number }[];
  readonly topTenants: { tenantId: string; name: string | null; count: number }[];
  readonly series: { bucket: string; allowed: number; denied: number; p95LatencyMs: number }[];
}

/**
 * Aggregates for the overview page.
 *
 * Percentiles come from `percentile_disc` over the audit rows rather than from
 * the metrics pipeline, so the numbers on the overview always agree with the
 * rows an operator can click through to.
 */
export async function auditStats(
  db: Database,
  input: { tenantId?: string; since: Date; bucketMinutes?: number },
): Promise<AuditStats> {
  const bucketMinutes = input.bucketMinutes ?? 5;
  const tenantFilter = input.tenantId ? sql`AND tenant_id = ${input.tenantId}` : sql``;
  const since = input.since.toISOString();

  const [totals, tools, tenants, series] = await Promise.all([
    db.execute<
      {
        total: number | string;
        allowed: number | string;
        denied: number | string;
        p50: number | string | null;
        p95: number | string | null;
        p99: number | string | null;
      } & Record<string, unknown>
    >(sql`
      SELECT COUNT(*)::bigint AS total,
             COUNT(*) FILTER (WHERE decision = 'allow')::bigint AS allowed,
             COUNT(*) FILTER (WHERE decision = 'deny')::bigint AS denied,
             percentile_disc(0.50) WITHIN GROUP (ORDER BY latency_ms) AS p50,
             percentile_disc(0.95) WITHIN GROUP (ORDER BY latency_ms) AS p95,
             percentile_disc(0.99) WITHIN GROUP (ORDER BY latency_ms) AS p99
      FROM audit_events
      WHERE ts >= ${since} ${tenantFilter}
    `),
    db.execute<{ tool: string; count: number | string } & Record<string, unknown>>(sql`
      SELECT tool_name AS tool, COUNT(*)::bigint AS count
      FROM audit_events
      WHERE ts >= ${since} ${tenantFilter}
      GROUP BY tool_name
      ORDER BY count DESC
      LIMIT 8
    `),
    db.execute<{ tenant_id: string; name: string | null; count: number | string } & Record<string, unknown>>(sql`
      SELECT e.tenant_id, t.name, COUNT(*)::bigint AS count
      FROM audit_events e
      LEFT JOIN tenants t ON t.id = e.tenant_id
      WHERE e.ts >= ${since}
      GROUP BY e.tenant_id, t.name
      ORDER BY count DESC
      LIMIT 8
    `),
    db.execute<
      {
        bucket: Date | string;
        allowed: number | string;
        denied: number | string;
        p95: number | string | null;
      } & Record<string, unknown>
    >(sql`
      SELECT to_timestamp(floor(extract(epoch FROM ts) / ${bucketMinutes * 60}) * ${bucketMinutes * 60}) AS bucket,
             COUNT(*) FILTER (WHERE decision = 'allow')::bigint AS allowed,
             COUNT(*) FILTER (WHERE decision = 'deny')::bigint AS denied,
             percentile_disc(0.95) WITHIN GROUP (ORDER BY latency_ms) AS p95
      FROM audit_events
      WHERE ts >= ${since} ${tenantFilter}
      GROUP BY bucket
      ORDER BY bucket ASC
    `),
  ]);

  const head = totals.rows[0];
  return {
    total: Number(head?.total ?? 0),
    allowed: Number(head?.allowed ?? 0),
    denied: Number(head?.denied ?? 0),
    p50LatencyMs: Number(head?.p50 ?? 0),
    p95LatencyMs: Number(head?.p95 ?? 0),
    p99LatencyMs: Number(head?.p99 ?? 0),
    topTools: tools.rows.map((r) => ({ tool: r.tool, count: Number(r.count) })),
    topTenants: tenants.rows.map((r) => ({
      tenantId: r.tenant_id,
      name: r.name,
      count: Number(r.count),
    })),
    series: series.rows.map((r) => ({
      bucket: (r.bucket instanceof Date ? r.bucket : new Date(r.bucket)).toISOString(),
      allowed: Number(r.allowed),
      denied: Number(r.denied),
      p95LatencyMs: Number(r.p95 ?? 0),
    })),
  };
}
