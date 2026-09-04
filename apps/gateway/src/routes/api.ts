import {
  auditStats,
  queryAuditEvents,
  verifyAllChains,
  verifyTenantChain,
} from '@mcpgateway/audit';
import { callUpstreamTool } from '@mcpgateway/mcp-runtime';
import { BadRequestError, ScopeDeniedError, hasScope } from '@mcpgateway/shared';
import { sql } from 'drizzle-orm';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';

import { TOOL_CATALOG } from '../catalog.js';
import type { GatewayServices } from '../services.js';

const RANGES: Record<string, number> = {
  '15m': 15 * 60_000,
  '1h': 60 * 60_000,
  '24h': 24 * 60 * 60_000,
  '7d': 7 * 24 * 60 * 60_000,
};

function sinceFor(range: string | undefined): Date {
  return new Date(Date.now() - (RANGES[range ?? '1h'] ?? RANGES['1h'] ?? 3_600_000));
}

/**
 * Read API for the console.
 *
 * Every endpoint is scoped to the caller's own tenant, taken from their token.
 * There is no tenant parameter: an operator looking at the console sees their
 * organisation's traffic and nobody else's, and that is enforced here rather
 * than by the front end choosing not to ask.
 */
export function createApiRoutes(services: GatewayServices): FastifyPluginAsync {
  function requireAdmin(request: FastifyRequest): void {
    const held = request.principal?.scopes ?? [];
    if (!hasScope(held, 'gateway:admin')) {
      throw new ScopeDeniedError(['gateway:admin'], held);
    }
  }

  return async (app) => {
    app.addHook('preHandler', app.authenticate);
    app.addHook('preHandler', app.resolveTenant);

    // ---------------------------------------------------------------- overview
    app.get<{ Querystring: { range?: string } }>('/api/overview', async (request) => {
      const tenantId = request.principal?.tenantId ?? '';
      const range = request.query.range ?? '1h';
      const since = sinceFor(range);
      const bucketMinutes = range === '24h' ? 30 : range === '7d' ? 180 : 5;

      const stats = await auditStats(services.db.db, { tenantId, since, bucketMinutes });

      return {
        range,
        since: since.toISOString(),
        totals: {
          invocations: stats.total,
          allowed: stats.allowed,
          denied: stats.denied,
          denyRate: stats.total === 0 ? 0 : stats.denied / stats.total,
        },
        latency: {
          p50: stats.p50LatencyMs,
          p95: stats.p95LatencyMs,
          p99: stats.p99LatencyMs,
        },
        topTools: stats.topTools,
        topTenants: stats.topTenants,
        series: stats.series,
        liveListeners: services.stream.listenerCount,
      };
    });

    // ------------------------------------------------------------------- audit
    const auditQuerySchema = z.object({
      user: z.string().optional(),
      tool: z.string().optional(),
      server: z.string().optional(),
      decision: z.enum(['allow', 'deny']).optional(),
      search: z.string().optional(),
      range: z.string().optional(),
      limit: z.coerce.number().int().min(1).max(200).default(50),
      offset: z.coerce.number().int().min(0).default(0),
    });

    app.get('/api/audit', async (request) => {
      const parsed = auditQuerySchema.safeParse(request.query);
      if (!parsed.success) throw new BadRequestError('Invalid audit filter');
      const query = parsed.data;

      const page = await queryAuditEvents(services.db.db, {
        tenantId: request.principal?.tenantId ?? '',
        ...(query.user ? { userId: query.user } : {}),
        ...(query.tool ? { toolName: query.tool } : {}),
        ...(query.server ? { mcpServer: query.server } : {}),
        ...(query.decision ? { decision: query.decision } : {}),
        ...(query.search ? { search: query.search } : {}),
        ...(query.range ? { from: sinceFor(query.range) } : {}),
        limit: query.limit,
        offset: query.offset,
      });

      return { ...page, limit: query.limit, offset: query.offset };
    });

    app.post('/api/audit/verify', async (request) => {
      const tenantId = request.principal?.tenantId ?? '';
      const result = await verifyTenantChain(services.db.db, tenantId);
      return {
        tenantId,
        valid: result.valid,
        rowsChecked: result.rowsChecked,
        durationMs: Number(result.durationMs.toFixed(1)),
        headHash: result.headHash,
        recordedHeadHash: result.recordedHeadHash,
        firstBreak: result.firstBreak,
      };
    });

    app.post('/api/audit/verify-all', async (request) => {
      requireAdmin(request);
      const results = await verifyAllChains(services.db.db);
      return {
        chains: results.map((result) => ({
          tenantId: result.tenantId,
          valid: result.valid,
          rowsChecked: result.rowsChecked,
          firstBreak: result.firstBreak,
        })),
        allValid: results.every((result) => result.valid),
      };
    });

    // ------------------------------------------------------------ rate limits
    app.get('/api/rate-limits', async (request) => {
      const tenantId = request.principal?.tenantId ?? '';
      const rows = await services.db.db.execute<
        {
          id: string;
          scope_type: string;
          tool_name: string;
          tier: string;
          capacity: number;
          refill_tokens: number;
          refill_interval_ms: number;
          updated_at: Date | string;
        } & Record<string, unknown>
      >(sql`
        SELECT id, scope_type, tool_name, tier, capacity, refill_tokens, refill_interval_ms, updated_at
        FROM rate_limit_configs
        WHERE tenant_id = ${tenantId}
        ORDER BY scope_type, tool_name, tier
      `);

      // Current bucket state, read straight from Redis so the console shows
      // what the limiter is actually working with rather than what was
      // configured.
      const pattern = `rl:{${tenantId}}:*`;
      const keys = await services.redis.keys(pattern).catch(() => []);
      const buckets = await Promise.all(
        keys.slice(0, 100).map(async (key) => {
          const state: Record<string, string> = await services.redis.hgetall(key).catch(() => ({}));
          return {
            key,
            tokens: state.tokens ? Number.parseFloat(state.tokens) : null,
            updatedAt: state.ts ? Number.parseInt(state.ts, 10) : null,
          };
        }),
      );

      return {
        configs: rows.rows.map((row) => ({
          id: row.id,
          scopeType: row.scope_type,
          toolName: row.tool_name,
          tier: row.tier,
          capacity: Number(row.capacity),
          refillTokens: Number(row.refill_tokens),
          refillIntervalMs: Number(row.refill_interval_ms),
          updatedAt: new Date(row.updated_at).toISOString(),
        })),
        buckets: buckets.filter((bucket) => bucket.tokens !== null),
      };
    });

    const rateLimitUpdateSchema = z.object({
      capacity: z.number().int().min(0).max(1_000_000),
      refillTokens: z.number().int().min(0).max(1_000_000),
      refillIntervalMs: z.number().int().min(0).max(3_600_000),
    });

    app.put<{ Params: { id: string } }>('/api/rate-limits/:id', async (request) => {
      requireAdmin(request);
      const parsed = rateLimitUpdateSchema.safeParse(request.body);
      if (!parsed.success) throw new BadRequestError('Invalid rate limit configuration');

      const tenantId = request.principal?.tenantId ?? '';
      const updated = await services.db.db.execute<{ id: string } & Record<string, unknown>>(sql`
        UPDATE rate_limit_configs
        SET capacity = ${parsed.data.capacity},
            refill_tokens = ${parsed.data.refillTokens},
            refill_interval_ms = ${parsed.data.refillIntervalMs},
            updated_at = now()
        WHERE id = ${request.params.id}::uuid AND tenant_id = ${tenantId}
        RETURNING id
      `);

      if (updated.rows.length === 0)
        throw new BadRequestError('No such rate limit for this tenant');

      // Tell every replica, including this one, to re-read configuration.
      await services.rateLimitConfigs.publishReload();
      return { ok: true, id: request.params.id };
    });

    // ---------------------------------------------------------------- policies
    app.get('/api/policies', async (request) => {
      const principal = request.principal;
      if (!principal) throw new BadRequestError('Authentication required');

      const target = services.targets['policy-engine'];
      const token = await services.tokenExchange.mint({
        principal,
        subjectToken: request.inboundToken ?? '',
        audience: target.audience,
        scopes: ['policy:read'],
      });

      const result = await callUpstreamTool({
        url: target.url,
        server: 'policy-engine',
        toolName: 'policy.list_rules',
        arguments: { bundle: 'baseline' },
        accessToken: token.accessToken,
      });

      return result.structured ?? { rules: [] };
    });

    const tryPolicySchema = z.object({
      tool: z.string().min(1),
      server: z.string().min(1),
      role: z.string().default('analyst'),
      scopes: z.array(z.string()).default([]),
      arguments: z.record(z.unknown()).default({}),
    });

    app.post('/api/policies/evaluate', async (request) => {
      const principal = request.principal;
      const tenant = request.tenant;
      if (!principal || !tenant) throw new BadRequestError('Authentication required');

      const parsed = tryPolicySchema.safeParse(request.body);
      if (!parsed.success) throw new BadRequestError('Invalid evaluation request');

      const target = services.targets['policy-engine'];
      const token = await services.tokenExchange.mint({
        principal,
        subjectToken: request.inboundToken ?? '',
        audience: target.audience,
        scopes: ['policy:evaluate'],
      });

      const result = await callUpstreamTool({
        url: target.url,
        server: 'policy-engine',
        toolName: 'policy.explain',
        accessToken: token.accessToken,
        arguments: {
          tool: parsed.data.tool,
          server: parsed.data.server,
          bundle: 'baseline',
          // The hypothetical caller may differ from the operator running the
          // check, but never their tenant: an operator cannot use this to probe
          // another organisation's rules.
          principal: {
            subject: principal.subject,
            tenantId: principal.tenantId,
            role: parsed.data.role,
            scopes: parsed.data.scopes,
            territory: null,
          },
          tenant: { id: tenant.id, plan: tenant.plan },
          arguments: parsed.data.arguments,
        },
      });

      return (
        result.structured ?? { decision: 'deny', reason: 'Policy engine returned no decision' }
      );
    });

    // ----------------------------------------------------------------- tenants
    app.get('/api/tenants', async (request) => {
      const tenantId = request.principal?.tenantId ?? '';
      const rows = await services.db.db.execute<
        {
          id: string;
          name: string;
          plan: string;
          region: string;
          users: number;
          created_at: Date | string;
        } & Record<string, unknown>
      >(sql`
        SELECT t.id, t.name, t.plan, t.region, t.created_at,
               COUNT(u.id)::int AS users
        FROM tenants t
        LEFT JOIN users u ON u.tenant_id = t.id
        WHERE t.id = ${tenantId}
        GROUP BY t.id
      `);

      const users = await services.db.db.execute<
        {
          id: string;
          name: string;
          email: string;
          role: string;
          territory: string | null;
        } & Record<string, unknown>
      >(sql`
        SELECT id, name, email, role, territory FROM users WHERE tenant_id = ${tenantId} ORDER BY name
      `);

      return {
        tenant: rows.rows[0]
          ? {
              id: rows.rows[0].id,
              name: rows.rows[0].name,
              plan: rows.rows[0].plan,
              region: rows.rows[0].region,
              users: Number(rows.rows[0].users),
              createdAt: new Date(rows.rows[0].created_at).toISOString(),
            }
          : null,
        users: users.rows,
      };
    });

    app.get('/api/clients', async (request) => {
      requireAdmin(request);
      const rows = await services.db.db.execute<
        {
          client_id: string;
          name: string;
          confidential: boolean;
          allowed_scopes: string[];
          allowed_grants: string[];
          redirect_uris: string[];
        } & Record<string, unknown>
      >(sql`
        SELECT client_id, name, confidential, allowed_scopes, allowed_grants, redirect_uris
        FROM oauth_clients ORDER BY name
      `);
      return { clients: rows.rows };
    });

    app.get('/api/catalog', async () => ({ tools: TOOL_CATALOG }));

    // ------------------------------------------------------------------ stream
    app.get('/api/stream', async (request, reply) => {
      const tenantId = request.principal?.tenantId ?? '';

      reply.raw.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        // Without this an intermediate proxy will happily buffer the stream
        // until it looks broken.
        'x-accel-buffering': 'no',
      });

      const send = (event: unknown): void => {
        reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
      };

      for (const event of services.stream.recent(30, tenantId)) send(event);

      const unsubscribe = services.stream.subscribe((event) => {
        if (event.tenantId !== tenantId) return;
        send(event);
      });

      // Comment frames keep intermediaries from closing an idle connection.
      const keepAlive = setInterval(() => reply.raw.write(': keep-alive\n\n'), 15_000);

      request.raw.on('close', () => {
        clearInterval(keepAlive);
        unsubscribe();
      });

      await new Promise<void>((resolve) => request.raw.on('close', resolve));
    });
  };
}
