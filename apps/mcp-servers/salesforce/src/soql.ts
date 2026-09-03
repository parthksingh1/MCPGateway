import { BadRequestError } from '@mcpgateway/shared';

import type { CrmRecord, SObjectName } from './dataset.js';

/**
 * A deliberately small SOQL subset.
 *
 * Supported:
 *   SELECT <fields | *> FROM <Object>
 *     [WHERE <cond> (AND|OR <cond>)*]
 *     [ORDER BY <field> [ASC|DESC]]
 *     [LIMIT <n>]
 *   cond := <field> (= | != | < | <= | > | >=) <literal>
 *         | <field> LIKE '<pattern with %>'
 *         | <field> IN (<literal>, ...)
 *
 * Not supported: subqueries, relationship traversal, aggregates, GROUP BY.
 * Those are the parts of SOQL that would make this a parser project rather
 * than a gateway project; `sf.list_opportunities` covers the aggregate case
 * with a purpose-built tool instead.
 *
 * Nothing here touches a database, so the parser is not a security boundary —
 * visibility filtering happens after parsing and is not expressible in the
 * query. A WHERE clause can only ever narrow what the caller could already see.
 */

const OBJECTS: Record<string, SObjectName> = {
  account: 'Account',
  contact: 'Contact',
  opportunity: 'Opportunity',
  task: 'Task',
};

export interface Comparison {
  readonly field: string;
  readonly operator: '=' | '!=' | '<' | '<=' | '>' | '>=' | 'LIKE' | 'IN';
  readonly value: string | number | boolean | null | (string | number)[];
}

export interface ParsedQuery {
  readonly object: SObjectName;
  readonly fields: string[] | '*';
  readonly conditions: Comparison[];
  readonly combinator: 'AND' | 'OR';
  readonly orderBy: { field: string; direction: 'ASC' | 'DESC' } | null;
  readonly limit: number | null;
}

const QUERY_PATTERN =
  /^\s*SELECT\s+(?<fields>.+?)\s+FROM\s+(?<object>[A-Za-z_]+)(?:\s+WHERE\s+(?<where>.+?))?(?:\s+ORDER\s+BY\s+(?<order>[A-Za-z_.]+)(?:\s+(?<dir>ASC|DESC))?)?(?:\s+LIMIT\s+(?<limit>\d+))?\s*$/is;

export function parseSoql(query: string): ParsedQuery {
  const trimmed = query.trim().replace(/;+\s*$/, '');
  if (trimmed.length === 0) throw new BadRequestError('A SOQL query is required');
  if (trimmed.length > 4_000) throw new BadRequestError('Query exceeds the 4000 character limit');

  const match = QUERY_PATTERN.exec(trimmed);
  if (!match?.groups) {
    throw new BadRequestError(
      'Could not parse the query. Expected: SELECT <fields> FROM <Object> [WHERE ...] [ORDER BY ...] [LIMIT n]',
    );
  }

  const { fields, object, where, order, dir, limit } = match.groups;

  const resolved = OBJECTS[(object ?? '').toLowerCase()];
  if (!resolved) {
    throw new BadRequestError(
      `Unknown object '${object}'. Available: ${[...new Set(Object.values(OBJECTS))].join(', ')}`,
    );
  }

  const fieldList = (fields ?? '').trim();
  const selected =
    fieldList === '*'
      ? ('*' as const)
      : fieldList
          .split(',')
          .map((field) => field.trim())
          .filter((field) => field.length > 0);

  if (selected !== '*' && selected.length === 0) {
    throw new BadRequestError('At least one field must be selected');
  }
  if (selected !== '*') {
    for (const field of selected) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(field)) {
        throw new BadRequestError(`Invalid field name '${field}'`);
      }
    }
  }

  const { conditions, combinator } = where ? parseWhere(where) : { conditions: [], combinator: 'AND' as const };

  return {
    object: resolved,
    fields: selected,
    conditions,
    combinator,
    orderBy: order ? { field: order, direction: dir?.toUpperCase() === 'DESC' ? 'DESC' : 'ASC' } : null,
    limit: limit ? Number.parseInt(limit, 10) : null,
  };
}

function parseWhere(clause: string): { conditions: Comparison[]; combinator: 'AND' | 'OR' } {
  const usesOr = /\s+OR\s+/i.test(clause);
  const usesAnd = /\s+AND\s+/i.test(clause);
  if (usesOr && usesAnd) {
    throw new BadRequestError(
      'Mixing AND and OR in one WHERE clause is not supported; use a single combinator',
    );
  }

  const parts = clause.split(usesOr ? /\s+OR\s+/i : /\s+AND\s+/i);
  return {
    conditions: parts.map((part) => parseComparison(part.trim())),
    combinator: usesOr ? 'OR' : 'AND',
  };
}

