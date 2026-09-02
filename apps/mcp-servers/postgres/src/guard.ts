import { BadRequestError } from '@mcpgateway/shared';

/**
 * Static checks applied to caller-supplied SQL before it reaches Postgres.
 *
 * These are the outer layer of three. Underneath them the statement runs in a
 * READ ONLY transaction as a role with SELECT-only grants and row-level
 * security in force, so none of the checks here is load-bearing on its own —
 * bypassing all of them still yields a read, restricted to the caller's own
 * rows. What they buy is a clear, fast, auditable refusal with a message that
 * says what was wrong, instead of an opaque database error.
 */

const ALLOWED_LEADING_KEYWORDS = ['select', 'with'] as const;

/**
 * Catalog and internal schemas. Reading these does not expose customer data,
 * but it does expose the shape of the deployment (roles, other tenants' table
 * names, connection state), which is reconnaissance a tool call has no reason
 * to perform.
 */
const FORBIDDEN_IDENTIFIER = /\b(pg_[a-z_]+|information_schema)\b/i;

/** Statements a read-only transaction would reject anyway, named explicitly. */
const FORBIDDEN_KEYWORD =
  /\b(insert|update|delete|drop|alter|truncate|grant|revoke|create|comment|reindex|vacuum|copy|call|do|listen|notify|lock|reset|discard|prepare|execute|deallocate|set\s+role|set\s+session)\b/i;

export interface GuardOptions {
  readonly maxRows: number;
  readonly maxLength?: number;
}

export interface GuardedStatement {
  /** The caller's statement, wrapped so the row cap cannot be evaded. */
  readonly sql: string;
  readonly original: string;
  readonly limit: number;
}

/**
 * Strip string literals, quoted identifiers and comments before keyword
 * scanning, so a customer named 'Delete Ltd' does not trip a rule and a
 * `--` comment cannot hide one.
 */
export function stripLiteralsAndComments(sql: string): string {
  let out = '';
  let index = 0;

  while (index < sql.length) {
    const rest = sql.slice(index);

    if (rest.startsWith('--')) {
      const newline = rest.indexOf('\n');
      index += newline === -1 ? rest.length : newline;
      continue;
    }
    if (rest.startsWith('/*')) {
      const close = rest.indexOf('*/');
      index += close === -1 ? rest.length : close + 2;
      continue;
    }
    if (rest.startsWith("'") || rest.startsWith('"')) {
      const quote = rest[0] as string;
      let cursor = 1;
      while (cursor < rest.length) {
        if (rest[cursor] === quote) {
          // Doubled quote is an escaped quote, not a terminator.
          if (rest[cursor + 1] === quote) {
            cursor += 2;
            continue;
          }
          cursor += 1;
          break;
        }
        cursor += 1;
      }
      // Preserve a space so `a'x'b` does not become the identifier `ab`.
      out += ' ';
      index += cursor;
      continue;
    }

    out += sql[index];
    index += 1;
  }

  return out;
}

export function guardStatement(rawSql: string, options: GuardOptions): GuardedStatement {
  const original = rawSql.trim();
  const maxLength = options.maxLength ?? 8_000;

  if (original.length === 0) {
    throw new BadRequestError('A SQL statement is required');
  }
  if (original.length > maxLength) {
    throw new BadRequestError(`Statement exceeds the ${maxLength} character limit`);
  }

  const scannable = stripLiteralsAndComments(original);

  // Reject anything after the first statement. A trailing semicolon is fine.
  const withoutTrailing = scannable.replace(/;\s*$/, '');
  if (withoutTrailing.includes(';')) {
    throw new BadRequestError('Only a single statement may be submitted');
  }

  const leading = withoutTrailing.trimStart().split(/\s+/)[0]?.toLowerCase() ?? '';
  if (!ALLOWED_LEADING_KEYWORDS.includes(leading as (typeof ALLOWED_LEADING_KEYWORDS)[number])) {
    throw new BadRequestError(
      `Only SELECT and WITH statements are permitted; this statement begins with '${leading}'`,
      { leading },
    );
  }

  const forbiddenKeyword = FORBIDDEN_KEYWORD.exec(withoutTrailing);
  if (forbiddenKeyword) {
    throw new BadRequestError(
      `Statement contains the forbidden keyword '${forbiddenKeyword[0]}'`,
      { keyword: forbiddenKeyword[0] },
    );
  }

  const forbiddenIdentifier = FORBIDDEN_IDENTIFIER.exec(withoutTrailing);
  if (forbiddenIdentifier) {
    throw new BadRequestError(
      `Statement references '${forbiddenIdentifier[0]}', which is not queryable through this tool`,
      { identifier: forbiddenIdentifier[0] },
    );
  }

  const limit = Math.max(1, Math.min(options.maxRows, options.maxRows));

  // Wrapping rather than appending: an inner LIMIT the caller wrote still
  // applies, and a caller cannot evade the cap with a trailing comment or a
  // UNION. The wrapper is also what turns a multi-statement attempt into a
  // syntax error rather than an execution.
  return {
    sql: `SELECT * FROM (${withoutTrailing}) AS mcp_guarded_query LIMIT ${limit}`,
    original,
    limit,
  };
}
