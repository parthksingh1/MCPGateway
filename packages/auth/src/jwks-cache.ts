import { UpstreamUnavailableError } from '@mcpgateway/shared';
import { importJWK, type JWK, type KeyLike } from 'jose';

export interface JwksCacheOptions {
  readonly jwksUri: string;
  /** How long a successful fetch is considered fresh. */
  readonly ttlMs?: number;
  /**
   * Minimum gap between refetches triggered by an unknown `kid`. Without this,
   * a flood of requests carrying a bogus kid turns into a fetch storm against
   * the identity provider — a self-inflicted denial of service.
   */
  readonly cooldownMs?: number;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
}

export interface JwksCacheStats {
  readonly fetches: number;
  readonly hits: number;
  readonly misses: number;
  readonly keys: number;
  readonly lastFetchedAt: number | null;
}

/**
 * Caches an identity provider's JWKS in memory and re-fetches on demand.
 *
 * Verification happens on every inbound request, so this sits on the hot path.
 * Two behaviours matter:
 *   - a `kid` that is not in the cache triggers exactly one refetch, rate
 *     limited by `cooldownMs`, which is what lets the provider rotate keys
 *     without any coordinated restart;
 *   - concurrent refreshes share a single in-flight promise rather than each
 *     issuing their own request.
 */
export class JwksCache {
  private readonly jwksUri: string;
  private readonly ttlMs: number;
  private readonly cooldownMs: number;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  private keys = new Map<string, KeyLike>();
  private fetchedAt = 0;
  private lastAttemptAt = 0;
  private inFlight: Promise<void> | null = null;
  private stats = { fetches: 0, hits: 0, misses: 0 };

  constructor(options: JwksCacheOptions) {
    this.jwksUri = options.jwksUri;
    this.ttlMs = options.ttlMs ?? 5 * 60_000;
    this.cooldownMs = options.cooldownMs ?? 10_000;
    this.timeoutMs = options.timeoutMs ?? 3_000;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  /** Resolve a verification key for `kid`, refetching once if it is unknown. */
  async getKey(kid: string | undefined): Promise<KeyLike> {
    if (kid === undefined) {
      throw new UpstreamUnavailableError('jwks: token header carries no kid');
    }

    const expired = Date.now() - this.fetchedAt >= this.ttlMs;
    if (!expired) {
      const cached = this.keys.get(kid);
      if (cached) {
        this.stats.hits += 1;
        return cached;
      }
    }

    this.stats.misses += 1;
    await this.refresh();

    const key = this.keys.get(kid);
    if (!key) {
      throw new UpstreamUnavailableError(`jwks: no key matching kid '${kid}'`);
    }
    return key;
  }

  /** Force a refresh, respecting the cooldown unless `force` is set. */
  async refresh(force = false): Promise<void> {
    if (!force && Date.now() - this.lastAttemptAt < this.cooldownMs && this.keys.size > 0) {
      return;
    }
    if (this.inFlight) return this.inFlight;

    this.lastAttemptAt = Date.now();
    this.inFlight = this.doFetch().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  private async doFetch(): Promise<void> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(this.jwksUri, {
        signal: controller.signal,
        headers: { accept: 'application/json' },
      });
      if (!response.ok) {
        throw new UpstreamUnavailableError(`jwks: ${response.status} from ${this.jwksUri}`);
      }
      const body = (await response.json()) as { keys?: JWK[] };
      if (!Array.isArray(body.keys)) {
        throw new UpstreamUnavailableError('jwks: response has no key set');
      }

      const next = new Map<string, KeyLike>();
      for (const jwk of body.keys) {
        if (typeof jwk.kid !== 'string') continue;
        const imported = await importJWK(jwk, jwk.alg ?? 'RS256');
        // A symmetric key in a published key set would mean the signing secret
        // is public. Refuse it rather than silently trusting it.
        if (imported instanceof Uint8Array) continue;
        next.set(jwk.kid, imported);
      }

      this.keys = next;
      this.fetchedAt = Date.now();
      this.stats.fetches += 1;
    } catch (error) {
      if (this.keys.size > 0) {
        // Serve the previous key set rather than rejecting every request while
        // the provider is briefly unreachable. Keys outlive a blip.
        return;
      }
      throw error instanceof UpstreamUnavailableError
        ? error
        : new UpstreamUnavailableError('jwks', error);
    } finally {
      clearTimeout(timer);
    }
  }

  getStats(): JwksCacheStats {
    return {
      ...this.stats,
      keys: this.keys.size,
      lastFetchedAt: this.fetchedAt === 0 ? null : this.fetchedAt,
    };
  }

  /** Test seam: drop everything so the next lookup refetches. */
  clear(): void {
    this.keys = new Map();
    this.fetchedAt = 0;
    this.lastAttemptAt = 0;
  }
}
