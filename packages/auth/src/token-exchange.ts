import {
  PermissionMirrorError,
  scopeDigest,
  sha256Hex,
  type Principal,
  isGatewayError,
} from '@mcpgateway/shared';
import {
  tokenExchangeLatency,
  tokenExchangeTotal,
  GatewayAttr,
  annotate,
} from '@mcpgateway/telemetry';
import { decodeJwt } from 'jose';

import type { OAuthClient } from './oauth-client.js';

/** Minimal slice of a Redis client, so tests can supply an in-memory double. */
export interface TokenCacheStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, mode: 'EX', ttlSeconds: number): Promise<unknown>;
  del(key: string): Promise<unknown>;
}

export interface MirroredToken {
  readonly accessToken: string;
  readonly audience: string;
  readonly scopes: readonly string[];
  readonly expiresAt: number;
  readonly subject: string;
  readonly cached: boolean;
  readonly latencyMs: number;
}

export interface TokenExchangeOptions {
  readonly client: OAuthClient;
  readonly cache: TokenCacheStore;
  /**
   * Issuer these tokens are minted by. Folded into the cache key so that
   * repointing the gateway at a different provider cannot serve tokens the new
   * provider's downstream services will refuse — the subject, audience and
   * scopes would otherwise be identical and the stale entry would be a hit.
   */
  readonly issuer?: string;
  /** Upper bound on how long an exchanged token may be reused. */
  readonly maxTtlSeconds?: number;
  /** Refresh this many seconds before expiry so a cached token never lands expired. */
  readonly earlyRefreshSeconds?: number;
  readonly keyPrefix?: string;
}

interface CacheEntry {
  readonly t: string;
  readonly a: string;
  readonly s: string[];
  readonly e: number;
}

/**
 * Permission mirroring.
 *
 * Every outbound call carries a token minted for the human who made the
 * request, addressed to exactly one downstream service. There is deliberately
 * no service-account path in this class: if the exchange fails, the caller gets
 * a `PermissionMirrorError` and the request is refused. Falling back to a
 * shared credential would hand the caller the union of every user's
 * permissions, which is the exact failure mode this gateway exists to remove.
 *
 * Exchanged tokens are cached in Redis under `sub:audience:scope_digest` for
 * at most `maxTtlSeconds`, bounded by the token's own remaining lifetime. The
 * cache is keyed by subject, so it can never serve one user's token to another.
 */
export class TokenExchangeService {
  private readonly client: OAuthClient;
  private readonly cache: TokenCacheStore;
  private readonly maxTtlSeconds: number;
  private readonly earlyRefreshSeconds: number;
  private readonly keyPrefix: string;
  private readonly inFlight = new Map<string, Promise<MirroredToken>>();

  constructor(options: TokenExchangeOptions) {
    this.client = options.client;
    this.cache = options.cache;
    this.maxTtlSeconds = options.maxTtlSeconds ?? 300;
    this.earlyRefreshSeconds = options.earlyRefreshSeconds ?? 10;
    // A short digest rather than the issuer itself: the key stays compact and
    // does not carry a URL into every Redis key name.
    const issuerTag = options.issuer ? `:${sha256Hex(options.issuer).slice(0, 8)}` : '';
    this.keyPrefix = `${options.keyPrefix ?? 'tex'}${issuerTag}`;
  }

  cacheKey(subject: string, audience: string, scopes: readonly string[]): string {
    return `${this.keyPrefix}:${subject}:${audience}:${scopeDigest(scopes)}`;
  }

  /**
   * Return a downstream token for `principal` addressed to `audience`.
   * Concurrent callers asking for the same key share one exchange.
   */
  async mint(input: {
    principal: Principal;
    subjectToken: string;
    audience: string;
    scopes: readonly string[];
  }): Promise<MirroredToken> {
    const { principal, audience, scopes } = input;
    const key = this.cacheKey(principal.subject, audience, scopes);
    const startedAt = performance.now();

    const cached = await this.readCache(key, audience, startedAt);
    if (cached) {
      tokenExchangeTotal.add(1, { cached: true, audience, outcome: 'hit' });
      tokenExchangeLatency.record(cached.latencyMs, { cached: true, audience });
      annotate({
        [GatewayAttr.TOKEN_EXCHANGE_CACHED]: true,
        [GatewayAttr.TOKEN_AUDIENCE]: audience,
      });
      return cached;
    }

    const existing = this.inFlight.get(key);
    if (existing) return existing;

    const pending = this.performExchange(input, key, startedAt).finally(() => {
      this.inFlight.delete(key);
    });
    this.inFlight.set(key, pending);
    return pending;
  }

