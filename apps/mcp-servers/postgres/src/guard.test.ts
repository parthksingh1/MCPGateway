import { BadRequestError } from '@mcpgateway/shared';
import { describe, expect, it } from 'vitest';

import { guardStatement, stripLiteralsAndComments } from './guard.js';

const OPTIONS = { maxRows: 500 };

function guard(sql: string) {
  return guardStatement(sql, OPTIONS);
}

describe('stripLiteralsAndComments', () => {
  it('removes single-quoted strings', () => {
    expect(stripLiteralsAndComments("SELECT 'delete me' AS x")).not.toMatch(/delete/i);
  });

  it('removes double-quoted identifiers', () => {
    expect(stripLiteralsAndComments('SELECT "drop table" FROM t')).not.toMatch(/drop/i);
  });

  it('handles doubled quotes inside a literal', () => {
    const stripped = stripLiteralsAndComments("SELECT 'it''s a drop' AS x, id FROM orders");
    expect(stripped).not.toMatch(/drop/i);
    expect(stripped).toMatch(/orders/);
  });

  it('removes line comments', () => {
    const stripped = stripLiteralsAndComments('SELECT 1 -- drop table orders\nFROM t');
    expect(stripped).not.toMatch(/drop/i);
    expect(stripped).toMatch(/FROM t/);
  });

  it('removes block comments', () => {
    expect(stripLiteralsAndComments('SELECT /* delete */ 1')).not.toMatch(/delete/i);
  });

  it('leaves ordinary SQL intact', () => {
    expect(stripLiteralsAndComments('SELECT id FROM orders')).toContain('SELECT id FROM orders');
  });
});

describe('guardStatement', () => {
  it('accepts a plain select', () => {
    const result = guard('SELECT id FROM orders');
    expect(result.sql).toContain('SELECT id FROM orders');
    expect(result.sql).toContain('LIMIT 500');
  });

  it('accepts a CTE', () => {
    expect(() => guard('WITH x AS (SELECT 1) SELECT * FROM x')).not.toThrow();
  });

  it('wraps the statement so an inner query cannot evade the row cap', () => {
    const result = guard('SELECT id FROM orders LIMIT 100000');
    expect(result.sql).toMatch(/^SELECT \* FROM \(.*\) AS mcp_guarded_query LIMIT 500$/s);
  });

  it('honours a lower caller-supplied cap', () => {
    expect(guardStatement('SELECT 1', { maxRows: 10 }).sql).toContain('LIMIT 10');
  });

  it('rejects an empty statement', () => {
    expect(() => guard('   ')).toThrow(BadRequestError);
  });

  it('rejects an over-long statement', () => {
    expect(() => guardStatement(`SELECT ${'a'.repeat(9000)}`, { maxRows: 10 })).toThrow(/limit/i);
  });

  const writes = [
    'INSERT INTO orders VALUES (1)',
    'UPDATE orders SET status = 1',
    'DELETE FROM orders',
    'DROP TABLE orders',
    'ALTER TABLE orders ADD COLUMN x int',
    'TRUNCATE orders',
    'GRANT SELECT ON orders TO public',
    'CREATE TABLE t (id int)',
    'COPY orders TO STDOUT',
  ];

  for (const statement of writes) {
    it(`rejects ${statement.split(' ')[0]}`, () => {
      expect(() => guard(statement)).toThrow(BadRequestError);
    });
  }

  it('rejects a write hidden behind a leading select', () => {
    expect(() => guard('SELECT 1; DELETE FROM orders')).toThrow(/single statement/i);
  });

  it('rejects a write appended after a trailing semicolon and a comment', () => {
    expect(() => guard('SELECT 1; -- harmless\nDROP TABLE orders')).toThrow(BadRequestError);
  });

  it('allows a single trailing semicolon', () => {
    expect(() => guard('SELECT 1;')).not.toThrow();
  });

  it('rejects a CTE that performs a write', () => {
    expect(() => guard('WITH d AS (DELETE FROM orders RETURNING id) SELECT * FROM d')).toThrow(
      /delete/i,
    );
  });

  it('rejects catalog access', () => {
    expect(() => guard('SELECT * FROM pg_catalog.pg_tables')).toThrow(/pg_/i);
    expect(() => guard('SELECT * FROM pg_roles')).toThrow(/pg_/i);
    expect(() => guard('SELECT * FROM information_schema.columns')).toThrow(/information_schema/i);
  });

  it('rejects a role change attempt', () => {
    expect(() => guard('SET ROLE app_admin')).toThrow(BadRequestError);
  });

  it('does not trip on a keyword appearing inside a string literal', () => {
    expect(() => guard("SELECT id FROM customers WHERE name = 'Drop Anchor Ltd'")).not.toThrow();
  });

  it('does not trip on a keyword inside a comment', () => {
    expect(() => guard('SELECT id FROM orders -- we do not delete here')).not.toThrow();
  });

  it('does not trip on a column whose name contains a keyword substring', () => {
    expect(() => guard('SELECT created_at, updated_by_id FROM orders')).not.toThrow();
  });

  it('reports the offending keyword in the error details', () => {
    const error = (() => {
      try {
        guard('DELETE FROM orders');
        return null;
      } catch (e) {
        return e as BadRequestError;
      }
    })();

    expect(error).toBeInstanceOf(BadRequestError);
    expect(error?.message).toMatch(/delete/i);
  });

  it('names the leading keyword when the statement is not a read', () => {
    expect(() => guard('EXPLAIN ANALYZE SELECT 1')).toThrow(/begins with 'explain'/i);
  });

  it('preserves the original statement for auditing', () => {
    expect(guard('SELECT 1').original).toBe('SELECT 1');
  });
});
