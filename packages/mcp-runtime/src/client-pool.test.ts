import { describe, expect, it, vi } from 'vitest';

import { UpstreamClientPool, type PooledUpstream } from './client-pool.js';

/**
 * These tests exercise the pool's checkout discipline directly, without an MCP
 * server, because the property that matters is not "does a call succeed" but
 * "can two callers ever hold the same entry". That is a question about this
 * class, and mocking the transport to answer it would only test the mock.
 */

interface Fake {
  id: number;
  closed: boolean;
  headers: Record<string, string>;
}

/** A pool whose entries are cheap fakes, so checkout behaviour is observable. */
class TestPool extends UpstreamClientPool {
  public created = 0;
  public discarded: number[] = [];
  private readonly fakes = new Map<object, Fake>();

  protected override async build(url: string, headers: Record<string, string>) {
    this.created += 1;
    const state = { headers };
    const fake: Fake = { id: this.created, closed: false, headers };
    const entry = {
      url,
      client: { close: async () => undefined } as never,
      transport: { close: async () => undefined } as never,
      get headers() {
        return state.headers;
      },
      set headers(next: Record<string, string>) {
        state.headers = next;
      },
      onDiscard: () => {
        fake.closed = true;
        this.discarded.push(fake.id);
      },
    };
    this.fakes.set(entry, fake);
    return entry;
  }
}

describe('UpstreamClientPool checkout discipline', () => {
  it('hands an entry to exactly one caller at a time', async () => {
    const pool = new TestPool();
    const holders: number[] = [];
    let concurrentHolders = 0;
    let maxConcurrent = 0;

    const use = async (token: string): Promise<void> => {
      await pool.withClient('http://target/mcp', { authorization: token }, async (upstream) => {
        concurrentHolders += 1;
        maxConcurrent = Math.max(maxConcurrent, concurrentHolders);
        // While held, the entry must carry this caller's credential and no other.
        expect(upstream.headers.authorization).toBe(token);
        await new Promise((resolve) => setTimeout(resolve, 5));
        expect(upstream.headers.authorization).toBe(token);
        holders.push(1);
        concurrentHolders -= 1;
      });
    };

    // Ten concurrent callers with ten different tokens.
    await Promise.all(Array.from({ length: 10 }, (_, i) => use(`Bearer token-${i}`)));

    expect(holders).toHaveLength(10);
    // Each caller saw its own token throughout; the assertions above would have
    // failed otherwise.
    expect(maxConcurrent).toBeGreaterThan(1);
  });

  it('reuses an entry rather than rebuilding it', async () => {
    const pool = new TestPool();

    for (let i = 0; i < 5; i += 1) {
      await pool.withClient('http://target/mcp', { authorization: `t${i}` }, async () => undefined);
    }

    // Serial calls: one entry, built once.
    expect(pool.created).toBe(1);
  });

  it('keeps destinations separate', async () => {
    const pool = new TestPool();
    await pool.withClient('http://a/mcp', {}, async () => undefined);
    await pool.withClient('http://b/mcp', {}, async () => undefined);
    await pool.withClient('http://a/mcp', {}, async () => undefined);

    expect(pool.created).toBe(2);
    expect(Object.keys(pool.stats()).sort()).toEqual(['http://a/mcp', 'http://b/mcp']);
  });

  it('clears the credential when an entry returns to the pool', async () => {
    const pool = new TestPool();
    let captured: PooledUpstream | null = null;

    await pool.withClient('http://target/mcp', { authorization: 'secret' }, async (upstream) => {
      captured = upstream;
    });

    // An idle entry holds nothing. Even though nothing can read it before the
    // next checkout, leaving a live token sitting in a pool is not a habit
    // worth having.
    expect(captured).not.toBeNull();
    expect((captured as unknown as PooledUpstream).headers).toEqual({});
  });

  it('discards an entry whose call failed instead of returning it', async () => {
    const pool = new TestPool();

    await expect(
      pool.withClient('http://target/mcp', {}, async () => {
        throw new Error('upstream exploded');
      }),
    ).rejects.toThrow('upstream exploded');

    // Nothing idle: the entry was thrown away, not reused.
    expect(pool.stats()['http://target/mcp'] ?? 0).toBe(0);

    await pool.withClient('http://target/mcp', {}, async () => undefined);
    expect(pool.created).toBe(2);
  });

  it('bounds how many idle entries it keeps', async () => {
    const pool = new TestPool({ maxIdlePerTarget: 2 });

    // Four concurrent callers force four entries to exist at once.
    await Promise.all(
      Array.from({ length: 4 }, () =>
        pool.withClient('http://target/mcp', {}, async () => {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }),
      ),
    );

    expect(pool.created).toBe(4);
    expect(pool.stats()['http://target/mcp'] ?? 0).toBeLessThanOrEqual(2);
  });

  it('closes everything on shutdown and stops accepting returns', async () => {
    const pool = new TestPool();
    await pool.withClient('http://target/mcp', {}, async () => undefined);
    expect(pool.stats()['http://target/mcp']).toBe(1);

    await pool.close();
    expect(pool.stats()).toEqual({});

    // A call that lands after shutdown does not repopulate the pool.
    await pool.withClient('http://target/mcp', {}, async () => undefined);
    expect(pool.stats()['http://target/mcp'] ?? 0).toBe(0);
  });

  it('propagates the call result', async () => {
    const pool = new TestPool();
    const fn = vi.fn(async () => ({ ok: true }));
    await expect(pool.withClient('http://target/mcp', {}, fn)).resolves.toEqual({ ok: true });
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
