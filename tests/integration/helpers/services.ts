import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';

/**
 * Integration tests run against real Postgres and Redis.
 *
 * Locally that means Testcontainers. In CI the workflow already provides both
 * as service containers, so `USE_EXTERNAL_SERVICES=true` reuses them instead of
 * paying to start a second copy inside the job.
 */

export interface ServiceHandles {
  readonly postgresUrl: string;
  readonly redisUrl: string;
  stop(): Promise<void>;
}

const useExternal = process.env.USE_EXTERNAL_SERVICES === 'true';

export async function startPostgres(): Promise<{ url: string; stop: () => Promise<void> }> {
  if (useExternal) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error('USE_EXTERNAL_SERVICES is set but DATABASE_URL is not');
    return { url, stop: async () => undefined };
  }
  const container: StartedPostgreSqlContainer = await new PostgreSqlContainer('postgres:16-alpine')
    .withDatabase('mcpgateway')
    .withUsername('mcpgw')
    .withPassword('mcpgw')
    .start();
  return {
    url: container.getConnectionUri(),
    stop: async () => {
      await container.stop();
    },
  };
}

export async function startRedis(): Promise<{ url: string; stop: () => Promise<void> }> {
  if (useExternal) {
    const url = process.env.REDIS_URL;
    if (!url) throw new Error('USE_EXTERNAL_SERVICES is set but REDIS_URL is not');
    return { url, stop: async () => undefined };
  }
  const container: StartedRedisContainer = await new RedisContainer('redis:7-alpine').start();
  return {
    url: container.getConnectionUrl(),
    stop: async () => {
      await container.stop();
    },
  };
}

export async function startServices(): Promise<ServiceHandles> {
  const [postgres, redis] = await Promise.all([startPostgres(), startRedis()]);
  return {
    postgresUrl: postgres.url,
    redisUrl: redis.url,
    stop: async () => {
      await Promise.all([postgres.stop(), redis.stop()]);
    },
  };
}
