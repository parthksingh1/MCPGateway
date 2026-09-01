import { describe, expect, it } from 'vitest';

import {
  canonicalRow,
  computeRowHash,
  genesisHash,
  verifyChain,
  verifyLink,
  type AuditRowInput,
  type ChainLink,
} from './hash.js';

const BASE: AuditRowInput = {
  id: '11111111-1111-4111-8111-111111111111',
  ts: new Date('2026-03-01T12:00:00.000Z'),
  tenantId: 'acme-corp',
  userId: 'usr_alice',
  actorTokenJti: 'tok_1',
  mcpServer: 'salesforce',
  toolName: 'sf.query',
  argumentsHash: 'a'.repeat(64),
  decision: 'allow',
  denyReason: null,
  latencyMs: 42,
  traceId: 'b'.repeat(32),
};

/** Build a valid chain of `count` rows for a tenant. */
function buildChain(tenantId: string, count: number): ChainLink[] {
  const links: ChainLink[] = [];
  let prevHash = genesisHash(tenantId);
  for (let i = 0; i < count; i += 1) {
    const row: AuditRowInput = {
      ...BASE,
      tenantId,
      id: `${i}`.padStart(8, '0') + '-1111-4111-8111-111111111111',
      ts: new Date(BASE.ts.getTime() + i * 1000),
      latencyMs: 10 + i,
    };
    const rowHash = computeRowHash(prevHash, row);
    links.push({ ...row, prevHash, rowHash, seq: i + 1 });
    prevHash = rowHash;
  }
  return links;
}

