import type { DownstreamPrincipal } from '@mcpgateway/mcp-runtime';
import { beforeAll, describe, expect, it } from 'vitest';

import {
  describeVisibility,
  isVisible,
  loadDataset,
  visibilityFor,
  visibleRecords,
  type Dataset,
} from './dataset.js';

let dataset: Dataset;

beforeAll(async () => {
  dataset = await loadDataset();
});

function principal(overrides: Partial<DownstreamPrincipal> = {}): DownstreamPrincipal {
  return {
    subject: 'usr_alice',
    tenantId: 'acme-corp',
    role: 'analyst',
    scopes: ['salesforce:read'],
    tokenId: 'tok_1',
    email: 'alice.chen@acme-corp.com',
    name: 'Alice Chen',
    territory: 'West',
    actor: 'mcp-gateway',
    ...overrides,
  };
}

/** The two people the walkthrough compares. */
const ALICE = principal();
const BOB = principal({
  subject: 'usr_bob',
  role: 'manager',
  scopes: ['salesforce:read', 'salesforce:read.team'],
  territory: 'West',
  name: 'Bob Martinez',
});
const DANA = principal({
  subject: 'usr_dana',
  role: 'admin',
  scopes: ['salesforce:read', 'salesforce:read.team', 'salesforce:read.all'],
  territory: null,
  name: 'Dana Olsen',
});

describe('fixtures', () => {
  it('loads the documented record counts', () => {
    expect(dataset.accounts).toHaveLength(100);
    expect(dataset.contacts).toHaveLength(500);
    expect(dataset.opportunities).toHaveLength(200);
  });

  it('spreads records across three tenants', () => {
    const tenants = new Set(dataset.opportunities.map((record) => record.TenantId));
    expect([...tenants].sort()).toEqual(['acme-corp', 'globex', 'initech']);
  });

  it('assigns every record an owner drawn from the seeded users', () => {
    const owners = new Set(dataset.opportunities.map((record) => record.OwnerId));
    expect(owners.size).toBeGreaterThanOrEqual(9);
    for (const owner of owners) expect(owner).toMatch(/^usr_/);
  });
});

describe('visibility level', () => {
  it('derives from scopes, not from role', () => {
    expect(visibilityFor(ALICE)).toBe('own');
    expect(visibilityFor(BOB)).toBe('territory');
    expect(visibilityFor(DANA)).toBe('tenant');

    // A manager whose token was never granted the team scope sees only their own.
    expect(visibilityFor(principal({ role: 'manager', scopes: ['salesforce:read'] }))).toBe('own');
  });

  it('describes itself in terms an operator can read', () => {
    expect(describeVisibility(ALICE)).toMatch(/owned by the caller/i);
    expect(describeVisibility(BOB)).toMatch(/West territory/);
    expect(describeVisibility(DANA)).toMatch(/All records/);
  });
});

describe('permission mirroring produces different result sets', () => {
  it('gives a manager strictly more than their analyst, and never less', () => {
    const forAlice = visibleRecords(dataset, 'Opportunity', ALICE);
    const forBob = visibleRecords(dataset, 'Opportunity', BOB);

    expect(forAlice.length).toBeGreaterThan(0);
    expect(forBob.length).toBeGreaterThan(forAlice.length);

    const bobIds = new Set(forBob.map((record) => record.Id));
    expect(forAlice.every((record) => bobIds.has(record.Id))).toBe(true);
  });

  it('gives an admin the whole tenant', () => {
    const forDana = visibleRecords(dataset, 'Opportunity', DANA);
    const tenantTotal = dataset.opportunities.filter(
      (record) => record.TenantId === 'acme-corp',
    ).length;

    expect(forDana).toHaveLength(tenantTotal);
  });

  it('shows an analyst only the records they own', () => {
    const forAlice = visibleRecords(dataset, 'Opportunity', ALICE);
    expect(forAlice.every((record) => record.OwnerId === 'usr_alice')).toBe(true);
  });

  it('shows a manager their whole territory but no other territory', () => {
    const forBob = visibleRecords(dataset, 'Opportunity', BOB);
    expect(forBob.every((record) => record.Territory === 'West')).toBe(true);
    expect(forBob.some((record) => record.OwnerId === 'usr_alice')).toBe(true);
    expect(forBob.some((record) => record.OwnerId === 'usr_priya')).toBe(false);
  });
});

describe('tenant isolation', () => {
  it('is absolute, even for an admin', () => {
    const forDana = visibleRecords(dataset, 'Contact', DANA);
    expect(forDana.every((record) => record.TenantId === 'acme-corp')).toBe(true);
    expect(forDana.length).toBeLessThan(dataset.contacts.length);
  });

  it('hides a record whose tenant does not match, whatever the scopes', () => {
    const foreign = dataset.contacts.find((record) => record.TenantId === 'globex');
    expect(foreign).toBeDefined();
    expect(isVisible(foreign as never, DANA)).toBe(false);
  });

  it('is checked before the visibility level', () => {
    // Same owner id, wrong tenant: still invisible.
    const impostor = { Id: 'x', TenantId: 'globex', OwnerId: 'usr_alice', Territory: 'West' };
    expect(isVisible(impostor, ALICE)).toBe(false);
  });
});

describe('failure modes', () => {
  it('falls back to own-records when a team-scoped token carries no territory', () => {
    const managerWithoutTerritory = principal({
      subject: 'usr_bob',
      scopes: ['salesforce:read', 'salesforce:read.team'],
      territory: null,
    });
    const records = visibleRecords(dataset, 'Opportunity', managerWithoutTerritory);
    // Failing closed: a missing claim must never widen reach.
    expect(records).toHaveLength(0);
  });

  it('shows nothing to a principal whose subject owns no records', () => {
    const stranger = principal({ subject: 'usr_nobody' });
    expect(visibleRecords(dataset, 'Opportunity', stranger)).toHaveLength(0);
  });

  it('applies the same rules to contacts and accounts as to opportunities', () => {
    for (const object of ['Account', 'Contact'] as const) {
      const forAlice = visibleRecords(dataset, object, ALICE);
      const forBob = visibleRecords(dataset, object, BOB);
      expect(forBob.length).toBeGreaterThan(forAlice.length);
    }
  });
});
