import { PermissionMirrorError, type Principal } from '@mcpgateway/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createTestKey, MemoryCache, type TestKey } from './__fixtures__/tokens.js';
import { OAuthClient } from './oauth-client.js';
import { TokenExchangeService } from './token-exchange.js';

const ISSUER = 'http://localhost:9000';

const principal: Principal = {
  subject: 'usr_alice',
  tenantId: 'acme-corp',
  role: 'analyst',
  scopes: ['salesforce:read', 'postgres:read'],
  tokenId: 'tok_1',
  clientId: 'dashboard-bff',
  expiresAt: Math.floor(Date.now() / 1000) + 900,
};

function discovery(): Response {
  return new Response(
    JSON.stringify({
      issuer: ISSUER,
      authorization_endpoint: `${ISSUER}/authorize`,
      token_endpoint: `${ISSUER}/token`,
      jwks_uri: `${ISSUER}/jwks`,
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

interface Harness {
  service: TokenExchangeService;
  cache: MemoryCache;
  exchanges: () => number;
  setNextToken(token: string, expiresIn?: number, scope?: string): void;
  failNext(status: number, error: string): void;
}

async function createHarness(
  key: TestKey,
  options: { subject?: string; maxTtlSeconds?: number } = {},
): Promise<Harness> {
  let exchangeCount = 0;
  let override: { token: string; expiresIn: number; scope: string } | null = null;
  let failure: { status: number; error: string } | null = null;

  const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (!url.endsWith('/token')) return discovery();
    exchangeCount += 1;
    if (failure) {
      const body = JSON.stringify({ error: failure.error, error_description: failure.error });
      const status = failure.status;
      failure = null;
      return new Response(body, { status, headers: { 'content-type': 'application/json' } });
    }
    const token =
      override?.token ??
      (await key.sign(
        { scope: 'salesforce:read', tenant_id: 'acme-corp' },
        {
          issuer: ISSUER,
          subject: options.subject ?? principal.subject,
          audience: 'mcp:salesforce',
          expiresInSeconds: override?.expiresIn ?? 300,
        },
      ));
    const payload = {
      access_token: token,
      token_type: 'Bearer',
      expires_in: override?.expiresIn ?? 300,
      scope: override?.scope ?? 'salesforce:read',
    };
    override = null;
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;

  const client = new OAuthClient({
    issuer: ISSUER,
    clientId: 'mcp-gateway',
    clientSecret: 'shh',
    fetchImpl,
  });
  const cache = new MemoryCache();
  const service = new TokenExchangeService({
    client,
    cache,
    ...(options.maxTtlSeconds === undefined ? {} : { maxTtlSeconds: options.maxTtlSeconds }),
  });

  return {
    service,
    cache,
    exchanges: () => exchangeCount,
    setNextToken: (token, expiresIn = 300, scope = 'salesforce:read') => {
      override = { token, expiresIn, scope };
    },
    failNext: (status, error) => {
      failure = { status, error };
    },
  };
}

describe('TokenExchangeService', () => {
  let key: TestKey;

  beforeEach(async () => {
    key = await createTestKey();
  });

  it('mints a downstream token that still names the caller', async () => {
    const { service } = await createHarness(key);
    const token = await service.mint({
      principal,
      subjectToken: 'caller-token',
      audience: 'mcp:salesforce',
      scopes: ['salesforce:read'],
    });

    expect(token.subject).toBe('usr_alice');
    expect(token.audience).toBe('mcp:salesforce');
    expect(token.scopes).toEqual(['salesforce:read']);
    expect(token.cached).toBe(false);
  });

  it('serves a repeat call from cache without touching the provider', async () => {
    const { service, exchanges } = await createHarness(key);
    const input = {
      principal,
      subjectToken: 'caller-token',
      audience: 'mcp:salesforce',
      scopes: ['salesforce:read'],
    };

    await service.mint(input);
    const second = await service.mint(input);

    expect(second.cached).toBe(true);
    expect(exchanges()).toBe(1);
  });

  it('keys the cache by subject, so one user never receives another user token', async () => {
    const { service, cache } = await createHarness(key);
    const other: Principal = { ...principal, subject: 'usr_bob' };

    const aliceKey = service.cacheKey('usr_alice', 'mcp:salesforce', ['salesforce:read']);
    const bobKey = service.cacheKey(other.subject, 'mcp:salesforce', ['salesforce:read']);
    expect(aliceKey).not.toBe(bobKey);

    await service.mint({
      principal,
      subjectToken: 'caller-token',
      audience: 'mcp:salesforce',
      scopes: ['salesforce:read'],
    });
    expect(cache.entries.has(aliceKey)).toBe(true);
    expect(cache.entries.has(bobKey)).toBe(false);
  });

  it('ignores scope ordering when building the cache key', async () => {
    const { service } = await createHarness(key);
    expect(service.cacheKey('u', 'a', ['x', 'y'])).toBe(service.cacheKey('u', 'a', ['y', 'x']));
    expect(service.cacheKey('u', 'a', ['x'])).not.toBe(service.cacheKey('u', 'a', ['x', 'y']));
  });

  it('caps the cache entry at the configured maximum lifetime', async () => {
    const { service, cache } = await createHarness(key, { maxTtlSeconds: 60 });
    await service.mint({
      principal,
      subjectToken: 'caller-token',
      audience: 'mcp:salesforce',
      scopes: ['salesforce:read'],
    });

    const cacheKey = service.cacheKey('usr_alice', 'mcp:salesforce', ['salesforce:read']);
    const ttl = cache.ttlSeconds(cacheKey);
    expect(ttl).not.toBeNull();
    expect(ttl ?? 0).toBeLessThanOrEqual(60);
  });

  it('never caches beyond the token own remaining lifetime', async () => {
    const harness = await createHarness(key, { maxTtlSeconds: 300 });
    const shortLived = await key.sign(
      { scope: 'salesforce:read' },
      { issuer: ISSUER, subject: principal.subject, expiresInSeconds: 30 },
    );
    harness.setNextToken(shortLived, 30);

    await harness.service.mint({
      principal,
      subjectToken: 'caller-token',
      audience: 'mcp:salesforce',
      scopes: ['salesforce:read'],
    });

    const cacheKey = harness.service.cacheKey('usr_alice', 'mcp:salesforce', ['salesforce:read']);
    expect(harness.cache.ttlSeconds(cacheKey) ?? 0).toBeLessThanOrEqual(30);
  });

  it('refuses a token whose subject does not match the caller', async () => {
    const harness = await createHarness(key);
    const impostor = await key.sign(
      { scope: 'salesforce:read' },
      { issuer: ISSUER, subject: 'usr_someone_else' },
    );
    harness.setNextToken(impostor);

    await expect(
      harness.service.mint({
        principal,
        subjectToken: 'caller-token',
        audience: 'mcp:salesforce',
        scopes: ['salesforce:read'],
      }),
    ).rejects.toThrow(PermissionMirrorError);
  });

  it('fails closed when the provider rejects the exchange', async () => {
    const harness = await createHarness(key);
    harness.failNext(400, 'invalid_scope');

    const error = await harness.service
      .mint({
        principal,
        subjectToken: 'caller-token',
        audience: 'mcp:salesforce',
        scopes: ['salesforce:read'],
      })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(PermissionMirrorError);
    expect((error as PermissionMirrorError).status).toBe(403);
    // No token is produced, and nothing resembling a shared credential is returned.
    expect((error as PermissionMirrorError).details).toMatchObject({
      audience: 'mcp:salesforce',
      subject: 'usr_alice',
    });
  });

  it('collapses concurrent requests for the same key into one exchange', async () => {
    const { service, exchanges } = await createHarness(key);
    const input = {
      principal,
      subjectToken: 'caller-token',
      audience: 'mcp:salesforce',
      scopes: ['salesforce:read'],
    };

    await Promise.all([service.mint(input), service.mint(input), service.mint(input)]);
    expect(exchanges()).toBe(1);
  });

  it('performs the exchange when the cache is unavailable rather than failing', async () => {
    const { service, cache } = await createHarness(key);
    cache.failOnGet = true;
    cache.failOnSet = true;

    const token = await service.mint({
      principal,
      subjectToken: 'caller-token',
      audience: 'mcp:salesforce',
      scopes: ['salesforce:read'],
    });
    expect(token.accessToken).toBeTruthy();
  });

  it('discards an unparseable cache entry and re-mints', async () => {
    const { service, cache, exchanges } = await createHarness(key);
    const cacheKey = service.cacheKey('usr_alice', 'mcp:salesforce', ['salesforce:read']);
    cache.entries.set(cacheKey, { value: 'not-json', expiresAt: Date.now() + 60_000 });

    await service.mint({
      principal,
      subjectToken: 'caller-token',
      audience: 'mcp:salesforce',
      scopes: ['salesforce:read'],
    });
    expect(exchanges()).toBe(1);
  });

  it('invalidates a cached token on demand', async () => {
    const { service, cache, exchanges } = await createHarness(key);
    const input = {
      principal,
      subjectToken: 'caller-token',
      audience: 'mcp:salesforce',
      scopes: ['salesforce:read'],
    };

    await service.mint(input);
    await service.invalidate('usr_alice', 'mcp:salesforce', ['salesforce:read']);
    await service.mint(input);

    expect(exchanges()).toBe(2);
    expect(cache.entries.size).toBe(1);
  });
});
