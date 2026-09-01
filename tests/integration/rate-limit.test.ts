import { randomUUID } from 'node:crypto';

import { RateLimitConfigStore, RateLimitService, TokenBucketLimiter } from '@mcpgateway/rate-limit';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { startRedis } from './helpers/services.js';

let redis: Redis;
let stopRedis: () => Promise<void>;
let limiter: TokenBucketLimiter;

beforeAll(async () => {
  const service = await startRedis();
  stopRedis = service.stop;
  redis = new Redis(service.url);
  limiter = new TokenBucketLimiter({ redis });
  await limiter.load();
}, 180_000);

afterAll(async () => {
  await redis?.quit();
  await stopRedis?.();
});

function scope() {
  return {
    type: 'user_tool' as const,
    tenantId: `t_${randomUUID().slice(0, 8)}`,
    userId: 'usr_alice',
    toolName: 'sf.query',
  };
}

describe('token bucket against real Redis', () => {
  it('admits exactly the bucket capacity under 500 concurrent callers', async () => {
    const target = scope();
    const capacity = 100;
    // No refill during the test window, so the admitted count must equal the
    // capacity exactly. Anything above it is a lost update; anything below it
    // means the script dropped a legitimate call.
    const config = { capacity, refillTokens: 0, refillIntervalMs: 0 };

    const verdicts = await Promise.all(
      Array.from({ length: 500 }, () => limiter.consume(target, config)),
    );

    const admitted = verdicts.filter((v) => v.allowed).length;
    expect(admitted).toBe(capacity);
    expect(verdicts).toHaveLength(500);
    expect(verdicts.filter((v) => !v.allowed)).toHaveLength(500 - capacity);
  });

  it('stays exact when several limiter instances share one bucket', async () => {
    const target = scope();
    const config = { capacity: 50, refillTokens: 0, refillIntervalMs: 0 };

    // Four independent clients, as four gateway replicas would be.
    const clients = Array.from({ length: 4 }, () => new Redis(redis.options));
    const limiters = clients.map((client) => new TokenBucketLimiter({ redis: client }));
    await Promise.all(limiters.map((l) => l.load()));

    try {
      const verdicts = await Promise.all(
        Array.from({ length: 400 }, (_, index) =>
          (limiters[index % limiters.length] as TokenBucketLimiter).consume(target, config),
        ),
      );
      expect(verdicts.filter((v) => v.allowed)).toHaveLength(50);
    } finally {
      await Promise.all(clients.map((client) => client.quit()));
    }
  });

  it('charges the requested cost rather than one token per call', async () => {
    const target = scope();
    const config = { capacity: 10, refillTokens: 0, refillIntervalMs: 0 };

    const first = await limiter.consume(target, config, 4);
    const second = await limiter.consume(target, config, 4);
    const third = await limiter.consume(target, config, 4);

    expect(first.allowed).toBe(true);
    expect(first.remaining).toBe(6);
    expect(second.allowed).toBe(true);
    expect(second.remaining).toBe(2);
    expect(third.allowed).toBe(false);
  });

  it('refills continuously rather than in a single step at the window boundary', async () => {
    const target = scope();
    // 10 tokens per second, drained immediately.
    const config = { capacity: 10, refillTokens: 10, refillIntervalMs: 1_000 };
    for (let i = 0; i < 10; i += 1) await limiter.consume(target, config);

    const denied = await limiter.consume(target, config);
    expect(denied.allowed).toBe(false);
    expect(denied.retryAfterMs).toBeGreaterThan(0);
    expect(denied.retryAfterMs).toBeLessThanOrEqual(1_000);

    await new Promise((resolve) => setTimeout(resolve, 350));
    const afterPartialRefill = await limiter.consume(target, config);
    // Roughly 3 tokens have returned after 350ms; a fixed-window limiter would
    // still be refusing here.
    expect(afterPartialRefill.allowed).toBe(true);
  });

  it('never exceeds capacity no matter how long a bucket has been idle', async () => {
    const target = scope();
    const config = { capacity: 5, refillTokens: 1_000, refillIntervalMs: 1 };

    await limiter.consume(target, config);
    await new Promise((resolve) => setTimeout(resolve, 60));

    const verdict = await limiter.consume(target, config);
    expect(verdict.remaining).toBeLessThanOrEqual(5);
  });

  it('reports a retry delay a client can act on', async () => {
    const target = scope();
    const config = { capacity: 1, refillTokens: 1, refillIntervalMs: 2_000 };

    await limiter.consume(target, config);
    const denied = await limiter.consume(target, config);

    expect(denied.allowed).toBe(false);
    expect(denied.retryAfterMs).toBeGreaterThan(1_000);
    expect(denied.retryAfterMs).toBeLessThanOrEqual(2_000);
  });

  it('recovers from SCRIPT FLUSH without failing a request', async () => {
    const target = scope();
    const config = { capacity: 3, refillTokens: 0, refillIntervalMs: 0 };

    await limiter.consume(target, config);
    await redis.call('SCRIPT', 'FLUSH');

    const verdict = await limiter.consume(target, config);
    expect(verdict.allowed).toBe(true);
    expect(verdict.remaining).toBe(1);
  });

  it('isolates buckets across tenants, users and tools', async () => {
    const config = { capacity: 1, refillTokens: 0, refillIntervalMs: 0 };
    const base = scope();

    await limiter.consume(base, config);
    expect((await limiter.consume(base, config)).allowed).toBe(false);
    expect((await limiter.consume({ ...base, userId: 'usr_bob' }, config)).allowed).toBe(true);
    expect((await limiter.consume({ ...base, toolName: 'pg.query' }, config)).allowed).toBe(true);
    expect((await limiter.consume({ ...base, tenantId: 'other' }, config)).allowed).toBe(true);
  });
});

