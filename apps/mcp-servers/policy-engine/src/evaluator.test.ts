import { beforeAll, describe, expect, it } from 'vitest';

import { evaluate, evaluateCondition, readPath } from './evaluator.js';
import { loadPolicies } from './loader.js';
import { bundleSchema, evaluationInputSchema, type Bundle, type EvaluationInput } from './schema.js';

let baseline: Bundle;

beforeAll(async () => {
  baseline = (await loadPolicies()).get('baseline');
});

function request(overrides: Partial<EvaluationInput> = {}): EvaluationInput {
  return evaluationInputSchema.parse({
    tool: 'sf.query',
    server: 'salesforce',
    principal: {
      subject: 'usr_alice',
      tenantId: 'acme-corp',
      role: 'analyst',
      scopes: ['salesforce:read', 'postgres:read', 'postgres:query'],
      territory: 'West',
    },
    tenant: { id: 'acme-corp', plan: 'enterprise' },
    arguments: {},
    ...overrides,
  });
}

describe('readPath', () => {
  it('reads nested values', () => {
    expect(readPath(request(), 'principal.role')).toBe('analyst');
    expect(readPath(request(), 'tenant.plan')).toBe('enterprise');
  });

  it('returns undefined for a missing path rather than throwing', () => {
    expect(readPath(request(), 'arguments.nothing.here')).toBeUndefined();
    expect(readPath(request(), 'no.such.path')).toBeUndefined();
  });

  it('does not walk into a primitive', () => {
    expect(readPath(request(), 'tool.length')).toBeUndefined();
  });
});

describe('operators', () => {
  const input = request({ arguments: { limit: 10, fields: ['Name', 'Email'], sql: 'SELECT 1' } });

  const cases: [string, unknown, boolean][] = [
    ['eq', { path: 'principal.role', op: 'eq', value: 'analyst' }, true],
    ['eq (miss)', { path: 'principal.role', op: 'eq', value: 'admin' }, false],
    ['ne', { path: 'principal.role', op: 'ne', value: 'admin' }, true],
    ['in', { path: 'tool', op: 'in', value: ['sf.query', 'pg.query'] }, true],
    ['not_in', { path: 'tool', op: 'not_in', value: ['pg.query'] }, true],
    ['matches', { path: 'arguments.sql', op: 'matches', value: '(?i)select' }, true],
    ['not_matches', { path: 'arguments.sql', op: 'not_matches', value: 'DELETE' }, true],
    ['gt', { path: 'arguments.limit', op: 'gt', value: 5 }, true],
    ['gte', { path: 'arguments.limit', op: 'gte', value: 10 }, true],
    ['lt', { path: 'arguments.limit', op: 'lt', value: 20 }, true],
    ['lte', { path: 'arguments.limit', op: 'lte', value: 10 }, true],
    ['exists', { path: 'arguments.limit', op: 'exists' }, true],
    ['missing', { path: 'arguments.absent', op: 'missing' }, true],
    ['contains', { path: 'principal.scopes', op: 'contains', value: 'salesforce:read' }, true],
    ['not_contains', { path: 'principal.scopes', op: 'not_contains', value: 'salesforce:write' }, true],
    ['contains_any', { path: 'arguments.fields', op: 'contains_any', value: ['email'] }, true],
    ['starts_with', { path: 'tool', op: 'starts_with', value: 'sf.' }, true],
    ['eq_field', { path: 'principal.tenantId', op: 'eq_field', value: 'tenant.id' }, true],
    ['ne_field', { path: 'principal.tenantId', op: 'ne_field', value: 'tenant.id' }, false],
  ];

  for (const [name, condition, expected] of cases) {
    it(`${name} evaluates to ${String(expected)}`, () => {
      expect(evaluateCondition(condition as never, input)).toBe(expected);
    });
  }

  it('treats a gt against a non-numeric value as no match rather than an error', () => {
    expect(
      evaluateCondition({ path: 'tool', op: 'gt', value: 5 } as never, input),
    ).toBe(false);
  });

  it('treats a malformed regular expression as no match', () => {
    expect(
      evaluateCondition({ path: 'arguments.sql', op: 'matches', value: '([' } as never, input),
    ).toBe(false);
  });

  it('matches a pattern against a joined array', () => {
    expect(
      evaluateCondition(
        { path: 'arguments.fields', op: 'matches', value: '(?i)email' } as never,
        input,
      ),
    ).toBe(true);
  });

  it('is case-insensitive for contains_any', () => {
    expect(
      evaluateCondition(
        { path: 'arguments.fields', op: 'contains_any', value: ['EMAIL'] } as never,
        input,
      ),
    ).toBe(true);
  });
});

