import { UpstreamUnavailableError } from '@mcpgateway/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createTestKey, jwksResponse, type TestKey } from './__fixtures__/tokens.js';
import { JwksCache } from './jwks-cache.js';

const URI = 'https://issuer.test/jwks';

describe('JwksCache', () => {
  let keyA: TestKey;
  let keyB: TestKey;

  beforeEach(async () => {
    [keyA, keyB] = await Promise.all([createTestKey(), createTestKey()]);
  });

  it('fetches once and serves subsequent lookups from memory', async () => {
    const fetchImpl = vi.fn(async () => jwksResponse([keyA.jwk]));
    const cache = new JwksCache({ jwksUri: URI, fetchImpl });

    await cache.getKey(keyA.kid);
    await cache.getKey(keyA.kid);
    await cache.getKey(keyA.kid);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(cache.getStats().hits).toBe(2);
  });

  it('refetches when an unknown kid arrives, picking up a rotated key', async () => {
    let published = [keyA.jwk];
    const fetchImpl = vi.fn(async () => jwksResponse(published));
    const cache = new JwksCache({ jwksUri: URI, fetchImpl, cooldownMs: 0 });

    await cache.getKey(keyA.kid);
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    published = [keyB.jwk, keyA.jwk];
    await expect(cache.getKey(keyB.kid)).resolves.toBeDefined();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('does not refetch on repeated unknown kids inside the cooldown', async () => {
    const fetchImpl = vi.fn(async () => jwksResponse([keyA.jwk]));
    const cache = new JwksCache({ jwksUri: URI, fetchImpl, cooldownMs: 60_000 });

    await cache.getKey(keyA.kid);
    await expect(cache.getKey('unknown-kid-1')).rejects.toThrow(UpstreamUnavailableError);
    await expect(cache.getKey('unknown-kid-2')).rejects.toThrow(UpstreamUnavailableError);

    // One initial fetch only: the cooldown absorbs the bogus-kid traffic.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('collapses concurrent refreshes into a single request', async () => {
    let resolveFetch: ((value: Response) => void) | undefined;
    const fetchImpl = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          resolveFetch = resolve;
        }),
    );
    const cache = new JwksCache({ jwksUri: URI, fetchImpl });

    const pending = [cache.getKey(keyA.kid), cache.getKey(keyA.kid), cache.getKey(keyA.kid)];
    await vi.waitFor(() => expect(resolveFetch).toBeDefined());
    resolveFetch?.(jwksResponse([keyA.jwk]));

    await Promise.all(pending);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('keeps serving the previous key set when the provider is unreachable', async () => {
    let mode: 'ok' | 'fail' = 'ok';
    const fetchImpl = vi.fn(async () => {
      if (mode === 'fail') throw new Error('connection refused');
      return jwksResponse([keyA.jwk]);
    });
    const cache = new JwksCache({ jwksUri: URI, fetchImpl, ttlMs: 0, cooldownMs: 0 });

    await cache.getKey(keyA.kid);
    mode = 'fail';
    await expect(cache.getKey(keyA.kid)).resolves.toBeDefined();
  });

  it('fails when the provider is unreachable and nothing is cached', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('connection refused');
    });
    const cache = new JwksCache({ jwksUri: URI, fetchImpl });
    await expect(cache.getKey(keyA.kid)).rejects.toThrow(UpstreamUnavailableError);
  });

  it('rejects a non-200 key set response', async () => {
    const fetchImpl = vi.fn(async () => new Response('nope', { status: 500 }));
    const cache = new JwksCache({ jwksUri: URI, fetchImpl });
    await expect(cache.getKey(keyA.kid)).rejects.toThrow(/500/);
  });

  it('rejects a response without a key array', async () => {
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ nope: true }), { status: 200 }),
    );
    const cache = new JwksCache({ jwksUri: URI, fetchImpl });
    await expect(cache.getKey(keyA.kid)).rejects.toThrow(/no key set/);
  });

  it('ignores symmetric keys published in a key set', async () => {
    const symmetric = { kty: 'oct', k: 'c2VjcmV0LXZhbHVl', kid: 'sym-1', alg: 'HS256' };
    const fetchImpl = vi.fn(async () => jwksResponse([symmetric, keyA.jwk]));
    const cache = new JwksCache({ jwksUri: URI, fetchImpl, cooldownMs: 0 });

    await expect(cache.getKey('sym-1')).rejects.toThrow(/no key matching/);
    await expect(cache.getKey(keyA.kid)).resolves.toBeDefined();
  });

  it('rejects a token header with no kid', async () => {
    const cache = new JwksCache({ jwksUri: URI, fetchImpl: async () => jwksResponse([keyA.jwk]) });
    await expect(cache.getKey(undefined)).rejects.toThrow(/no kid/);
  });

  it('refetches after the freshness window expires', async () => {
    const fetchImpl = vi.fn(async () => jwksResponse([keyA.jwk]));
    const cache = new JwksCache({ jwksUri: URI, fetchImpl, ttlMs: 0, cooldownMs: 0 });

    await cache.getKey(keyA.kid);
    await cache.getKey(keyA.kid);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('reports stats and clears on demand', async () => {
    const fetchImpl = vi.fn(async () => jwksResponse([keyA.jwk]));
    const cache = new JwksCache({ jwksUri: URI, fetchImpl });

    await cache.getKey(keyA.kid);
    expect(cache.getStats()).toMatchObject({ fetches: 1, keys: 1, misses: 1 });
    expect(cache.getStats().lastFetchedAt).not.toBeNull();

    cache.clear();
    expect(cache.getStats()).toMatchObject({ keys: 0, lastFetchedAt: null });
  });

  it('respects an explicit forced refresh', async () => {
    const fetchImpl = vi.fn(async () => jwksResponse([keyA.jwk]));
    const cache = new JwksCache({ jwksUri: URI, fetchImpl, cooldownMs: 60_000 });

    await cache.refresh();
    await cache.refresh();
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    await cache.refresh(true);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});
