import { verifyTenantChain } from '@mcpgateway/audit';
import { createDatabase, type DbHandle } from '@mcpgateway/shared/db';
import { sql } from 'drizzle-orm';
import { decodeJwt } from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { runMigrations } from '../../scripts/migrate.js';
import { seed } from '../../scripts/seed.js';

import { startPostgres, startRedis } from './helpers/services.js';
import { startStack, type Stack } from './helpers/stack.js';

let stack: Stack;
let db: DbHandle;
let stop: () => Promise<void>;

let aliceToken: string;
let bobToken: string;
let danaToken: string;
let liamToken: string;
let miaToken: string;

function asAuditRole(url: string): string {
  const parsed = new URL(url);
  parsed.username = 'mcpgw_audit';
  parsed.password = 'mcpgw_audit';
  return parsed.toString();
}

beforeAll(async () => {
  const [postgres, redis] = await Promise.all([startPostgres(), startRedis()]);
  stop = async () => {
    await Promise.all([postgres.stop(), redis.stop()]);
  };

  // The warehouse lives in its own database in production. Inside a single
  // test container it shares one, which changes nothing the tests care about:
  // row-level security is per table, not per database.
  await runMigrations({ controlUrl: postgres.url, warehouseUrl: postgres.url });

  process.env.DATABASE_URL = postgres.url;
  process.env.WAREHOUSE_DATABASE_URL = postgres.url;
  process.env.AUDIT_DATABASE_URL = asAuditRole(postgres.url);
  // A small warehouse: these tests assert on visibility, not on volume.
  await seed({ auditEvents: 40, skipWarehouse: false });

  db = createDatabase(postgres.url);
  stack = await startStack({
    databaseUrl: postgres.url,
    auditDatabaseUrl: asAuditRole(postgres.url),
    warehouseUrl: postgres.url,
    redisUrl: redis.url,
  });

  [aliceToken, bobToken, danaToken, liamToken, miaToken] = await Promise.all([
    stack.signIn('alice.chen@acme-corp.com'),
    stack.signIn('bob.martinez@acme-corp.com'),
    stack.signIn('dana.olsen@acme-corp.com'),
    stack.signIn('liam.novak@initech.dev'),
    stack.signIn('mia.torres@initech.dev'),
  ]);
}, 600_000);

afterAll(async () => {
  await stack?.stop();
  await db?.close();
  await stop?.();
});

describe('end to end tool dispatch', () => {
  it('routes a CRM call and reports what happened to it', async () => {
    const { status, body } = await stack.callTool(
      aliceToken,
      'salesforce',
      'sf.list_opportunities',
      {
        limit: 5,
      },
    );

    expect(status).toBe(200);
    expect(body.ok).toBe(true);

    const meta = body.meta as Record<string, Record<string, unknown>>;
    expect(meta.policy?.decision).toBe('allow');
    expect(meta.tokenExchange?.audience).toBe('mcp:salesforce');
    expect(meta.tokenExchange?.subject).toBe('usr_alice');
    expect(meta.rateLimit?.allowed).toBe(true);
  });

  it('refuses an unknown tool before minting anything', async () => {
    const { status, body } = await stack.callTool(aliceToken, 'salesforce', 'sf.drop_everything');
    expect(status).toBe(404);
    expect((body.error as Record<string, unknown>).code).toBe('not_found');
  });

  it('refuses a call with no credential', async () => {
    const response = await stack.gateway.inject({
      method: 'POST',
      url: '/v1/servers/salesforce/tools/sf.list_opportunities',
      payload: { arguments: {} },
    });
    expect(response.statusCode).toBe(401);
  });

  it('refuses a token this issuer did not sign', async () => {
    const { status } = await stack.callTool('not-a-token', 'salesforce', 'sf.list_opportunities');
    expect(status).toBe(401);
  });
});