describe('combinators', () => {
  const input = request();

  it('all requires every child', () => {
    expect(
      evaluateCondition(
        { all: [{ path: 'tool', op: 'eq', value: 'sf.query' }, { path: 'principal.role', op: 'eq', value: 'analyst' }] } as never,
        input,
      ),
    ).toBe(true);
    expect(
      evaluateCondition(
        { all: [{ path: 'tool', op: 'eq', value: 'sf.query' }, { path: 'principal.role', op: 'eq', value: 'admin' }] } as never,
        input,
      ),
    ).toBe(false);
  });

  it('any requires one child', () => {
    expect(
      evaluateCondition(
        { any: [{ path: 'principal.role', op: 'eq', value: 'admin' }, { path: 'tool', op: 'eq', value: 'sf.query' }] } as never,
        input,
      ),
    ).toBe(true);
  });

  it('not inverts', () => {
    expect(
      evaluateCondition({ not: { path: 'tool', op: 'eq', value: 'sf.query' } } as never, input),
    ).toBe(false);
  });

  it('a condition with neither path nor combinator never matches', () => {
    expect(evaluateCondition({} as never, input)).toBe(false);
  });
});

describe('baseline bundle', () => {
  it('defaults to deny', () => {
    expect(baseline.defaultEffect).toBe('deny');
  });

  it('allows an ordinary analyst query', () => {
    const result = evaluate(baseline, request());
    expect(result.decision).toBe('allow');
    expect(result.ruleId).toBe('allow-known-tools');
  });

  it('denies a tool the catalogue does not list', () => {
    const result = evaluate(baseline, request({ tool: 'sf.delete_everything' }));
    expect(result.decision).toBe('deny');
    expect(result.ruleId).toBe('baseline.default');
  });

  it('denies a mutating warehouse statement', () => {
    const result = evaluate(
      baseline,
      request({ tool: 'pg.query', server: 'postgres', arguments: { sql: 'DELETE FROM orders' } }),
    );
    expect(result.decision).toBe('deny');
    expect(result.ruleId).toBe('deny-destructive-sql');
  });

  it('allows a read-only warehouse statement', () => {
    const result = evaluate(
      baseline,
      request({
        tool: 'pg.query',
        server: 'postgres',
        arguments: { sql: 'SELECT count(*) FROM orders' },
      }),
    );
    expect(result.decision).toBe('allow');
  });

  it('denies a personal-data query for a restricted-plan tenant', () => {
    const result = evaluate(
      baseline,
      request({
        principal: { ...request().principal, tenantId: 'initech' },
        tenant: { id: 'initech', plan: 'restricted' },
        arguments: { soql: 'SELECT Id, Email, Phone FROM Contact' },
      }),
    );
    expect(result.decision).toBe('deny');
    expect(result.ruleId).toBe('deny-pii-on-restricted-plan');
    expect(result.reason).toMatch(/restricted plan/i);
  });

  it('allows the same query for an enterprise tenant', () => {
    const result = evaluate(
      baseline,
      request({ arguments: { soql: 'SELECT Id, Email, Phone FROM Contact' } }),
    );
    expect(result.decision).toBe('allow');
  });

  it('denies arguments naming another tenant', () => {
    const result = evaluate(baseline, request({ arguments: { tenantId: 'globex' } }));
    expect(result.decision).toBe('deny');
    expect(result.ruleId).toBe('deny-cross-tenant-access');
  });

  it('permits arguments naming the caller own tenant', () => {
    const result = evaluate(baseline, request({ arguments: { tenantId: 'acme-corp' } }));
    expect(result.decision).toBe('allow');
  });

  it('denies a write tool when the token carries no write scope', () => {
    const result = evaluate(baseline, request({ tool: 'sf.create_task' }));
    expect(result.decision).toBe('deny');
    expect(result.ruleId).toBe('deny-write-without-scope');
  });

  it('allows the write tool once the scope is present', () => {
    const result = evaluate(
      baseline,
      request({
        tool: 'sf.create_task',
        principal: { ...request().principal, scopes: ['salesforce:read', 'salesforce:write'] },
      }),
    );
    expect(result.decision).toBe('allow');
  });

  it('denies bulk extraction', () => {
    const result = evaluate(
      baseline,
      request({ tool: 'pg.query', arguments: { sql: 'SELECT 1', limit: 50_000 } }),
    );
    expect(result.decision).toBe('deny');
    expect(result.ruleId).toBe('deny-bulk-extraction');
  });

  it('denies warehouse queries for viewers but not schema inspection', () => {
    const viewer = { ...request().principal, role: 'viewer' };
    expect(
      evaluate(baseline, request({ tool: 'pg.query', principal: viewer, arguments: { sql: 'SELECT 1' } }))
        .decision,
    ).toBe('deny');
    expect(evaluate(baseline, request({ tool: 'pg.list_tables', principal: viewer })).decision).toBe(
      'allow',
    );
  });

  it('attaches a burst tier for enterprise tenants without deciding the request', () => {
    const result = evaluate(baseline, request());
    expect(result.rateTier).toBe('burst');
    expect(result.ruleId).toBe('allow-known-tools');
  });

  it('attaches a throttled tier for restricted tenants', () => {
    const result = evaluate(
      baseline,
      request({
        principal: { ...request().principal, tenantId: 'initech' },
        tenant: { id: 'initech', plan: 'restricted' },
        arguments: { soql: 'SELECT Id FROM Account' },
      }),
    );
    expect(result.decision).toBe('allow');
    expect(result.rateTier).toBe('throttled');
  });

  it('records a trace of every rule considered', () => {
    const result = evaluate(baseline, request());
    expect(result.trace.length).toBeGreaterThan(1);
    expect(result.trace.at(-1)?.ruleId).toBe('allow-known-tools');
    expect(result.trace.every((entry) => typeof entry.matched === 'boolean')).toBe(true);
  });

  it('stops at the first deciding rule', () => {
    const result = evaluate(
      baseline,
      request({ tool: 'pg.query', arguments: { sql: 'DROP TABLE orders' } }),
    );
    // deny-destructive-sql is the lowest priority number, so nothing after it runs.
    expect(result.trace).toHaveLength(1);
  });
});

describe('rule ordering', () => {
  it('evaluates by ascending priority regardless of file order', () => {
    const bundle = bundleSchema.parse({
      version: 1,
      name: 'ordering',
      rules: [
        {
          id: 'late-allow',
          priority: 100,
          effect: 'allow',
          match: { path: 'tool', op: 'eq', value: 'sf.query' },
        },
        {
          id: 'early-deny',
          priority: 1,
          effect: 'deny',
          reason: 'first',
          match: { path: 'tool', op: 'eq', value: 'sf.query' },
        },
      ],
    });

    expect(evaluate(bundle, request()).ruleId).toBe('early-deny');
  });

  it('breaks ties deterministically on rule id', () => {
    const bundle = bundleSchema.parse({
      version: 1,
      name: 'ties',
      rules: [
        { id: 'b-rule', priority: 10, effect: 'allow', match: { path: 'tool', op: 'exists' } },
        { id: 'a-rule', priority: 10, effect: 'deny', match: { path: 'tool', op: 'exists' } },
      ],
    });

    expect(evaluate(bundle, request()).ruleId).toBe('a-rule');
  });
});