describe('genesisHash', () => {
  it('is deterministic per tenant', () => {
    expect(genesisHash('acme-corp')).toBe(genesisHash('acme-corp'));
    expect(genesisHash('acme-corp')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('differs per tenant, so a row cannot be spliced between chains', () => {
    expect(genesisHash('acme-corp')).not.toBe(genesisHash('globex'));
  });
});

describe('canonicalRow', () => {
  it('is stable regardless of the field order of the input object', () => {
    const reordered: AuditRowInput = {
      traceId: BASE.traceId,
      latencyMs: BASE.latencyMs,
      decision: BASE.decision,
      denyReason: BASE.denyReason,
      argumentsHash: BASE.argumentsHash,
      toolName: BASE.toolName,
      mcpServer: BASE.mcpServer,
      actorTokenJti: BASE.actorTokenJti,
      userId: BASE.userId,
      tenantId: BASE.tenantId,
      ts: BASE.ts,
      id: BASE.id,
    };
    expect(canonicalRow(reordered)).toBe(canonicalRow(BASE));
  });

  it('covers every field that matters', () => {
    const encoded = canonicalRow(BASE);
    for (const key of [
      'id',
      'ts',
      'tenant_id',
      'user_id',
      'actor_token_jti',
      'mcp_server',
      'tool_name',
      'arguments_hash',
      'decision',
      'deny_reason',
      'latency_ms',
      'trace_id',
    ]) {
      expect(encoded).toContain(`"${key}"`);
    }
  });
});

describe('computeRowHash', () => {
  it('changes when any covered field changes', () => {
    const prev = genesisHash('acme-corp');
    const baseline = computeRowHash(prev, BASE);

    const mutations: Partial<AuditRowInput>[] = [
      { decision: 'deny' },
      { denyReason: 'policy.pii_guard' },
      { latencyMs: 43 },
      { toolName: 'sf.get_contact' },
      { userId: 'usr_bob' },
      { tenantId: 'globex' },
      { argumentsHash: 'c'.repeat(64) },
      { traceId: 'd'.repeat(32) },
      { ts: new Date('2026-03-01T12:00:00.001Z') },
      { mcpServer: 'postgres' },
      { actorTokenJti: 'tok_2' },
      { id: '22222222-2222-4222-8222-222222222222' },
    ];

    for (const mutation of mutations) {
      expect(computeRowHash(prev, { ...BASE, ...mutation })).not.toBe(baseline);
    }
  });

  it('changes when the predecessor changes, even for an identical row', () => {
    expect(computeRowHash(genesisHash('acme-corp'), BASE)).not.toBe(
      computeRowHash(genesisHash('globex'), BASE),
    );
  });
});

describe('verifyLink', () => {
  it('accepts a correctly linked row', () => {
    const [link] = buildChain('acme-corp', 1);
    expect(verifyLink(link as ChainLink, genesisHash('acme-corp'))).toBeNull();
  });

  it('reports a prev_hash that does not match its predecessor', () => {
    const [link] = buildChain('acme-corp', 1);
    const failure = verifyLink(link as ChainLink, 'f'.repeat(64));
    expect(failure?.reason).toBe('prev_hash_mismatch');
  });

  it('reports a row whose stored hash does not match its contents', () => {
    const [link] = buildChain('acme-corp', 1);
    const tampered: ChainLink = { ...(link as ChainLink), latencyMs: 9_999 };
    const failure = verifyLink(tampered, genesisHash('acme-corp'));
    expect(failure?.reason).toBe('row_hash_mismatch');
  });
});

describe('verifyChain', () => {
  it('accepts an untouched chain', () => {
    const result = verifyChain('acme-corp', buildChain('acme-corp', 50));
    expect(result.valid).toBe(true);
    expect(result.checked).toBe(50);
    expect(result.break).toBeNull();
  });

  it('accepts an empty chain', () => {
    expect(verifyChain('acme-corp', [])).toMatchObject({ valid: true, checked: 0 });
  });

  it('names the exact row that was altered', () => {
    const chain = buildChain('acme-corp', 20);
    const victim = chain[7];
    if (!victim) throw new Error('fixture');
    chain[7] = { ...victim, decision: 'allow', denyReason: 'quietly removed' };

    const result = verifyChain('acme-corp', chain);
    expect(result.valid).toBe(false);
    expect(result.break?.seq).toBe(8);
    expect(result.break?.reason).toBe('row_hash_mismatch');
    expect(result.checked).toBe(7);
  });

  it('detects a row deleted from the middle', () => {
    const chain = buildChain('acme-corp', 10);
    chain.splice(4, 1);

    const result = verifyChain('acme-corp', chain);
    expect(result.valid).toBe(false);
    expect(result.break?.reason).toBe('prev_hash_mismatch');
  });

  it('detects rows reordered', () => {
    const chain = buildChain('acme-corp', 10);
    const a = chain[3];
    const b = chain[6];
    if (!a || !b) throw new Error('fixture');
    chain[3] = b;
    chain[6] = a;

    expect(verifyChain('acme-corp', chain).valid).toBe(false);
  });

  it('detects a row inserted from another tenant chain', () => {
    const chain = buildChain('acme-corp', 5);
    const foreign = buildChain('globex', 5)[2];
    if (!foreign) throw new Error('fixture');
    chain.splice(2, 0, foreign);

    expect(verifyChain('acme-corp', chain).valid).toBe(false);
  });

  it('rejects a chain that does not start at genesis', () => {
    const chain = buildChain('acme-corp', 5).slice(1);
    const result = verifyChain('acme-corp', chain);
    expect(result.valid).toBe(false);
    expect(result.break?.reason).toBe('prev_hash_mismatch');
  });

  it('rejects an attempt to rewrite a row and its own hash without the tail', () => {
    const chain = buildChain('acme-corp', 10);
    const victim = chain[4];
    if (!victim) throw new Error('fixture');
    const rewritten = { ...victim, decision: 'allow' as const, latencyMs: 1 };
    // A determined editor recomputes the row hash so the row is self-consistent.
    chain[4] = { ...rewritten, rowHash: computeRowHash(victim.prevHash, rewritten) };

    const result = verifyChain('acme-corp', chain);
    // The row now verifies against itself, but row 6 still points at the old hash.
    expect(result.valid).toBe(false);
    expect(result.break?.seq).toBe(6);
    expect(result.break?.reason).toBe('prev_hash_mismatch');
  });
});
