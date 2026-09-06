import { upstreamPoolStats } from '@mcpgateway/mcp-runtime';
import { sql } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';

import type { GatewayServices } from '../services.js';

type Health = 'ok' | 'degraded' | 'down';

async function timed<T>(fn: () => Promise<T>, timeoutMs: number): Promise<T | null> {
  return Promise.race([
    fn().catch(() => null),
    new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs)),
  ]);
}

/**
 * Liveness and readiness.
 *
 * `/healthz` answers whether the process is running and nothing else, so an
 * orchestrator does not restart a healthy gateway because a dependency is
 * briefly unavailable.
 *
 * `/readyz` reports on every dependency the request path needs. Postgres and
 * Redis are hard requirements — without them the gateway cannot audit or rate
 * limit, and both of those failing open would be worse than refusing traffic.
 * An unreachable MCP server is degraded rather than down: the other servers
 * still work, and removing the whole gateway from rotation would turn one
 * server's outage into a total one.
 */
export function createHealthRoutes(services: GatewayServices): FastifyPluginAsync {
  return async (app) => {
    app.get('/healthz', async () => ({
      status: 'ok',
      service: 'gateway',
      version: services.config.SERVICE_VERSION,
      uptimeSeconds: Math.round(process.uptime()),
    }));

    app.get('/readyz', async (_request, reply) => {
      const checks: Record<string, Health> = {};

      const [database, redis, identity] = await Promise.all([
        timed(async () => services.db.db.execute(sql`SELECT 1`), 2_000),
        timed(async () => services.redis.ping(), 2_000),
        timed(async () => services.jwks.refresh(), 2_000),
      ]);

      checks.database = database ? 'ok' : 'down';
      checks.redis = redis ? 'ok' : 'down';
      checks.identity = identity === null && services.jwks.getStats().keys === 0 ? 'down' : 'ok';

      const upstreams = await Promise.all(
        (['salesforce', 'postgres', 'policy-engine'] as const).map(async (id) => {
          const target = services.targets[id];
          const healthUrl = target.url.replace(/\/mcp$/, '/healthz');
          const reachable = await timed(async () => {
            const response = await fetch(healthUrl, { signal: AbortSignal.timeout(1_500) });
            return response.ok ? true : null;
          }, 2_000);
          return [id, reachable ? ('ok' as Health) : ('degraded' as Health)] as const;
        }),
      );
      for (const [id, state] of upstreams) checks[`mcp:${id}`] = state;

      const critical: Health[] = [
        checks.database ?? 'down',
        checks.redis ?? 'down',
        checks.identity ?? 'down',
      ];
      const ready = critical.every((state) => state === 'ok');

      return reply.code(ready ? 200 : 503).send({
        ready,
        checks,
        jwks: services.jwks.getStats(),
        upstreamPool: upstreamPoolStats(),
      });
    });
  };
}
