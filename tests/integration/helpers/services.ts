/**
 * Integration tests run against real Postgres and Redis.
 *
 * Locally that means Testcontainers. In CI the workflow already provides both
 * as service containers, so `USE_EXTERNAL_SERVICES=true` reuses them instead of
 * paying to start a second copy inside the job.
 *
 * Testcontainers is imported lazily, and that is load-bearing rather than
 * tidiness. It pulls in undici, whose current major expects a `webidl` helper
 * that is missing on older Node 20 patch releases; importing it at module scope
 * crashed every integration suite on the runner before a single test ran, even
 * though `USE_EXTERNAL_SERVICES` meant none of it would be used. A dependency
 * that a run will never touch should not be able to fail that run.
 */

export interface ServiceHandles {
  readonly postgresUrl: string;
  readonly redisUrl: string;
  stop(): Promise<void>;
}

export interface ServiceHandle {
  readonly url: string;
  stop(): Promise<void>;
}

const useExternal = (): boolean => process.env.USE_EXTERNAL_SERVICES === 'true';

const NO_OP_STOP = async (): Promise<void> => undefined;

export async function startPostgres(): Promise<ServiceHandle> {
  if (useExternal()) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error('USE_EXTERNAL_SERVICES is set but DATABASE_URL is not');
    return { url, stop: NO_OP_STOP };
  }

  const { PostgreSqlContainer } = await import('@testcontainers/postgresql');
  const container = await new PostgreSqlContainer('postgres:16-alpine')
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

export async function startRedis(): Promise<ServiceHandle> {
  if (useExternal()) {
    const url = process.env.REDIS_URL;
    if (!url) throw new Error('USE_EXTERNAL_SERVICES is set but REDIS_URL is not');
    return { url, stop: NO_OP_STOP };
  }

  const { RedisContainer } = await import('@testcontainers/redis');
  const container = await new RedisContainer('redis:7-alpine').start();

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
