import { describe, expect, it, vi } from 'vitest';

import {
  RateLimitConfigStore,
  type RateLimitConfigRecord,
  type RedisSubscriberLike,
} from './config-store.js';
import { CONFIG_INVALIDATION_CHANNEL } from './keys.js';
import type { LimitVerdict, TokenBucketLimiter } from './limiter.js';
import { RateLimitService } from './service.js';

function record(overrides: Partial<RateLimitConfigRecord> = {}): RateLimitConfigRecord {
  return {
    tenantId: 'acme-corp',
    scopeType: 'user_tool',
    toolName: '*',
    tier: 'default',
    capacity: 60,
    refillTokens: 60,
    refillIntervalMs: 60_000,
    ...overrides,
  };
}

function fakeSubscriber() {
  const listeners: ((channel: string, message: string) => void)[] = [];
  const subscriber: RedisSubscriberLike = {
    subscribe: async () => 1,
    unsubscribe: async () => 1,
    on: (_event, listener) => {
      listeners.push(listener);
      return subscriber;
    },
  };
  return { subscriber, emit: (channel: string) => listeners.forEach((l) => l(channel, 'now')) };
}

describe('RateLimitConfigStore', () => {
  it('applies a conservative fallback for an unconfigured tenant', async () => {
    const store = new RateLimitConfigStore({ loader: async () => [] });
    await store.start();

    const limits = store.resolve('unknown-tenant', 'sf.query');
    expect(limits.tenant.tier).toBe('fallback');
    expect(limits.userTool.tier).toBe('fallback');
    // A missing row throttles rather than opening the gate.
    expect(limits.userTool.capacity).toBeLessThan(limits.tenant.capacity);
  });

  it('prefers an exact tool match over the wildcard', async () => {
    const store = new RateLimitConfigStore({
      loader: async () => [
        record({ toolName: '*', capacity: 60 }),
        record({ toolName: 'pg.query', capacity: 5 }),
      ],
    });
    await store.start();

    expect(store.resolve('acme-corp', 'pg.query').userTool.capacity).toBe(5);
    expect(store.resolve('acme-corp', 'sf.query').userTool.capacity).toBe(60);
  });

  it('prefers the requested tier and falls back to default', async () => {
    const store = new RateLimitConfigStore({
      loader: async () => [
        record({ toolName: 'pg.query', tier: 'default', capacity: 5 }),
        record({ toolName: 'pg.query', tier: 'burst', capacity: 200 }),
      ],
    });
    await store.start();

    expect(store.resolve('acme-corp', 'pg.query', 'burst').userTool.capacity).toBe(200);
    expect(store.resolve('acme-corp', 'pg.query', 'nonexistent').userTool.capacity).toBe(5);
  });

  it('resolves the tenant-wide bucket independently of the tool', async () => {
    const store = new RateLimitConfigStore({
      loader: async () => [
        record({ scopeType: 'tenant', toolName: '*', capacity: 1_000 }),
        record({ scopeType: 'user_tool', toolName: '*', capacity: 20 }),
      ],
    });
    await store.start();

    const limits = store.resolve('acme-corp', 'anything.at.all');
    expect(limits.tenant.capacity).toBe(1_000);
    expect(limits.userTool.capacity).toBe(20);
  });

  it('keeps tenants isolated from one another', async () => {
    const store = new RateLimitConfigStore({
      loader: async () => [
        record({ tenantId: 'acme-corp', capacity: 100 }),
        record({ tenantId: 'initech', capacity: 5 }),
      ],
    });
    await store.start();

    expect(store.resolve('acme-corp', 'sf.query').userTool.capacity).toBe(100);
    expect(store.resolve('initech', 'sf.query').userTool.capacity).toBe(5);
  });

  it('reloads when an invalidation message arrives', async () => {
    let capacity = 60;
    const { subscriber, emit } = fakeSubscriber();
    const onReload = vi.fn();
    const store = new RateLimitConfigStore({
      loader: async () => [record({ capacity })],
      subscriber,
      onReload,
    });

    await store.start();
    expect(store.resolve('acme-corp', 'sf.query').userTool.capacity).toBe(60);

    capacity = 5;
    emit(CONFIG_INVALIDATION_CHANNEL);
    await vi.waitFor(() =>
      expect(store.resolve('acme-corp', 'sf.query').userTool.capacity).toBe(5),
    );
    expect(onReload).toHaveBeenCalledTimes(2);
  });

  it('ignores traffic on other channels', async () => {
    let loads = 0;
    const { subscriber, emit } = fakeSubscriber();
    const store = new RateLimitConfigStore({
      loader: async () => {
        loads += 1;
        return [record()];
      },
      subscriber,
    });

    await store.start();
    emit('some:other:channel');
    await Promise.resolve();
    expect(loads).toBe(1);
  });

  it('publishes an invalidation when a publisher is configured', async () => {
    const publish = vi.fn(async () => 1);
    const store = new RateLimitConfigStore({
      loader: async () => [record()],
      publisher: { publish },
    });
    await store.start();
    await store.publishReload();

    expect(publish).toHaveBeenCalledWith(CONFIG_INVALIDATION_CHANNEL, expect.any(String));
  });

  it('reloads locally when there is no publisher', async () => {
    let loads = 0;
    const store = new RateLimitConfigStore({
      loader: async () => {
        loads += 1;
        return [record()];
      },
    });
    await store.start();
    await store.publishReload();
    expect(loads).toBe(2);
  });

  it('exposes a snapshot for the console', async () => {
    const store = new RateLimitConfigStore({ loader: async () => [record(), record()] });
    await store.start();

    const snapshot = store.snapshot();
    expect(snapshot.records).toHaveLength(2);
    expect(snapshot.loadedAt).toBeGreaterThan(0);
  });

  it('unsubscribes on stop', async () => {
    const unsubscribe = vi.fn(async () => 1);
    const { subscriber } = fakeSubscriber();
    const store = new RateLimitConfigStore({
      loader: async () => [],
      subscriber: { ...subscriber, unsubscribe },
    });
    await store.start();
    await store.stop();
    expect(unsubscribe).toHaveBeenCalledWith(CONFIG_INVALIDATION_CHANNEL);
  });
});