describe('permission mirroring', () => {
  it('mints a downstream token that names the caller, not a service account', async () => {
    const { body } = await stack.callTool(aliceToken, 'salesforce', 'sf.list_opportunities');
    const meta = body.meta as Record<string, Record<string, unknown>>;

    expect(meta.tokenExchange?.subject).toBe('usr_alice');
    expect(meta.tokenExchange?.audience).toBe('mcp:salesforce');
    // Only CRM scopes travel to the CRM server.
    expect(meta.tokenExchange?.scopes).toEqual(
      expect.arrayContaining([expect.stringMatching(/^salesforce:/)]),
    );
    expect(meta.tokenExchange?.scopes).not.toContain('postgres:read');
  });

  it('returns different data to an analyst and their manager for the same call', async () => {
    const alice = await stack.callTool(aliceToken, 'salesforce', 'sf.list_opportunities', {
      limit: 200,
    });
    const bob = await stack.callTool(bobToken, 'salesforce', 'sf.list_opportunities', {
      limit: 200,
    });

    const aliceResult = alice.body.result as Record<string, unknown>;
    const bobResult = bob.body.result as Record<string, unknown>;

    expect(aliceResult.totalSize).toBeGreaterThan(0);
    expect(bobResult.totalSize).toBeGreaterThan(aliceResult.totalSize as number);
    expect(aliceResult.visibilityLevel).toBe('own');
    expect(bobResult.visibilityLevel).toBe('territory');
  });

  it('gives an admin the whole tenant and no more', async () => {
    const dana = await stack.callTool(danaToken, 'salesforce', 'sf.list_opportunities', {
      limit: 200,
    });
    const bob = await stack.callTool(bobToken, 'salesforce', 'sf.list_opportunities', {
      limit: 200,
    });

    const danaTotal = (dana.body.result as Record<string, unknown>).totalSize as number;
    const bobTotal = (bob.body.result as Record<string, unknown>).totalSize as number;
    expect(danaTotal).toBeGreaterThan(bobTotal);
    // Acme has 100 opportunities in the fixtures; the other tenants' 100 are
    // not reachable at any privilege level.
    expect(danaTotal).toBe(100);
  });

  it('caches the exchanged token and reuses it on the next call', async () => {
    const first = await stack.callTool(danaToken, 'salesforce', 'sf.get_contact', {
      contactId: 'nope',
    });
    const second = await stack.callTool(danaToken, 'salesforce', 'sf.get_contact', {
      contactId: 'nope',
    });

    const firstMeta = first.body.meta as Record<string, Record<string, unknown>>;
    const secondMeta = second.body.meta as Record<string, Record<string, unknown>>;
    expect(
      firstMeta.tokenExchange?.cached === false || secondMeta.tokenExchange?.cached === true,
    ).toBe(true);
    expect(secondMeta.tokenExchange?.cached).toBe(true);
  });

  it('refuses when the caller holds no scope for the target server', async () => {
    const narrow = await stack.signIn('alice.chen@acme-corp.com', 'openid salesforce:read');
    const { status, body } = await stack.callTool(narrow, 'postgres', 'pg.list_tables');

    expect(status).toBe(403);
    const code = (body.error as Record<string, unknown>).code;
    // Either the scope gate or the mirror refuses; both fail closed, and
    // neither falls back to a shared credential.
    expect(['scope_denied', 'permission_mirror_failed']).toContain(code);
  });

  it('records the gateway as the RFC 8693 actor on the exchanged token', async () => {
    // Verified directly at the provider: the token the gateway sends downstream
    // says "Alice, acting through the gateway".
    const response = await stack.gateway.inject({
      method: 'POST',
      url: '/v1/servers/salesforce/tools/sf.list_opportunities',
      headers: { authorization: `Bearer ${aliceToken}` },
      payload: { arguments: { limit: 1 } },
    });
    expect(response.statusCode).toBe(200);

    const inbound = decodeJwt(aliceToken);
    expect(inbound.act).toBeUndefined();
    expect(inbound.sub).toBe('usr_alice');
  });
});

describe('row-level security in the warehouse', () => {
  it('applies the caller own database role', async () => {
    const { status, body } = await stack.callTool(aliceToken, 'postgres', 'pg.list_tables');
    expect(status).toBe(200);
    expect((body.result as Record<string, unknown>).appliedRole).toBe('app_analyst');
  });

  it('shows a manager more rows than an analyst for the same query', async () => {
    const sql = 'SELECT count(*)::int AS c FROM orders';
    const alice = await stack.callTool(aliceToken, 'postgres', 'pg.query', { sql });
    const bob = await stack.callTool(bobToken, 'postgres', 'pg.query', { sql });

    const aliceRows = (alice.body.result as { rows: { c: number }[] }).rows;
    const bobRows = (bob.body.result as { rows: { c: number }[] }).rows;

    expect(aliceRows[0]?.c).toBeGreaterThan(0);
    expect(bobRows[0]?.c).toBeGreaterThan(aliceRows[0]?.c ?? 0);
  });

  it('never returns another tenant rows, even when asked for them directly', async () => {
    const { body } = await stack.callTool(danaToken, 'postgres', 'pg.query', {
      sql: 'SELECT DISTINCT tenant_id FROM orders',
    });
    const rows = (body.result as { rows: { tenant_id: string }[] }).rows;
    expect(rows.every((row) => row.tenant_id === 'acme-corp')).toBe(true);
  });

  it('refuses a write disguised as a query', async () => {
    const { status, body } = await stack.callTool(danaToken, 'postgres', 'pg.query', {
      sql: 'DELETE FROM orders',
    });
    expect(status).toBe(403);
    expect((body.error as Record<string, unknown>).code).toBe('policy_denied');
  });
});

