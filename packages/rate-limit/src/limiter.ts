import { readFile } from 'node:fs/promises';

import { rateLimitDecisions, rateLimitLatency, GatewayAttr, annotate } from '@mcpgateway/telemetry';

import { bucketKey, scopeLabel, type LimitScope } from './keys.js';

/** The slice of ioredis this limiter needs. Lets tests supply a double. */
export interface RedisScriptClient {
  script(subcommand: 'LOAD', script: string): Promise<unknown>;
  evalsha(sha: string, numKeys: number, ...args: (string | number)[]): Promise<unknown>;
  eval(script: string, numKeys: number, ...args: (string | number)[]): Promise<unknown>;
}

export interface BucketConfig {
  /** Largest burst admitted at once. */
  readonly capacity: number;
  /** Tokens returned every `refillIntervalMs`. */
  readonly refillTokens: number;
  readonly refillIntervalMs: number;
  readonly tier?: string;
}

export interface LimitVerdict {
  readonly allowed: boolean;
  readonly remaining: number;
  readonly limit: number;
  readonly retryAfterMs: number;
  readonly scope: string;
  readonly key: string;
}

export interface TokenBucketOptions {
  readonly redis: RedisScriptClient;
  /** Overrides the Redis server clock. Test seam only. */
  readonly now?: () => number;
  readonly scriptPath?: URL;
}

const DEFAULT_SCRIPT_PATH = new URL('../token-bucket.lua', import.meta.url);

/**
 * Token bucket backed by a single Lua script.
 *
 * The script is registered once with SCRIPT LOAD and invoked with EVALSHA
 * thereafter, so the script body crosses the wire once per process rather than
 * once per request. A Redis restart or SCRIPT FLUSH drops the cached body and
 * Redis answers NOSCRIPT; the wrapper then replays the call with EVAL and
 * re-registers, which means a limiter never fails a request over cache state.
 */
export class TokenBucketLimiter {
  private readonly redis: RedisScriptClient;
  private readonly now: (() => number) | undefined;
  private readonly scriptPath: URL;
  private scriptSource: string | null = null;
  private sha: string | null = null;
  private loading: Promise<string> | null = null;

  constructor(options: TokenBucketOptions) {
    this.redis = options.redis;
    this.now = options.now;
    this.scriptPath = options.scriptPath ?? DEFAULT_SCRIPT_PATH;
  }

  /** Read and register the script. Called at boot so the first request is warm. */
  async load(): Promise<string> {
    this.loading ??= this.doLoad().finally(() => {
      this.loading = null;
    });
    return this.loading;
  }

  private async doLoad(): Promise<string> {
    this.scriptSource ??= await readFile(this.scriptPath, 'utf8');
    const sha = await this.redis.script('LOAD', this.scriptSource);
    if (typeof sha !== 'string') {
      throw new TypeError('SCRIPT LOAD did not return a digest');
    }
    this.sha = sha;
    return sha;
  }

  get scriptSha(): string | null {
    return this.sha;
  }

  /**
   * Consume `cost` tokens from the bucket for `scope`.
   * One network round trip; the decision is made entirely inside Redis.
   */
  async consume(scope: LimitScope, config: BucketConfig, cost = 1): Promise<LimitVerdict> {
    const key = bucketKey(scope);
    const label = scopeLabel(scope);
    const startedAt = performance.now();

    // Idle buckets expire after roughly the time it takes to refill completely,
    // with a floor, so state does not accumulate for one-off callers.
    const ttlMs = Math.max(
      60_000,
      Math.ceil((config.capacity / Math.max(1, config.refillTokens)) * config.refillIntervalMs) * 2,
    );

    const args: (string | number)[] = [
      key,
      config.capacity,
      config.refillTokens,
      config.refillIntervalMs,
      cost,
      ttlMs,
      this.now ? this.now() : 0,
    ];

    const raw = await this.evaluate(args);
    const latencyMs = performance.now() - startedAt;

    const verdict = toVerdict(raw, label, key);

    rateLimitLatency.record(latencyMs, { scope: scope.type });
    rateLimitDecisions.add(1, {
      scope: scope.type,
      tenant: scope.tenantId,
      allowed: verdict.allowed,
      ...(config.tier ? { tier: config.tier } : {}),
    });
    annotate({
      [GatewayAttr.RATE_LIMIT_REMAINING]: verdict.remaining,
      [GatewayAttr.RATE_LIMIT_SCOPE]: label,
    });

    return verdict;
  }

  private async evaluate(args: (string | number)[]): Promise<unknown> {
    const sha = this.sha ?? (await this.load());
    try {
      return await this.redis.evalsha(sha, 1, ...args);
    } catch (error) {
      if (!isNoScriptError(error)) throw error;
      // Redis forgot the body (restart, SCRIPT FLUSH, failover to a fresh
      // replica). Fall back to EVAL for this call and re-register for the next.
      this.sha = null;
      const source = this.scriptSource ?? (await readFile(this.scriptPath, 'utf8'));
      this.scriptSource = source;
      const result = await this.redis.eval(source, 1, ...args);
      void this.load().catch(() => undefined);
      return result;
    }
  }
}

function isNoScriptError(error: unknown): boolean {
  return error instanceof Error && error.message.toUpperCase().includes('NOSCRIPT');
}

function toVerdict(raw: unknown, scope: string, key: string): LimitVerdict {
  if (!Array.isArray(raw) || raw.length < 4) {
    throw new TypeError('Rate limit script returned an unexpected shape');
  }
  const [allowed, remaining, retryAfterMs, limit] = raw as [
    number | string,
    number | string,
    number | string,
    number | string,
  ];
  return {
    allowed: Number(allowed) === 1,
    remaining: Number(remaining),
    retryAfterMs: Number(retryAfterMs),
    limit: Number(limit),
    scope,
    key,
  };
}
