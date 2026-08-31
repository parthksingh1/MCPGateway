import { calculateJwkThumbprint, exportJWK, generateKeyPair, SignJWT, type JWK } from 'jose';

export interface TestKey {
  readonly kid: string;
  readonly jwk: JWK;
  sign(claims: Record<string, unknown>, overrides?: SignOverrides): Promise<string>;
}

export interface SignOverrides {
  readonly issuer?: string;
  readonly audience?: string;
  readonly subject?: string;
  readonly expiresInSeconds?: number;
  readonly kid?: string;
  readonly notBeforeOffset?: number;
}

export async function createTestKey(): Promise<TestKey> {
  const { privateKey, publicKey } = await generateKeyPair('RS256', { extractable: true });
  const publicJwk = await exportJWK(publicKey);
  const kid = await calculateJwkThumbprint(publicJwk, 'sha256');
  const jwk: JWK = { ...publicJwk, kid, alg: 'RS256', use: 'sig' };

  return {
    kid,
    jwk,
    sign: async (claims, overrides = {}) => {
      const now = Math.floor(Date.now() / 1000);
      const expiresIn = overrides.expiresInSeconds ?? 300;
      return new SignJWT(claims)
        .setProtectedHeader({ alg: 'RS256', kid: overrides.kid ?? kid })
        .setIssuer(overrides.issuer ?? 'https://issuer.test')
        .setAudience(overrides.audience ?? 'test-audience')
        .setSubject(overrides.subject ?? 'usr_test')
        .setIssuedAt(now)
        .setNotBefore(now + (overrides.notBeforeOffset ?? 0))
        .setExpirationTime(now + expiresIn)
        .sign(privateKey);
    },
  };
}

export function jwksResponse(keys: JWK[]): Response {
  return new Response(JSON.stringify({ keys }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

/** In-memory stand-in for the Redis slice `TokenExchangeService` depends on. */
export class MemoryCache {
  readonly entries = new Map<string, { value: string; expiresAt: number }>();
  public failOnGet = false;
  public failOnSet = false;
  public getCalls = 0;
  public setCalls = 0;

  async get(key: string): Promise<string | null> {
    this.getCalls += 1;
    if (this.failOnGet) throw new Error('cache unavailable');
    const entry = this.entries.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= Date.now()) {
      this.entries.delete(key);
      return null;
    }
    return entry.value;
  }

  async set(key: string, value: string, _mode: 'EX', ttlSeconds: number): Promise<'OK'> {
    this.setCalls += 1;
    if (this.failOnSet) throw new Error('cache unavailable');
    this.entries.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1000 });
    return 'OK';
  }

  async del(key: string): Promise<number> {
    return this.entries.delete(key) ? 1 : 0;
  }

  ttlSeconds(key: string): number | null {
    const entry = this.entries.get(key);
    if (!entry) return null;
    return Math.round((entry.expiresAt - Date.now()) / 1000);
  }
}
