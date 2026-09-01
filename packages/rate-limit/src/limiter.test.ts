import { describe, expect, it, vi } from 'vitest';

import { bucketKey, scopeLabel } from './keys.js';
import { TokenBucketLimiter, type RedisScriptClient } from './limiter.js';

interface Recorded {
  sha?: string;
  script?: string;
  args: (string | number)[];
}

function fakeRedis(options: { failFirstEvalsha?: boolean; result?: number[] } = {}) {
  const calls: { evalsha: Recorded[]; eval: Recorded[]; load: number } = {
    evalsha: [],
    eval: [],
    load: 0,
  };
  let noScriptPending = options.failFirstEvalsha ?? false;
  const result = options.result ?? [1, 9, 0, 10];

  const redis: RedisScriptClient = {
    script: async () => {
      calls.load += 1;
      return `sha-${calls.load}`;
    },
    evalsha: async (sha, _numKeys, ...args) => {
      calls.evalsha.push({ sha, args });
      if (noScriptPending) {
        noScriptPending = false;
        throw new Error('NOSCRIPT No matching script. Please use EVAL.');
      }
      return result;
    },
    eval: async (script, _numKeys, ...args) => {
      calls.eval.push({ script, args });
      return result;
    },
  };

  return { redis, calls };
}

const scope = { type: 'user_tool', tenantId: 'acme-corp', userId: 'usr_alice', toolName: 'sf.query' } as const;
const config = { capacity: 10, refillTokens: 10, refillIntervalMs: 60_000 };

describe('bucketKey', () => {
  it('places the tenant in a hash tag so a tenant buckets share a cluster slot', () => {
    expect(bucketKey({ type: 'tenant', tenantId: 'acme-corp' })).toBe('rl:{acme-corp}:t');
    expect(bucketKey(scope)).toBe('rl:{acme-corp}:u:usr_alice:sf.query');
  });

  it('separates users, tools and tenants', () => {
    const other = { ...scope, userId: 'usr_bob' };
    expect(bucketKey(scope)).not.toBe(bucketKey(other));
    expect(bucketKey({ ...scope, toolName: 'sf.get_contact' })).not.toBe(bucketKey(scope));
    expect(bucketKey({ ...scope, tenantId: 'globex' })).not.toBe(bucketKey(scope));
  });

  it('falls back to placeholders when identifiers are absent', () => {
    expect(bucketKey({ type: 'user_tool', tenantId: 't' })).toBe('rl:{t}:u:anonymous:*');
  });

  it('labels scopes readably', () => {
    expect(scopeLabel({ type: 'tenant', tenantId: 'acme-corp' })).toBe('tenant:acme-corp');
    expect(scopeLabel(scope)).toBe('user:usr_alice/tool:sf.query');
  });
});

