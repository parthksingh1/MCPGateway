import { AuditWriter, verifyAllChains, verifyTenantChain, queryAuditEvents } from '@mcpgateway/audit';
import { createDatabase, type DbHandle } from '@mcpgateway/shared/db';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { runMigrations } from '../../scripts/migrate.js';

import { startPostgres } from './helpers/services.js';

let handle: DbHandle;
let auditHandle: DbHandle;
let stopPostgres: () => Promise<void>;
let writer: AuditWriter;

/** Same server, but connected as the INSERT-only audit role. */
function asAuditRole(url: string): string {
  const parsed = new URL(url);
  parsed.username = 'mcpgw_audit';
  parsed.password = 'mcpgw_audit';
  return parsed.toString();
}

beforeAll(async () => {
  const postgres = await startPostgres();
  stopPostgres = postgres.stop;
  await runMigrations({ controlUrl: postgres.url, warehouseUrl: postgres.url });

  handle = createDatabase(postgres.url);
  auditHandle = createDatabase(asAuditRole(postgres.url));
  writer = new AuditWriter(auditHandle.db);

  await handle.db.execute(sql`
    INSERT INTO tenants (id, name, plan) VALUES
      ('acme-corp', 'Acme Corp', 'enterprise'),
      ('globex', 'Globex', 'pro')
    ON CONFLICT (id) DO NOTHING
  `);
}, 240_000);

afterAll(async () => {
  await handle?.close();
  await auditHandle?.close();
  await stopPostgres?.();
});

async function append(tenantId: string, overrides: Record<string, unknown> = {}) {
  return writer.append({
    tenantId,
    userId: 'usr_alice',
    actorTokenJti: 'tok_1',
    mcpServer: 'salesforce',
    toolName: 'sf.query',
    arguments: { soql: 'SELECT Id FROM Contact' },
    decision: 'allow',
    latencyMs: 12,
    traceId: 'a'.repeat(32),
    ...overrides,
  });
}

describe('audit chain against real Postgres', () => {
  it('links each row to the one before it', async () => {
    const first = await append('acme-corp');
    const second = await append('acme-corp');

    expect(second.prevHash).toBe(first.rowHash);
    expect(second.seq).toBeGreaterThan(first.seq);
  });

  it('stores only the digest of the arguments by default', async () => {
    const appended = await append('acme-corp', { arguments: { ssn: '123-45-6789' } });

    const stored = await handle.db.execute<{ arguments_hash: string }>(sql`
      SELECT arguments_hash FROM audit_events WHERE id = ${appended.id}
    `);
    expect(stored.rows[0]?.arguments_hash.trim()).toMatch(/^[0-9a-f]{64}$/);

    const payloads = await handle.db.execute(sql`
      SELECT 1 FROM audit_payloads WHERE event_id = ${appended.id}
    `);
    expect(payloads.rows).toHaveLength(0);
  });

  it('captures the payload only when a tenant opts in', async () => {
    const appended = await append('acme-corp', {
      arguments: { note: 'retained deliberately' },
      capturePayload: true,
    });

    const payloads = await handle.db.execute<{ payload: Record<string, unknown> }>(sql`
      SELECT payload FROM audit_payloads WHERE event_id = ${appended.id}
    `);
    expect(payloads.rows[0]?.payload).toEqual({ note: 'retained deliberately' });
  });

  it('keeps a well-formed chain under 200 concurrent appends', async () => {
    const tenantId = 'globex';
    await Promise.all(Array.from({ length: 200 }, () => append(tenantId)));

    const result = await verifyTenantChain(handle.db, tenantId);
    expect(result.valid).toBe(true);
    expect(result.rowsChecked).toBe(200);
    expect(result.firstBreak).toBeNull();
    expect(result.headHash).toBe(result.recordedHeadHash);
  });

  it('verifies every tenant chain', async () => {
    const results = await verifyAllChains(handle.db);
    expect(results.length).toBeGreaterThanOrEqual(2);
    expect(results.every((r) => r.valid)).toBe(true);
  });

  it('detects a tampered row and names it', async () => {
    const tenantId = 'tamper-test';
    await handle.db.execute(sql`
      INSERT INTO tenants (id, name, plan) VALUES (${tenantId}, 'Tamper Test', 'pro')
      ON CONFLICT (id) DO NOTHING
    `);
    for (let i = 0; i < 10; i += 1) await append(tenantId, { latencyMs: i });

    const target = await handle.db.execute<{ id: string; seq: number }>(sql`
      SELECT id, seq FROM audit_events WHERE tenant_id = ${tenantId} ORDER BY seq ASC OFFSET 4 LIMIT 1
    `);
    const victim = target.rows[0];
    expect(victim).toBeDefined();

    // Editing requires disabling the guard trigger, which itself needs table
    // ownership. That is the point: tampering is not something the application
    // can do at all.
    await handle.db.execute(sql`ALTER TABLE audit_events DISABLE TRIGGER audit_events_no_update`);
    await handle.db.execute(sql`
      UPDATE audit_events SET decision = 'deny', deny_reason = 'quietly rewritten', latency_ms = 9999
      WHERE id = ${victim?.id}
    `);
    await handle.db.execute(sql`ALTER TABLE audit_events ENABLE TRIGGER audit_events_no_update`);

    const result = await verifyTenantChain(handle.db, tenantId);
    expect(result.valid).toBe(false);
    expect(result.firstBreak?.id).toBe(victim?.id);
    expect(result.firstBreak?.reason).toBe('row_hash_mismatch');
    expect(result.rowsChecked).toBe(4);
  });

  it('detects rows deleted from the tail', async () => {
    const tenantId = 'truncate-test';
    await handle.db.execute(sql`
      INSERT INTO tenants (id, name, plan) VALUES (${tenantId}, 'Truncate Test', 'pro')
      ON CONFLICT (id) DO NOTHING
    `);
    for (let i = 0; i < 6; i += 1) await append(tenantId);

    expect((await verifyTenantChain(handle.db, tenantId)).valid).toBe(true);

    await handle.db.execute(sql`ALTER TABLE audit_events DISABLE TRIGGER audit_events_no_update`);
    await handle.db.execute(sql`
      DELETE FROM audit_events
      WHERE id IN (
        SELECT id FROM audit_events WHERE tenant_id = ${tenantId} ORDER BY seq DESC LIMIT 2
      )
    `);
    await handle.db.execute(sql`ALTER TABLE audit_events ENABLE TRIGGER audit_events_no_update`);

    // The surviving prefix is internally consistent, so per-row hashes alone
    // cannot see this. Comparing the walk against the recorded head can.
    const result = await verifyTenantChain(handle.db, tenantId);
    expect(result.valid).toBe(false);
    expect(result.headHash).not.toBe(result.recordedHeadHash);
  });
});