describe('rate limit configuration hot reload', () => {
  it('propagates a change to every subscriber through Redis pub/sub', async () => {
    const subscriber = new Redis(redis.options);
    const publisher = new Redis(redis.options);
    let capacity = 100;

    const store = new RateLimitConfigStore({
      loader: async () => [
        {
          tenantId: 'acme-corp',
          scopeType: 'user_tool',
          toolName: '*',
          tier: 'default',
          capacity,
          refillTokens: 0,
          refillIntervalMs: 0,
        },
      ],
      subscriber,
      publisher,
    });

    try {
      await store.start();
      expect(store.resolve('acme-corp', 'sf.query').userTool.capacity).toBe(100);

      capacity = 7;
      await store.publishReload();

      await vi.waitFor(() =>
        expect(store.resolve('acme-corp', 'sf.query').userTool.capacity).toBe(7),
      );
    } finally {
      await store.stop();
      await subscriber.quit();
      await publisher.quit();
    }
  });

  it('applies a reloaded limit to buckets created after the change', async () => {
    const target = scope();
    let capacity = 5;
    const store = new RateLimitConfigStore({
      loader: async () => [
        {
          tenantId: target.tenantId,
          scopeType: 'user_tool',
          toolName: '*',
          tier: 'default',
          capacity,
          refillTokens: 0,
          refillIntervalMs: 0,
        },
        {
          tenantId: target.tenantId,
          scopeType: 'tenant',
          toolName: '*',
          tier: 'default',
          capacity: 10_000,
          refillTokens: 0,
          refillIntervalMs: 0,
        },
      ],
    });
    await store.start();
    const service = new RateLimitService(limiter, store);

    const call = (userId: string) =>
      service.check({ tenantId: target.tenantId, userId, toolName: 'sf.query' });

    for (let i = 0; i < 5; i += 1) {
      expect((await call('usr_before')).allowed).toBe(true);
    }
    expect((await call('usr_before')).allowed).toBe(false);

    capacity = 50;
    await store.publishReload();

    // A bucket opened after the change starts at the new capacity. An existing
    // bucket keeps its current token count, which is the correct behaviour: a
    // raised limit grants headroom going forward, it does not retroactively
    // refund calls already spent.
    for (let i = 0; i < 20; i += 1) {
      expect((await call('usr_after')).allowed).toBe(true);
    }
    expect((await call('usr_before')).allowed).toBe(false);
  });
});