describe('TokenBucketLimiter', () => {
  it('registers the script once and reuses the digest', async () => {
    const { redis, calls } = fakeRedis();
    const limiter = new TokenBucketLimiter({ redis });

    await limiter.load();
    await limiter.consume(scope, config);
    await limiter.consume(scope, config);

    expect(calls.load).toBe(1);
    expect(calls.evalsha).toHaveLength(2);
    expect(calls.eval).toHaveLength(0);
    expect(limiter.scriptSha).toBe('sha-1');
  });

  it('loads lazily on first use when load() was not called', async () => {
    const { redis, calls } = fakeRedis();
    const limiter = new TokenBucketLimiter({ redis });

    await limiter.consume(scope, config);
    expect(calls.load).toBe(1);
    expect(calls.evalsha).toHaveLength(1);
  });

  it('passes the bucket parameters through in the documented order', async () => {
    const { redis, calls } = fakeRedis();
    const limiter = new TokenBucketLimiter({ redis, now: () => 1_700_000_000_000 });

    await limiter.consume(scope, { capacity: 25, refillTokens: 5, refillIntervalMs: 1_000 }, 3);

    const args = calls.evalsha[0]?.args ?? [];
    expect(args[0]).toBe('rl:{acme-corp}:u:usr_alice:sf.query');
    expect(args[1]).toBe(25);
    expect(args[2]).toBe(5);
    expect(args[3]).toBe(1_000);
    expect(args[4]).toBe(3);
    expect(Number(args[5])).toBeGreaterThan(0);
    expect(args[6]).toBe(1_700_000_000_000);
  });

  it('defers to the Redis server clock unless a clock is injected', async () => {
    const { redis, calls } = fakeRedis();
    const limiter = new TokenBucketLimiter({ redis });

    await limiter.consume(scope, config);
    // A zero timestamp tells the script to call TIME itself.
    expect(calls.evalsha[0]?.args[6]).toBe(0);
  });

  it('replays through EVAL when Redis has forgotten the script', async () => {
    const { redis, calls } = fakeRedis({ failFirstEvalsha: true });
    const limiter = new TokenBucketLimiter({ redis });

    const verdict = await limiter.consume(scope, config);

    expect(calls.evalsha).toHaveLength(1);
    expect(calls.eval).toHaveLength(1);
    expect(calls.eval[0]?.script).toContain('token bucket');
    expect(verdict.allowed).toBe(true);
  });

  it('re-registers the script after a NOSCRIPT so later calls use EVALSHA again', async () => {
    const { redis, calls } = fakeRedis({ failFirstEvalsha: true });
    const limiter = new TokenBucketLimiter({ redis });

    await limiter.consume(scope, config);
    await vi.waitFor(() => expect(calls.load).toBe(2));

    await limiter.consume(scope, config);
    expect(calls.eval).toHaveLength(1);
    expect(calls.evalsha).toHaveLength(2);
  });

  it('propagates errors that are not NOSCRIPT', async () => {
    const redis: RedisScriptClient = {
      script: async () => 'sha',
      evalsha: async () => {
        throw new Error('READONLY You can not write against a read only replica.');
      },
      eval: async () => [1, 1, 0, 1],
    };
    const limiter = new TokenBucketLimiter({ redis });
    await expect(limiter.consume(scope, config)).rejects.toThrow(/READONLY/);
  });

  it('maps the script reply onto a verdict', async () => {
    const { redis } = fakeRedis({ result: [0, 0, 4_200, 10] });
    const limiter = new TokenBucketLimiter({ redis });

    const verdict = await limiter.consume(scope, config);
    expect(verdict).toMatchObject({
      allowed: false,
      remaining: 0,
      retryAfterMs: 4_200,
      limit: 10,
      scope: 'user:usr_alice/tool:sf.query',
      key: 'rl:{acme-corp}:u:usr_alice:sf.query',
    });
  });

  it('rejects a malformed script reply rather than guessing', async () => {
    const redis: RedisScriptClient = {
      script: async () => 'sha',
      evalsha: async () => 'not-an-array',
      eval: async () => 'not-an-array',
    };
    const limiter = new TokenBucketLimiter({ redis });
    await expect(limiter.consume(scope, config)).rejects.toThrow(/unexpected shape/);
  });

  it('rejects a SCRIPT LOAD that does not return a digest', async () => {
    const redis: RedisScriptClient = {
      script: async () => 42,
      evalsha: async () => [1, 1, 0, 1],
      eval: async () => [1, 1, 0, 1],
    };
    const limiter = new TokenBucketLimiter({ redis });
    await expect(limiter.load()).rejects.toThrow(/digest/);
  });

  it('sets a bucket TTL of at least a minute', async () => {
    const { redis, calls } = fakeRedis();
    const limiter = new TokenBucketLimiter({ redis });

    await limiter.consume(scope, { capacity: 1, refillTokens: 1, refillIntervalMs: 100 });
    expect(Number(calls.evalsha[0]?.args[5])).toBeGreaterThanOrEqual(60_000);
  });
});
