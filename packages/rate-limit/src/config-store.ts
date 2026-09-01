import { CONFIG_INVALIDATION_CHANNEL } from './keys.js';
import type { BucketConfig } from './limiter.js';

export interface RateLimitConfigRecord {
  readonly tenantId: string;
  readonly scopeType: 'tenant' | 'user_tool';
  /** `*` matches any tool. An exact tool name wins over the wildcard. */
  readonly toolName: string;
  readonly tier: string;
  readonly capacity: number;
  readonly refillTokens: number;
  readonly refillIntervalMs: number;
}

/** Subscriber half of a Redis connection. */
export interface RedisSubscriberLike {
  subscribe(channel: string): Promise<unknown>;
  on(event: 'message', listener: (channel: string, message: string) => void): unknown;
  unsubscribe(channel: string): Promise<unknown>;
}

export interface RedisPublisherLike {
  publish(channel: string, message: string): Promise<unknown>;
}

export interface RateLimitConfigStoreOptions {
  /** Reads every configuration row. Backed by Postgres in the gateway. */
  readonly loader: () => Promise<readonly RateLimitConfigRecord[]>;
  readonly subscriber?: RedisSubscriberLike;
  readonly publisher?: RedisPublisherLike;
  /** Applied when a tenant has no matching row. */
  readonly fallback?: { tenant: BucketConfig; userTool: BucketConfig };
  readonly onReload?: (count: number) => void;
}

export interface ResolvedLimits {
  readonly tenant: BucketConfig;
  readonly userTool: BucketConfig;
}

const DEFAULT_FALLBACK: { tenant: BucketConfig; userTool: BucketConfig } = {
  // Deliberately conservative: an unconfigured tenant is throttled rather than
  // unlimited, so a missing row can never become an availability incident.
  tenant: { capacity: 600, refillTokens: 600, refillIntervalMs: 60_000, tier: 'fallback' },
  userTool: { capacity: 60, refillTokens: 60, refillIntervalMs: 60_000, tier: 'fallback' },
};

/**
 * Caches per-tenant limit configuration in memory and reloads it when any
 * instance publishes on the invalidation channel.
 *
 * Reading limits from Postgres on every request would put a database round trip
 * in front of every tool call. Caching without invalidation means an operator
 * raising a limit during an incident has to wait for a deploy. Pub/sub gives
 * both: reads are memory-speed, and a change reaches every replica in one hop.
 */
export class RateLimitConfigStore {
  private readonly loader: () => Promise<readonly RateLimitConfigRecord[]>;
  private readonly subscriber: RedisSubscriberLike | undefined;
  private readonly publisher: RedisPublisherLike | undefined;
  private readonly fallback: { tenant: BucketConfig; userTool: BucketConfig };
  private readonly onReload: ((count: number) => void) | undefined;

  private records: readonly RateLimitConfigRecord[] = [];
  private index = new Map<string, RateLimitConfigRecord>();
  private loadedAt = 0;

  constructor(options: RateLimitConfigStoreOptions) {
    this.loader = options.loader;
    this.subscriber = options.subscriber;
    this.publisher = options.publisher;
    this.fallback = options.fallback ?? DEFAULT_FALLBACK;
    this.onReload = options.onReload;
  }

  async start(): Promise<void> {
    await this.reload();
    if (!this.subscriber) return;
    this.subscriber.on('message', (channel) => {
      if (channel !== CONFIG_INVALIDATION_CHANNEL) return;
      void this.reload();
    });
    await this.subscriber.subscribe(CONFIG_INVALIDATION_CHANNEL);
  }

  async stop(): Promise<void> {
    await this.subscriber?.unsubscribe(CONFIG_INVALIDATION_CHANNEL);
  }

  async reload(): Promise<number> {
    const records = await this.loader();
    const index = new Map<string, RateLimitConfigRecord>();
    for (const record of records) {
      index.set(indexKey(record.tenantId, record.scopeType, record.toolName, record.tier), record);
    }
    this.records = records;
    this.index = index;
    this.loadedAt = Date.now();
    this.onReload?.(records.length);
    return records.length;
  }

  /** Tell every replica, including this one, to re-read configuration. */
  async publishReload(): Promise<void> {
    if (this.publisher) {
      await this.publisher.publish(CONFIG_INVALIDATION_CHANNEL, String(Date.now()));
      return;
    }
    await this.reload();
  }

  /**
   * Resolve the two buckets that guard a call. Lookup order for each scope:
   * exact tool at the requested tier, exact tool at the default tier, wildcard
   * at the requested tier, wildcard at the default tier, then the fallback.
   */
  resolve(tenantId: string, toolName: string, tier = 'default'): ResolvedLimits {
    return {
      tenant: this.lookup(tenantId, 'tenant', '*', tier) ?? this.fallback.tenant,
      userTool: this.lookup(tenantId, 'user_tool', toolName, tier) ?? this.fallback.userTool,
    };
  }

  private lookup(
    tenantId: string,
    scopeType: 'tenant' | 'user_tool',
    toolName: string,
    tier: string,
  ): BucketConfig | null {
    const candidates = [
      indexKey(tenantId, scopeType, toolName, tier),
      indexKey(tenantId, scopeType, toolName, 'default'),
      indexKey(tenantId, scopeType, '*', tier),
      indexKey(tenantId, scopeType, '*', 'default'),
    ];
    for (const candidate of candidates) {
      const record = this.index.get(candidate);
      if (record) {
        return {
          capacity: record.capacity,
          refillTokens: record.refillTokens,
          refillIntervalMs: record.refillIntervalMs,
          tier: record.tier,
        };
      }
    }
    return null;
  }

  snapshot(): { records: readonly RateLimitConfigRecord[]; loadedAt: number } {
    return { records: this.records, loadedAt: this.loadedAt };
  }
}

function indexKey(tenantId: string, scopeType: string, toolName: string, tier: string): string {
  return `${tenantId}|${scopeType}|${toolName}|${tier}`;
}