  private async readCache(
    key: string,
    audience: string,
    startedAt: number,
  ): Promise<MirroredToken | null> {
    let raw: string | null;
    try {
      raw = await this.cache.get(key);
    } catch {
      // A cache outage must not take authorisation with it: fall through and
      // perform the exchange.
      return null;
    }
    if (!raw) return null;

    let entry: CacheEntry;
    try {
      entry = JSON.parse(raw) as CacheEntry;
    } catch {
      await this.cache.del(key).catch(() => undefined);
      return null;
    }

    const nowSeconds = Math.floor(Date.now() / 1000);
    if (entry.e - this.earlyRefreshSeconds <= nowSeconds) return null;

    return {
      accessToken: entry.t,
      audience,
      scopes: entry.s,
      expiresAt: entry.e,
      subject: entry.a,
      cached: true,
      latencyMs: performance.now() - startedAt,
    };
  }

  private async performExchange(
    input: {
      principal: Principal;
      subjectToken: string;
      audience: string;
      scopes: readonly string[];
    },
    key: string,
    startedAt: number,
  ): Promise<MirroredToken> {
    const { principal, subjectToken, audience, scopes } = input;

    let response: Awaited<ReturnType<OAuthClient['exchangeToken']>>;
    try {
      response = await this.client.exchangeToken({ subjectToken, audience, scopes });
    } catch (error) {
      tokenExchangeTotal.add(1, { cached: false, audience, outcome: 'error' });
      const detail = isGatewayError(error) ? error.message : 'token exchange failed';
      throw new PermissionMirrorError(
        `Could not mint a downstream token for '${audience}' on behalf of ${principal.subject}. The request was refused rather than falling back to a shared credential.`,
        { audience, subject: principal.subject, detail },
        error,
      );
    }

    const grantedScopes = response.scope ? response.scope.split(' ').filter(Boolean) : [...scopes];
    const claims = decodeJwt(response.access_token);

    // The exchanged token must still name the original caller. A provider that
    // returns a different subject has broken the mirroring contract, and
    // continuing would silently act as somebody else.
    if (claims.sub !== principal.subject) {
      tokenExchangeTotal.add(1, { cached: false, audience, outcome: 'subject_mismatch' });
      throw new PermissionMirrorError('Exchanged token names a different subject than the caller', {
        expected: principal.subject,
        received: String(claims.sub ?? 'none'),
        audience,
      });
    }

    const expiresAt =
      typeof claims.exp === 'number'
        ? claims.exp
        : Math.floor(Date.now() / 1000) + (response.expires_in ?? 60);

    const latencyMs = performance.now() - startedAt;
    const token: MirroredToken = {
      accessToken: response.access_token,
      audience,
      scopes: grantedScopes,
      expiresAt,
      subject: principal.subject,
      cached: false,
      latencyMs,
    };

    await this.writeCache(key, token);

    tokenExchangeTotal.add(1, { cached: false, audience, outcome: 'minted' });
    tokenExchangeLatency.record(latencyMs, { cached: false, audience });
    annotate({
      [GatewayAttr.TOKEN_EXCHANGE_CACHED]: false,
      [GatewayAttr.TOKEN_AUDIENCE]: audience,
    });

    return token;
  }

  private async writeCache(key: string, token: MirroredToken): Promise<void> {
    const remaining = token.expiresAt - Math.floor(Date.now() / 1000) - this.earlyRefreshSeconds;
    const ttl = Math.min(this.maxTtlSeconds, remaining);
    if (ttl <= 0) return;

    const entry: CacheEntry = {
      t: token.accessToken,
      a: token.subject,
      s: [...token.scopes],
      e: token.expiresAt,
    };
    try {
      await this.cache.set(key, JSON.stringify(entry), 'EX', ttl);
    } catch {
      // Losing the cache write only costs a round trip next time.
    }
  }

  /** Drop a subject's cached token for one audience, e.g. after a role change. */
  async invalidate(subject: string, audience: string, scopes: readonly string[]): Promise<void> {
    await this.cache.del(this.cacheKey(subject, audience, scopes)).catch(() => undefined);
  }
}
