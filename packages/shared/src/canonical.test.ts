import { describe, expect, it } from 'vitest';

import { canonicalize, scopeDigest, sha256Canonical } from './canonical.js';

describe('canonicalize', () => {
  it('orders object keys deterministically', () => {
    expect(canonicalize({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
    expect(canonicalize({ a: 2, b: 1 })).toBe(canonicalize({ b: 1, a: 2 }));
  });

  it('orders nested keys too', () => {
    const left = canonicalize({ outer: { z: 1, a: { y: 2, b: 3 } } });
    const right = canonicalize({ outer: { a: { b: 3, y: 2 }, z: 1 } });
    expect(left).toBe(right);
  });

  it('preserves array order', () => {
    expect(canonicalize([3, 1, 2])).toBe('[3,1,2]');
    expect(canonicalize([1, 2, 3])).not.toBe(canonicalize([3, 2, 1]));
  });

  it('omits undefined properties but keeps null', () => {
    expect(canonicalize({ a: undefined, b: null })).toBe('{"b":null}');
  });

  it('turns undefined array entries into null', () => {
    expect(canonicalize([1, undefined, 3])).toBe('[1,null,3]');
  });

  it('normalises negative zero', () => {
    expect(canonicalize({ v: -0 })).toBe('{"v":0}');
    expect(canonicalize({ v: -0 })).toBe(canonicalize({ v: 0 }));
  });

  it('rejects non-finite numbers', () => {
    expect(() => canonicalize({ v: Number.NaN })).toThrow(TypeError);
    expect(() => canonicalize({ v: Number.POSITIVE_INFINITY })).toThrow(TypeError);
  });

  it('serialises dates as ISO strings', () => {
    expect(canonicalize({ at: new Date('2026-01-02T03:04:05.000Z') })).toBe(
      '{"at":"2026-01-02T03:04:05.000Z"}',
    );
  });

  it('serialises bigint as a decimal string', () => {
    expect(canonicalize({ n: 90071992547409911n })).toBe('{"n":"90071992547409911"}');
  });

  it('escapes strings via JSON rules', () => {
    expect(canonicalize({ s: 'a"b\\c\n' })).toBe('{"s":"a\\"b\\\\c\\n"}');
  });

  it('rejects circular structures', () => {
    const node: Record<string, unknown> = { name: 'loop' };
    node.self = node;
    expect(() => canonicalize(node as never)).toThrow(/circular/i);
  });

  it('handles a top-level undefined as null', () => {
    expect(canonicalize(undefined)).toBe('null');
  });
});

describe('sha256Canonical', () => {
  it('is stable across key ordering', () => {
    expect(sha256Canonical({ x: 1, y: [1, { b: 2, a: 3 }] })).toBe(
      sha256Canonical({ y: [1, { a: 3, b: 2 }], x: 1 }),
    );
  });

  it('changes when a value changes', () => {
    expect(sha256Canonical({ x: 1 })).not.toBe(sha256Canonical({ x: 2 }));
  });

  it('returns 64 hex characters', () => {
    expect(sha256Canonical({ x: 1 })).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('scopeDigest', () => {
  it('ignores ordering and duplicates', () => {
    expect(scopeDigest(['b', 'a', 'b'])).toBe(scopeDigest(['a', 'b']));
  });

  it('distinguishes different scope sets', () => {
    expect(scopeDigest(['a'])).not.toBe(scopeDigest(['a', 'b']));
  });

  it('ignores empty entries', () => {
    expect(scopeDigest(['a', ''])).toBe(scopeDigest(['a']));
  });
});