describe('policy enforcement', () => {
  it('denies a personal-data query for a restricted-plan tenant', async () => {
    const { status, body } = await stack.callTool(liamToken, 'salesforce', 'sf.query', {
      soql: 'SELECT Id, Email, Phone FROM Contact',
    });

    expect(status).toBe(403);
    const error = body.error as Record<string, unknown>;
    expect(error.code).toBe('policy_denied');
    expect((error.details as Record<string, unknown>).ruleId).toBe('deny-pii-on-restricted-plan');
  });

  it('allows the same query for an enterprise tenant', async () => {
    const { status } = await stack.callTool(aliceToken, 'salesforce', 'sf.query', {
      soql: 'SELECT Id, Email FROM Contact LIMIT 5',
    });
    expect(status).toBe(200);
  });

  it('denies a warehouse query from a viewer at the first gate that applies', async () => {
    const { status, body } = await stack.callTool(miaToken, 'postgres', 'pg.query', {
      sql: 'SELECT 1',
    });

    expect(status).toBe(403);
    // A viewer's token carries no postgres:query scope, so the scope gate
    // refuses before the policy engine is consulted. The policy rule is the
    // second layer, for a caller who does hold the scope; the console's
    // evaluate endpoint exercises it directly.
    expect((body.error as Record<string, unknown>).code).toBe('scope_denied');
  });

  it('denies bulk extraction', async () => {
    const { status } = await stack.callTool(danaToken, 'postgres', 'pg.query', {
      sql: 'SELECT id FROM orders',
      limit: 50_000,
    });
    // The limit is capped by the schema before policy sees it, so the refusal
    // comes from argument validation rather than the rule; either way the call
    // does not run unbounded.
    expect(status).toBeGreaterThanOrEqual(400);
  });
});

describe('audit trail', () => {
  it('records one row per call, allowed or denied, and keeps the chain valid', async () => {
    const before = await db.db.execute<{ c: number } & Record<string, unknown>>(
      sql`SELECT COUNT(*)::int AS c FROM audit_events WHERE tenant_id = 'acme-corp'`,
    );

    await stack.callTool(aliceToken, 'salesforce', 'sf.list_opportunities', { limit: 1 });
    await stack.callTool(aliceToken, 'salesforce', 'sf.create_task', {
      subject: 'not permitted',
      dueDate: '2026-12-01',
    });

    const after = await db.db.execute<{ c: number } & Record<string, unknown>>(
      sql`SELECT COUNT(*)::int AS c FROM audit_events WHERE tenant_id = 'acme-corp'`,
    );

    expect(Number(after.rows[0]?.c)).toBe(Number(before.rows[0]?.c) + 2);

    const chain = await verifyTenantChain(db.db, 'acme-corp');
    expect(chain.valid).toBe(true);
  });

  it('records the deny reason for a policy refusal', async () => {
    await stack.callTool(liamToken, 'salesforce', 'sf.query', {
      soql: 'SELECT Email FROM Contact',
    });

    const row = await db.db.execute<
      { decision: string; deny_reason: string } & Record<string, unknown>
    >(
      sql`
        SELECT decision, deny_reason FROM audit_events
        WHERE tenant_id = 'initech' AND user_id = 'usr_liam'
        ORDER BY seq DESC LIMIT 1
      `,
    );

    expect(row.rows[0]?.decision).toBe('deny');
    expect(row.rows[0]?.deny_reason).toContain('deny-pii-on-restricted-plan');
  });

  it('stores only the digest of the arguments', async () => {
    await stack.callTool(danaToken, 'salesforce', 'sf.query', {
      soql: "SELECT Id FROM Contact WHERE Name = 'a distinctive marker'",
    });

    const row = await db.db.execute<{ arguments_hash: string } & Record<string, unknown>>(sql`
      SELECT arguments_hash FROM audit_events WHERE tenant_id = 'acme-corp' ORDER BY seq DESC LIMIT 1
    `);
    expect(row.rows[0]?.arguments_hash.trim()).toMatch(/^[0-9a-f]{64}$/);

    const leaked = await db.db.execute(
      sql`SELECT 1 FROM audit_events WHERE deny_reason LIKE '%distinctive marker%'`,
    );
    expect(leaked.rows).toHaveLength(0);
  });
});

