import { createHash } from 'node:crypto';

/**
 * Canonical JSON serialisation (RFC 8785-style, restricted to the subset this
 * system actually produces).
 *
 * The audit chain hashes rows, and the token-exchange cache keys on a scope
 * digest. Both need two structurally equal values to serialise byte-identically
 * regardless of key insertion order, so `JSON.stringify` alone is not enough.
 *
 * Rules:
 *   - object keys sorted by UTF-16 code unit, ascending
 *   - `undefined` object properties omitted; `undefined` array entries become null
 *   - no insignificant whitespace
 *   - non-finite numbers rejected (they are not representable in JSON)
 *   - `Date` serialised as an ISO-8601 string
 *   - `bigint` serialised as a decimal string (JSON has no bigint)
 */
export type CanonicalValue =
  | null
  | boolean
  | number
  | bigint
  | string
  | Date
  | readonly CanonicalValue[]
  | { readonly [key: string]: CanonicalValue | undefined };

export function canonicalize(value: CanonicalValue | undefined): string {
  const out = encode(value, new WeakSet<object>());
  return out ?? 'null';
}

function encode(value: CanonicalValue | undefined, seen: WeakSet<object>): string | undefined {
  if (value === undefined) return undefined;
  if (value === null) return 'null';

  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(value)) {
        throw new TypeError(`Cannot canonicalize non-finite number: ${String(value)}`);
      }
      // `-0` and `0` are the same JSON value; normalise so hashes agree.
      return Object.is(value, -0) ? '0' : JSON.stringify(value);
    case 'bigint':
      return JSON.stringify(value.toString());
    case 'string':
      return JSON.stringify(value);
    default:
      break;
  }

  if (value instanceof Date) return JSON.stringify(value.toISOString());

  if (seen.has(value)) throw new TypeError('Cannot canonicalize a circular structure');
  seen.add(value);

  try {
    if (Array.isArray(value)) {
      const items = value.map((item) => encode(item, seen) ?? 'null');
      return `[${items.join(',')}]`;
    }

    const record = value as { readonly [key: string]: CanonicalValue | undefined };
    const parts: string[] = [];
    for (const key of Object.keys(record).sort()) {
      const encoded = encode(record[key], seen);
      if (encoded === undefined) continue;
      parts.push(`${JSON.stringify(key)}:${encoded}`);
    }
    return `{${parts.join(',')}}`;
  } finally {
    seen.delete(value);
  }
}

/** Lowercase hex SHA-256 of the canonical form. */
export function sha256Canonical(value: CanonicalValue | undefined): string {
  return createHash('sha256').update(canonicalize(value), 'utf8').digest('hex');
}

/** Lowercase hex SHA-256 of a raw string. */
export function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

/**
 * Order-insensitive digest of a scope set. Used as part of the token-exchange
 * cache key so that `read write` and `write read` reuse the same cached token.
 */
export function scopeDigest(scopes: readonly string[]): string {
  const normalised = [...new Set(scopes.filter((s) => s.length > 0))].sort();
  return sha256Hex(normalised.join(' ')).slice(0, 16);
}
