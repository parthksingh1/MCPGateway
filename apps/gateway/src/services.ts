import { AuditWriter } from '@mcpgateway/audit';
import { JwksCache, OAuthClient, TokenExchangeService } from '@mcpgateway/auth';
import { RateLimitConfigStore, RateLimitService, TokenBucketLimiter } from '@mcpgateway/rate-limit';
import type { GatewayConfig } from '@mcpgateway/shared';
import { createDatabase, type DbHandle } from '@mcpgateway/shared/db';
import { createLogger, type Logger } from '@mcpgateway/telemetry';
import { sql } from 'drizzle-orm';
import { Redis } from 'ioredis';

import { InvocationStream } from './stream.js';

export interface McpTarget {
  readonly id: 'salesforce' | 'postgres' | 'policy-engine';
  readonly url: string;
  /** Audience the downstream token must be addressed to. */
  readonly audience: string;
  /** Scope namespace this server accepts, used to narrow the exchange request. */
  readonly namespace: string;
}

export interface GatewayServices {
  readonly config: GatewayConfig;
  readonly logger: Logger;
  readonly db: DbHandle;
  /** Separate handle on the INSERT-only role used exclusively for audit writes. */
  readonly auditDb: DbHandle;
  readonly redis: Redis;
  readonly redisSubscriber: Redis;
  readonly oauth: OAuthClient;
  readonly dashboardOauth: OAuthClient;
  readonly jwks: JwksCache;
  readonly tokenExchange: TokenExchangeService;
  readonly rateLimits: RateLimitService;
  readonly rateLimitConfigs: RateLimitConfigStore;
  readonly audit: AuditWriter;
  readonly stream: InvocationStream;
  readonly targets: Record<McpTarget['id'], McpTarget>;
  close(): Promise<void>;
}

/**
 * Builds every long-lived dependency once, at boot.
 *
 * Two Postgres pools, deliberately. The gateway's ordinary work uses a role
 * with full access to the control plane; audit writes use a role that can only
 * append. Sharing one connection would collapse that distinction, and the
 * distinction is the entire point of the split.
 */
export async function createServices(config: GatewayConfig): Promise<GatewayServices> {
  const logger = createLogger({ serviceName: 'gateway' });

  const db = createDatabase(config.DATABASE_URL, 15);
  const auditDb = createDatabase(config.AUDIT_DATABASE_URL ?? config.DATABASE_URL, 5);

  const redis = new Redis(config.REDIS_URL, { maxRetriesPerRequest: 3, lazyConnect: false });
  const redisSubscriber = new Redis(config.REDIS_URL, { maxRetriesPerRequest: 3 });

  const oauth = new OAuthClient({
    issuer: config.OIDC_ISSUER,
    ...(config.OIDC_ISSUER_INTERNAL ? { baseUrl: config.OIDC_ISSUER_INTERNAL } : {}),
    clientId: config.GATEWAY_CLIENT_ID,
    clientSecret: config.GATEWAY_CLIENT_SECRET,
  });

  const dashboardOauth = new OAuthClient({
    issuer: config.OIDC_ISSUER,
    ...(config.OIDC_ISSUER_INTERNAL ? { baseUrl: config.OIDC_ISSUER_INTERNAL } : {}),
    clientId: config.DASHBOARD_CLIENT_ID,
    clientSecret: config.DASHBOARD_CLIENT_SECRET,
  });

  const jwks = new JwksCache({ jwksUri: await oauth.jwksUri() });

  const tokenExchange = new TokenExchangeService({
    client: oauth,
    cache: redis,
    maxTtlSeconds: config.TOKEN_EXCHANGE_CACHE_MAX_TTL_SECONDS,
  });

  const limiter = new TokenBucketLimiter({ redis });
  await limiter.load();

  const rateLimitConfigs = new RateLimitConfigStore({
    loader: async () => {
      const rows = await db.db.execute<{
        tenant_id: string;
        scope_type: string;
        tool_name: string;
        tier: string;
        capacity: number;
        refill_tokens: number;
        refill_interval_ms: number;
      }>(sql`
        SELECT tenant_id, scope_type, tool_name, tier, capacity, refill_tokens, refill_interval_ms
        FROM rate_limit_configs
      `);
      return rows.rows.map((row) => ({
        tenantId: row.tenant_id,
        scopeType: row.scope_type === 'tenant' ? ('tenant' as const) : ('user_tool' as const),
        toolName: row.tool_name,
        tier: row.tier,
        capacity: Number(row.capacity),
        refillTokens: Number(row.refill_tokens),
        refillIntervalMs: Number(row.refill_interval_ms),
      }));
    },
    subscriber: redisSubscriber,
    publisher: redis,
    onReload: (count) => logger.info({ count }, 'rate limit configuration reloaded'),
  });
  await rateLimitConfigs.start();

  const rateLimits = new RateLimitService(limiter, rateLimitConfigs);

  const audit = new AuditWriter(auditDb.db, { capturePayloads: config.AUDIT_PAYLOAD_CAPTURE });
  const stream = new InvocationStream({ historySize: 200 });

  const targets: Record<McpTarget['id'], McpTarget> = {
    salesforce: {
      id: 'salesforce',
      url: config.MCP_SALESFORCE_URL,
      audience: 'mcp:salesforce',
      namespace: 'salesforce',
    },
    postgres: {
      id: 'postgres',
      url: config.MCP_POSTGRES_URL,
      audience: 'mcp:postgres',
      namespace: 'postgres',
    },
    'policy-engine': {
      id: 'policy-engine',
      url: config.MCP_POLICY_URL,
      audience: 'mcp:policy-engine',
      namespace: 'policy',
    },
  };

  return {
    config,
    logger,
    db,
    auditDb,
    redis,
    redisSubscriber,
    oauth,
    dashboardOauth,
    jwks,
    tokenExchange,
    rateLimits,
    rateLimitConfigs,
    audit,
    stream,
    targets,
    close: async () => {
      await rateLimitConfigs.stop().catch(() => undefined);
      stream.close();
      redis.disconnect();
      redisSubscriber.disconnect();
      await db.close();
      await auditDb.close();
    },
  };
}
