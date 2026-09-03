import { BadRequestError } from '@mcpgateway/shared';
import { describe, expect, it } from 'vitest';

import type { CrmRecord } from './dataset.js';
import { executeQuery, parseSoql } from './soql.js';

const RECORDS: CrmRecord[] = [
  {
    Id: '006000000000001',
    TenantId: 'acme-corp',
    OwnerId: 'usr_alice',
    Territory: 'West',
    Name: 'Cobalt Systems — Renewal',
    StageName: 'Proposal',
    Amount: 250_000,
    CloseDate: '2026-03-15',
  },
  {
    Id: '006000000000002',
    TenantId: 'acme-corp',
    OwnerId: 'usr_alice',
    Territory: 'West',
    Name: 'Vertex Group — Expansion',
    StageName: 'Negotiation',
    Amount: 90_000,
    CloseDate: '2026-01-20',
  },
  {
    Id: '006000000000003',
    TenantId: 'acme-corp',
    OwnerId: 'usr_bob',
    Territory: 'West',
    Name: 'Ironwood Labs — New Business',
    StageName: 'Closed Won',
    Amount: 410_000,
    CloseDate: '2025-12-01',
  },
];

const OPTIONS = { maxRows: 200 };

describe('parseSoql', () => {
  it('parses a minimal query', () => {
    const parsed = parseSoql('SELECT Id, Name FROM Opportunity');
    expect(parsed.object).toBe('Opportunity');
    expect(parsed.fields).toEqual(['Id', 'Name']);
    expect(parsed.conditions).toHaveLength(0);
  });

  it('accepts a star projection', () => {
    expect(parseSoql('SELECT * FROM Contact').fields).toBe('*');
  });

  it('is case-insensitive about keywords and object names', () => {
    expect(parseSoql('select id from opportunity').object).toBe('Opportunity');
  });

  it('parses a WHERE clause with several conditions', () => {
    const parsed = parseSoql(
      "SELECT Id FROM Opportunity WHERE StageName = 'Proposal' AND Amount > 100000",
    );
    expect(parsed.conditions).toHaveLength(2);
    expect(parsed.combinator).toBe('AND');
    expect(parsed.conditions[1]).toMatchObject({ field: 'Amount', operator: '>', value: 100_000 });
  });

  it('parses ORDER BY and LIMIT', () => {
    const parsed = parseSoql('SELECT Id FROM Opportunity ORDER BY Amount DESC LIMIT 10');
    expect(parsed.orderBy).toEqual({ field: 'Amount', direction: 'DESC' });
    expect(parsed.limit).toBe(10);
  });

  it('parses IN and LIKE', () => {
    const parsed = parseSoql(
      "SELECT Id FROM Opportunity WHERE StageName IN ('Proposal', 'Negotiation')",
    );
    expect(parsed.conditions[0]?.value).toEqual(['Proposal', 'Negotiation']);
    expect(parseSoql("SELECT Id FROM Contact WHERE Name LIKE 'A%'").conditions[0]?.operator).toBe(
      'LIKE',
    );
  });

  it('rejects an unknown object', () => {
    expect(() => parseSoql('SELECT Id FROM Invoice')).toThrow(/Unknown object/i);
  });

  it('rejects an unparseable query', () => {
    expect(() => parseSoql('DELETE FROM Opportunity')).toThrow(BadRequestError);
    expect(() => parseSoql('')).toThrow(BadRequestError);
  });

  it('rejects a mixed AND/OR clause rather than guessing precedence', () => {
    expect(() =>
      parseSoql("SELECT Id FROM Opportunity WHERE a = 1 AND b = 2 OR c = 3"),
    ).toThrow(/Mixing AND and OR/i);
  });

  it('rejects an invalid field name', () => {
    expect(() => parseSoql('SELECT Id, 1+1 FROM Contact')).toThrow(/Invalid field/i);
  });

  it('rejects an over-long query', () => {
    expect(() => parseSoql(`SELECT Id FROM Contact WHERE Name = '${'x'.repeat(4100)}'`)).toThrow(
      /limit/i,
    );
  });

  it('tolerates a trailing semicolon', () => {
    expect(() => parseSoql('SELECT Id FROM Contact;')).not.toThrow();
  });
});