const COMPARISON_PATTERN =
  /^(?<field>[A-Za-z_][A-Za-z0-9_]*)\s*(?<op>>=|<=|!=|=|<|>|\bLIKE\b|\bIN\b)\s*(?<value>.+)$/i;

function parseComparison(input: string): Comparison {
  const match = COMPARISON_PATTERN.exec(input);
  if (!match?.groups) {
    throw new BadRequestError(`Could not parse the condition '${input}'`);
  }
  const { field, op, value } = match.groups;
  const operator = (op ?? '=').toUpperCase() as Comparison['operator'];

  if (operator === 'IN') {
    const inner = (value ?? '').trim().replace(/^\(|\)$/g, '');
    return {
      field: field ?? '',
      operator,
      value: inner.split(',').map((item) => literal(item.trim()) as string | number),
    };
  }

  return { field: field ?? '', operator, value: literal((value ?? '').trim()) };
}

function literal(raw: string): string | number | boolean | null {
  if (/^'.*'$/s.test(raw)) return raw.slice(1, -1).replace(/''/g, "'");
  if (/^-?\d+(\.\d+)?$/.test(raw)) return Number(raw);
  if (/^true$/i.test(raw)) return true;
  if (/^false$/i.test(raw)) return false;
  if (/^null$/i.test(raw)) return null;
  // A bare word is treated as a string so that `StageName = Proposal` behaves
  // the way someone typing quickly expects, rather than failing.
  return raw;
}

function likeToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${escaped.replace(/%/g, '.*').replace(/_/g, '.')}$`, 'i');
}

function compare(actual: unknown, condition: Comparison): boolean {
  const { operator, value } = condition;

  if (operator === 'IN') {
    return Array.isArray(value) && value.some((candidate) => looseEquals(actual, candidate));
  }
  if (operator === 'LIKE') {
    return typeof actual === 'string' && typeof value === 'string' && likeToRegExp(value).test(actual);
  }
  if (operator === '=') return looseEquals(actual, value);
  if (operator === '!=') return !looseEquals(actual, value);

  const left = typeof actual === 'number' ? actual : Date.parse(String(actual));
  const right = typeof value === 'number' ? value : Date.parse(String(value));
  if (!Number.isFinite(left) || !Number.isFinite(right)) return false;

  switch (operator) {
    case '<':
      return left < right;
    case '<=':
      return left <= right;
    case '>':
      return left > right;
    case '>=':
      return left >= right;
    default:
      return false;
  }
}

function looseEquals(actual: unknown, expected: unknown): boolean {
  if (actual === expected) return true;
  if (typeof actual === 'string' && typeof expected === 'string') {
    return actual.toLowerCase() === expected.toLowerCase();
  }
  if (typeof actual === 'number' && typeof expected === 'string') {
    return actual === Number(expected);
  }
  return false;
}

export interface ExecuteOptions {
  readonly maxRows: number;
}

export interface QueryResult {
  readonly totalSize: number;
  readonly done: boolean;
  readonly records: Record<string, unknown>[];
}

/**
 * Execute a parsed query against records the caller is already permitted to
 * see. `records` must be pre-filtered by visibility — this function does not
 * and cannot widen the set.
 */
export function executeQuery(
  parsed: ParsedQuery,
  records: readonly CrmRecord[],
  options: ExecuteOptions,
): QueryResult {
  let matched = records.filter((record) => {
    if (parsed.conditions.length === 0) return true;
    const results = parsed.conditions.map((condition) => compare(record[condition.field], condition));
    return parsed.combinator === 'OR' ? results.some(Boolean) : results.every(Boolean);
  });

  if (parsed.orderBy) {
    const { field, direction } = parsed.orderBy;
    const sign = direction === 'DESC' ? -1 : 1;
    matched = [...matched].sort((a, b) => sign * compareValues(a[field], b[field]));
  }

  const totalSize = matched.length;
  const limit = Math.min(parsed.limit ?? options.maxRows, options.maxRows);
  const page = matched.slice(0, limit);

  const projected = page.map((record) => {
    if (parsed.fields === '*') return { ...record };
    const out: Record<string, unknown> = {};
    for (const field of parsed.fields) out[field] = record[field];
    return out;
  });

  return { totalSize, done: totalSize <= limit, records: projected };
}

function compareValues(a: unknown, b: unknown): number {
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return String(a ?? '').localeCompare(String(b ?? ''));
}