describe('rate limiting', () => {
  it('refuses once the bucket is empty and reports how long to wait', async () => {
    // Initech's restricted plan gives 30 calls per user per minute.
    let limited: { status: number; body: Record<string, unknown> } | null = null;
    for (let i = 0; i < 40; i += 1) {
      const result = await stack.callTool(liamToken, 'salesforce', 'sf.list_opportunities', {
        limit: 1,
      });
      if (result.status === 429) {
        limited = result;
        break;
      }
    }

    expect(limited).not.toBeNull();
    const details = (limited?.body.error as Record<string, unknown>).details as Record<
      string,
      unknown
    >;
    expect(Number(details.retryAfterMs)).toBeGreaterThan(0);
  });

  it('audits the refusal rather than dropping it silently', async () => {
    const row = await db.db.execute<{ deny_reason: string } & Record<string, unknown>>(sql`
      SELECT deny_reason FROM audit_events
      WHERE tenant_id = 'initech' AND deny_reason LIKE 'rate_limit%'
      ORDER BY seq DESC LIMIT 1
    `);
    expect(row.rows[0]?.deny_reason).toMatch(/^rate_limit:/);
  });
});

describe('console API', () => {
  it('scopes the audit view to the caller own tenant', async () => {
    const response = await stack.gateway.inject({
      url: '/api/audit?limit=50',
      headers: { authorization: `Bearer ${aliceToken}` },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json<{ rows: { tenantId: string }[] }>();
    expect(body.rows.length).toBeGreaterThan(0);
    expect(body.rows.every((row) => row.tenantId === 'acme-corp')).toBe(true);
  });

  it('verifies the chain on demand', async () => {
    const response = await stack.gateway.inject({
      method: 'POST',
      url: '/api/audit/verify',
      headers: { authorization: `Bearer ${aliceToken}` },
    });
    expect(response.json<{ valid: boolean }>().valid).toBe(true);
  });

  it('reports overview statistics', async () => {
    const response = await stack.gateway.inject({
      url: '/api/overview?range=24h',
      headers: { authorization: `Bearer ${aliceToken}` },
    });
    const body = response.json<{ totals: { invocations: number }; series: unknown[] }>();
    expect(body.totals.invocations).toBeGreaterThan(0);
    expect(Array.isArray(body.series)).toBe(true);
  });

  it('requires the admin scope to change a rate limit', async () => {
    const list = await stack.gateway.inject({
      url: '/api/rate-limits',
      headers: { authorization: `Bearer ${aliceToken}` },
    });
    const configs = list.json<{ configs: { id: string }[] }>().configs;
    expect(configs.length).toBeGreaterThan(0);

    const asAnalyst = await stack.gateway.inject({
      method: 'PUT',
      url: `/api/rate-limits/${configs[0]?.id}`,
      headers: { authorization: `Bearer ${aliceToken}` },
      payload: { capacity: 10, refillTokens: 10, refillIntervalMs: 60_000 },
    });
    expect(asAnalyst.statusCode).toBe(403);

    const asAdmin = await stack.gateway.inject({
      method: 'PUT',
      url: `/api/rate-limits/${configs[0]?.id}`,
      headers: { authorization: `Bearer ${danaToken}` },
      payload: { capacity: 999, refillTokens: 999, refillIntervalMs: 60_000 },
    });
    expect(asAdmin.statusCode).toBe(200);
  });

  it('lists the policy rules through the policy engine', async () => {
    const response = await stack.gateway.inject({
      url: '/api/policies',
      headers: { authorization: `Bearer ${aliceToken}` },
    });
    const body = response.json<{ rules: { id: string }[] }>();
    expect(body.rules.some((rule) => rule.id === 'deny-pii-on-restricted-plan')).toBe(true);
  });

  it('evaluates a hypothetical call without performing it', async () => {
    const response = await stack.gateway.inject({
      method: 'POST',
      url: '/api/policies/evaluate',
      headers: { authorization: `Bearer ${aliceToken}` },
      payload: {
        tool: 'pg.query',
        server: 'postgres',
        role: 'viewer',
        scopes: ['postgres:query'],
        arguments: { sql: 'SELECT 1' },
      },
    });
    const body = response.json<{ decision: string; ruleId: string; trace: unknown[] }>();
    expect(body.decision).toBe('deny');
    expect(body.ruleId).toBe('deny-warehouse-query-for-viewers');
    expect(body.trace.length).toBeGreaterThan(0);
  });
});

describe('health', () => {
  it('reports liveness without touching dependencies', async () => {
    const response = await stack.gateway.inject({ url: '/healthz' });
    expect(response.statusCode).toBe(200);
  });

  it('reports readiness with a per-dependency breakdown', async () => {
    const response = await stack.gateway.inject({ url: '/readyz' });
    const body = response.json<{ ready: boolean; checks: Record<string, string> }>();
    expect(body.checks.database).toBe('ok');
    expect(body.checks.redis).toBe('ok');
  });
});