describe('executeQuery', () => {
  it('projects only the selected fields', () => {
    const result = executeQuery(parseSoql('SELECT Id, Amount FROM Opportunity'), RECORDS, OPTIONS);
    expect(Object.keys(result.records[0] ?? {})).toEqual(['Id', 'Amount']);
  });

  it('returns whole records for a star projection', () => {
    const result = executeQuery(parseSoql('SELECT * FROM Opportunity'), RECORDS, OPTIONS);
    expect(result.records[0]).toHaveProperty('StageName');
  });

  it('filters with equality, case-insensitively for strings', () => {
    const result = executeQuery(
      parseSoql("SELECT Id FROM Opportunity WHERE StageName = 'proposal'"),
      RECORDS,
      OPTIONS,
    );
    expect(result.totalSize).toBe(1);
  });

  it('filters with numeric comparison', () => {
    const result = executeQuery(
      parseSoql('SELECT Id FROM Opportunity WHERE Amount >= 250000'),
      RECORDS,
      OPTIONS,
    );
    expect(result.totalSize).toBe(2);
  });

  it('filters with a date comparison', () => {
    const result = executeQuery(
      parseSoql("SELECT Id FROM Opportunity WHERE CloseDate < '2026-01-01'"),
      RECORDS,
      OPTIONS,
    );
    expect(result.totalSize).toBe(1);
  });

  it('applies OR across conditions', () => {
    const result = executeQuery(
      parseSoql("SELECT Id FROM Opportunity WHERE StageName = 'Proposal' OR Amount > 400000"),
      RECORDS,
      OPTIONS,
    );
    expect(result.totalSize).toBe(2);
  });

  it('supports LIKE with a wildcard', () => {
    const result = executeQuery(
      parseSoql("SELECT Id FROM Opportunity WHERE Name LIKE '%Expansion'"),
      RECORDS,
      OPTIONS,
    );
    expect(result.totalSize).toBe(1);
  });

  it('sorts ascending and descending', () => {
    const descending = executeQuery(
      parseSoql('SELECT Id, Amount FROM Opportunity ORDER BY Amount DESC'),
      RECORDS,
      OPTIONS,
    );
    expect(descending.records.map((record) => record.Amount)).toEqual([410_000, 250_000, 90_000]);

    const ascending = executeQuery(
      parseSoql('SELECT Id, Amount FROM Opportunity ORDER BY Amount ASC'),
      RECORDS,
      OPTIONS,
    );
    expect(ascending.records[0]?.Amount).toBe(90_000);
  });

  it('reports the full match count even when the page is truncated', () => {
    const result = executeQuery(parseSoql('SELECT Id FROM Opportunity'), RECORDS, { maxRows: 1 });
    expect(result.totalSize).toBe(3);
    expect(result.records).toHaveLength(1);
    expect(result.done).toBe(false);
  });

  it('caps a caller-supplied LIMIT at the server maximum', () => {
    const result = executeQuery(
      parseSoql('SELECT Id FROM Opportunity LIMIT 10000'),
      RECORDS,
      { maxRows: 2 },
    );
    expect(result.records).toHaveLength(2);
  });

  it('cannot reach a record that was filtered out before execution', () => {
    // Visibility is applied before the query runs; a WHERE clause naming
    // another owner still only searches what the caller could already see.
    const visibleToAlice = RECORDS.filter((record) => record.OwnerId === 'usr_alice');
    const result = executeQuery(
      parseSoql("SELECT Id FROM Opportunity WHERE OwnerId = 'usr_bob'"),
      visibleToAlice,
      OPTIONS,
    );
    expect(result.totalSize).toBe(0);
  });
});