describe('RateLimitService', () => {
  function verdict(allowed: boolean, scope: string): LimitVerdict {
    return {
      allowed,
      remaining: allowed ? 5 : 0,
      limit: 10,
      retryAfterMs: allowed ? 0 : 1_000,
      scope,
      key: scope,
    };
  }

  function limiterStub(results: LimitVerdict[]): {
    limiter: TokenBucketLimiter;
    consume: ReturnType<typeof vi.fn>;
  } {
    let call = 0;
    const consume = vi.fn(async () => results[call++] ?? results[results.length - 1]);
    return { limiter: { consume } as unknown as TokenBucketLimiter, consume };
  }

  async function store(): Promise<RateLimitConfigStore> {
    const s = new RateLimitConfigStore({
      loader: async () => [
        record({ scopeType: 'tenant', capacity: 1_000 }),
        record({ scopeType: 'user_tool', capacity: 20 }),
      ],
    });
    await s.start();
    return s;
  }

  const request = { tenantId: 'acme-corp', userId: 'usr_alice', toolName: 'sf.query' };

  it('checks the narrower bucket first so one user cannot drain the tenant', async () => {
    const { limiter, consume } = limiterStub([verdict(false, 'user')]);
    const outcome = await new RateLimitService(limiter, await store()).check(request);

    expect(outcome.allowed).toBe(false);
    // The tenant bucket is never touched once the user bucket has said no.
    expect(consume).toHaveBeenCalledTimes(1);
    expect(consume.mock.calls[0]?.[0]).toMatchObject({ type: 'user_tool' });
  });

  it('checks the tenant bucket when the user bucket admits the call', async () => {
    const { limiter, consume } = limiterStub([verdict(true, 'user'), verdict(true, 'tenant')]);
    const outcome = await new RateLimitService(limiter, await store()).check(request);

    expect(outcome.allowed).toBe(true);
    expect(consume).toHaveBeenCalledTimes(2);
    expect(outcome.checked).toHaveLength(2);
    // The reported verdict is the user bucket, whose remaining count is the one
    // a client can act on.
    expect(outcome.verdict.scope).toBe('user');
  });

  it('reports the tenant verdict when the tenant bucket is the one that denies', async () => {
    const { limiter } = limiterStub([verdict(true, 'user'), verdict(false, 'tenant')]);
    const outcome = await new RateLimitService(limiter, await store()).check(request);

    expect(outcome.allowed).toBe(false);
    expect(outcome.verdict.scope).toBe('tenant');
    expect(outcome.verdict.retryAfterMs).toBe(1_000);
  });

  it('passes the requested cost and tier through', async () => {
    const { limiter, consume } = limiterStub([verdict(true, 'user'), verdict(true, 'tenant')]);
    await new RateLimitService(limiter, await store()).check({ ...request, cost: 5, tier: 'burst' });

    expect(consume.mock.calls[0]?.[2]).toBe(5);
  });
});