describe('append-only enforcement', () => {
  it('refuses an UPDATE from the audit role', async () => {
    await expect(
      auditHandle.db.execute(sql`UPDATE audit_events SET latency_ms = 0 WHERE tenant_id = 'acme-corp'`),
    ).rejects.toThrow(/permission denied|append-only/i);
  });

  it('refuses a DELETE from the audit role', async () => {
    await expect(
      auditHandle.db.execute(sql`DELETE FROM audit_events WHERE tenant_id = 'acme-corp'`),
    ).rejects.toThrow(/permission denied|append-only/i);
  });

  it('refuses a TRUNCATE from the audit role', async () => {
    await expect(auditHandle.db.execute(sql`TRUNCATE audit_events`)).rejects.toThrow(
      /permission denied|must be owner/i,
    );
  });

  it('refuses an UPDATE even from the table owner, via the guard trigger', async () => {
    const existing = await append('acme-corp');
    // The application role owns the table and therefore bypasses grants
    // entirely. The trigger is the layer that stops an owner-level mistake.
    await expect(
      handle.db.execute(sql`UPDATE audit_events SET latency_ms = 0 WHERE id = ${existing.id}`),
    ).rejects.toThrow(/append-only/i);
  });

  it('refuses a DELETE from the table owner too', async () => {
    const existing = await append('acme-corp');
    await expect(
      handle.db.execute(sql`DELETE FROM audit_events WHERE id = ${existing.id}`),
    ).rejects.toThrow(/append-only/i);
  });

  it('still allows the audit role to insert', async () => {
    await expect(append('acme-corp')).resolves.toMatchObject({ seq: expect.any(Number) });
  });
});

describe('audit read path', () => {
  it('filters by tenant and decision', async () => {
    await append('acme-corp', { decision: 'deny', denyReason: 'policy.pii_guard' });

    const denied = await queryAuditEvents(handle.db, {
      tenantId: 'acme-corp',
      decision: 'deny',
      limit: 10,
    });
    expect(denied.rows.length).toBeGreaterThan(0);
    expect(denied.rows.every((row) => row.decision === 'deny')).toBe(true);
    expect(denied.rows.every((row) => row.tenantId === 'acme-corp')).toBe(true);
  });

  it('paginates with a stable total', async () => {
    const first = await queryAuditEvents(handle.db, { limit: 5, offset: 0 });
    const second = await queryAuditEvents(handle.db, { limit: 5, offset: 5 });

    expect(first.rows).toHaveLength(5);
    expect(first.total).toBe(second.total);
    expect(first.rows[0]?.id).not.toBe(second.rows[0]?.id);
  });

  it('searches across user, tool and deny reason', async () => {
    const result = await queryAuditEvents(handle.db, { search: 'pii_guard', limit: 10 });
    expect(result.rows.length).toBeGreaterThan(0);
  });
});
