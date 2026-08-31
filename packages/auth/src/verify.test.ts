import { TokenExpiredError, UnauthenticatedError } from '@mcpgateway/shared';
import { beforeEach, describe, expect, it } from 'vitest';

import { createTestKey, jwksResponse, type TestKey } from './__fixtures__/tokens.js';
import { JwksCache } from './jwks-cache.js';
import {
  extractBearer,
  parseScope,
  principalFromClaims,
  remainingLifetimeSeconds,
  verifyAccessToken,
} from './verify.js';

const ISSUER = 'https://issuer.test';

const baseClaims = {
  jti: 'tok_1',
  tenant_id: 'acme-corp',
  role: 'analyst',
  scope: 'salesforce:read postgres:read',
  client_id: 'dashboard-bff',
  email: 'alice.chen@acme-corp.com',
  name: 'Alice Chen',
};

describe('verifyAccessToken', () => {
  let key: TestKey;
  let jwks: JwksCache;

  beforeEach(async () => {
    key = await createTestKey();
    jwks = new JwksCache({
      jwksUri: `${ISSUER}/jwks`,
      fetchImpl: async () => jwksResponse([key.jwk]),
      cooldownMs: 0,
    });
  });

  it('verifies a well-formed token and projects a principal', async () => {
    const token = await key.sign(baseClaims, { issuer: ISSUER, subject: 'usr_alice' });
    const { principal } = await verifyAccessToken(token, jwks, { issuer: ISSUER });

    expect(principal).toMatchObject({
      subject: 'usr_alice',
      tenantId: 'acme-corp',
      role: 'analyst',
      tokenId: 'tok_1',
      clientId: 'dashboard-bff',
      email: 'alice.chen@acme-corp.com',
    });
    expect(principal.scopes).toEqual(['salesforce:read', 'postgres:read']);
  });

  it('rejects an empty token', async () => {
    await expect(verifyAccessToken('', jwks, { issuer: ISSUER })).rejects.toThrow(
      UnauthenticatedError,
    );
  });

  it('rejects a token from another issuer', async () => {
    const token = await key.sign(baseClaims, { issuer: 'https://evil.test' });
    await expect(verifyAccessToken(token, jwks, { issuer: ISSUER })).rejects.toThrow(
      UnauthenticatedError,
    );
  });

  it('rejects a token for a different audience', async () => {
    const token = await key.sign(baseClaims, { issuer: ISSUER, audience: 'mcp:salesforce' });
    await expect(
      verifyAccessToken(token, jwks, { issuer: ISSUER, audience: 'mcp:postgres' }),
    ).rejects.toThrow(UnauthenticatedError);
  });

  it('accepts a token for the expected audience', async () => {
    const token = await key.sign(baseClaims, { issuer: ISSUER, audience: 'mcp:postgres' });
    await expect(
      verifyAccessToken(token, jwks, { issuer: ISSUER, audience: 'mcp:postgres' }),
    ).resolves.toBeDefined();
  });

  it('reports expiry distinctly from a generic failure', async () => {
    const token = await key.sign(baseClaims, { issuer: ISSUER, expiresInSeconds: -120 });
    await expect(verifyAccessToken(token, jwks, { issuer: ISSUER })).rejects.toThrow(
      TokenExpiredError,
    );
  });

  it('rejects a token signed by a key that is not published', async () => {
    const rogue = await createTestKey();
    const token = await rogue.sign(baseClaims, { issuer: ISSUER });
    await expect(verifyAccessToken(token, jwks, { issuer: ISSUER })).rejects.toThrow();
  });
});

describe('principalFromClaims', () => {
  it('requires a subject', () => {
    expect(() => principalFromClaims({ tenant_id: 't', jti: 'j' })).toThrow(/no subject/);
  });

  it('requires a tenant', () => {
    expect(() => principalFromClaims({ sub: 's', jti: 'j' })).toThrow(/tenant_id/);
  });

  it('requires a jti so an audit row can name the credential', () => {
    expect(() => principalFromClaims({ sub: 's', tenant_id: 't' })).toThrow(/jti/);
  });

  it('falls back to the least privileged role when the claim is unrecognised', () => {
    const principal = principalFromClaims({
      sub: 's',
      tenant_id: 't',
      jti: 'j',
      role: 'superuser',
    });
    expect(principal.role).toBe('viewer');
  });

  it('defaults an absent client_id rather than throwing', () => {
    const principal = principalFromClaims({ sub: 's', tenant_id: 't', jti: 'j' });
    expect(principal.clientId).toBe('unknown');
    expect(principal.expiresAt).toBe(0);
  });
});

describe('parseScope', () => {
  it('splits a space-delimited string', () => {
    expect(parseScope('a b  c')).toEqual(['a', 'b', 'c']);
  });

  it('accepts an array', () => {
    expect(parseScope(['a', 'b'])).toEqual(['a', 'b']);
  });

  it('drops non-string array entries', () => {
    expect(parseScope(['a', 3, null])).toEqual(['a']);
  });

  it('returns empty for anything else', () => {
    expect(parseScope(undefined)).toEqual([]);
    expect(parseScope(42)).toEqual([]);
  });
});

describe('extractBearer', () => {
  it('extracts a bearer token case-insensitively', () => {
    expect(extractBearer('Bearer abc')).toBe('abc');
    expect(extractBearer('bearer abc')).toBe('abc');
  });

  it('ignores other schemes and empty values', () => {
    expect(extractBearer('Basic abc')).toBeUndefined();
    expect(extractBearer('Bearer   ')).toBeUndefined();
    expect(extractBearer(undefined)).toBeUndefined();
  });
});

describe('remainingLifetimeSeconds', () => {
  it('reports seconds left and floors at zero', () => {
    const now = 1_700_000_000_000;
    expect(remainingLifetimeSeconds(1_700_000_060, now)).toBe(60);
    expect(remainingLifetimeSeconds(1_699_999_000, now)).toBe(0);
  });
});
