import { NotFoundError, toGatewayError, hasScope, ScopeDeniedError } from '@mcpgateway/shared';
import { withSpan } from '@mcpgateway/telemetry';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';

import { findTool, TOOL_CATALOG, toolsForServer } from '../catalog.js';
import type { InvocationState } from '../context.js';
import { createAuditStage } from '../plugins/audit.js';
import { createMcpProxy } from '../plugins/mcp-proxy.js';
import { createPolicyStage } from '../plugins/policy.js';
import { createRateLimitStage } from '../plugins/rate-limit.js';
import { createTokenExchangeStage } from '../plugins/token-exchange.js';
import type { GatewayServices } from '../services.js';

const callSchema = z.object({
  arguments: z.record(z.unknown()).default({}),
});

const paramsSchema = z.object({
  server: z.enum(['salesforce', 'postgres', 'policy-engine']),
  tool: z.string().min(1),
});

/**
 * The enforcement path.
 *
 * Stages run in a fixed order and the order is load-bearing:
 *
 *   1 telemetry        (global) request id and structured logging
 *   2 auth             (global) verify the inbound token
 *   3 tenant-context   (global) resolve the tenant named by the token
 *   4 rate-limit       cheapest check first, before any work is done for the caller
 *   5 policy           decide before minting a credential
 *   6 token-exchange   mirror the caller's permissions downstream
 *   7 mcp-proxy        forward, carrying the exchanged token and trace context
 *   8 audit            record the outcome, allow or deny, always
 *
 * Stages 4 to 6 are preHandlers, so a refusal short-circuits before the handler
 * runs. Stage 8 runs from both the success path and the error handler, which is
 * why the invocation carries an `audited` flag.
 */
export function createToolRoutes(services: GatewayServices): FastifyPluginAsync {
  const rateLimitStage = createRateLimitStage(services);
  const policyStage = createPolicyStage(services);
  const tokenExchangeStage = createTokenExchangeStage(services);
  const proxy = createMcpProxy(services);
  const audit = createAuditStage(services);

  return async (app) => {
    app.get('/v1/servers', { preHandler: [app.authenticate] }, async () => ({
      servers: (['salesforce', 'postgres', 'policy-engine'] as const).map((id) => ({
        id,
        audience: services.targets[id].audience,
        tools: toolsForServer(id),
      })),
    }));

    app.get('/v1/tools', { preHandler: [app.authenticate] }, async (request) => ({
      tools: TOOL_CATALOG.map((entry) => ({
        ...entry,
        // Tells the console which tools to offer this particular caller,
        // without it having to reason about scopes itself.
        permitted: entry.requiredScopes.every((scope) =>
          hasScope(request.principal?.scopes ?? [], scope),
        ),
      })),
    }));

    app.post<{ Params: { server: string; tool: string } }>(
      '/v1/servers/:server/tools/:tool',
      {
        preHandler: [
          app.authenticate,
          app.resolveTenant,
          // Establish the invocation before any stage that might refuse, so a
          // refusal still has something to audit.
          async (request) => {
            const params = paramsSchema.safeParse(request.params);
            if (!params.success) throw new NotFoundError('Server or tool');

            const entry = findTool(params.data.tool);
            if (!entry || entry.server !== params.data.server) {
              throw new NotFoundError(`Tool ${params.data.tool}`);
            }

            const body = callSchema.safeParse(request.body ?? {});
            const invocation: InvocationState = {
              server: params.data.server,
              tool: params.data.tool,
              args: body.success ? body.data.arguments : {},
              startedAt: performance.now(),
              policy: null,
              rateLimit: null,
              tokenExchange: null,
              decision: 'allow',
              denyReason: null,
              upstreamLatencyMs: null,
              audited: false,
            };
            request.invocation = invocation;

            // Scope check here as well as at the target server. Refusing early
            // avoids minting a token for a call that cannot succeed, and gives
            // the caller a precise error instead of an upstream rejection.
            const held = request.principal?.scopes ?? [];
            const missing = entry.requiredScopes.filter((scope) => !hasScope(held, scope));
            if (missing.length > 0) {
              invocation.decision = 'deny';
              invocation.denyReason = `scope:${missing.join(',')}`;
              throw new ScopeDeniedError(missing, held);
            }
          },
          rateLimitStage,
          policyStage,
          tokenExchangeStage,
        ],
      },
      async (request, reply) => {
        const invocation = request.invocation;
        if (!invocation) throw new NotFoundError('Invocation');

        const result = await withSpan(`gateway.dispatch ${invocation.tool}`, async () =>
          proxy(request),
        );

        await audit(request);

        return reply.send({
          ok: !result.isError,
          server: invocation.server,
          tool: invocation.tool,
          result: result.structured ?? { text: result.text },
          meta: {
            requestId: request.requestId,
            latencyMs: Math.round(performance.now() - invocation.startedAt),
            upstreamLatencyMs: Math.round(result.latencyMs),
            policy: invocation.policy
              ? { ruleId: invocation.policy.ruleId, decision: invocation.policy.decision }
              : null,
            tokenExchange: invocation.tokenExchange
              ? {
                  audience: invocation.tokenExchange.audience,
                  cached: invocation.tokenExchange.cached,
                  scopes: invocation.tokenExchange.scopes,
                  subject: invocation.tokenExchange.subject,
                }
              : null,
            rateLimit: invocation.rateLimit,
          },
        });
      },
    );

    /**
     * Records a refusal that happened during a preHandler. Registered on this
     * encapsulation context only, so console and health routes keep the
     * application-wide handler.
     */
    app.setErrorHandler(async (error, request, reply) => {
      const failure = toGatewayError(error);
      const invocation = request.invocation;

      if (invocation) {
        invocation.decision = 'deny';
        invocation.denyReason ??= failure.code;
        await audit(request);
      }

      if (failure.retryAfterSeconds !== undefined) {
        void reply.header('retry-after', String(failure.retryAfterSeconds));
      }

      services.logger.warn(
        {
          requestId: request.requestId,
          code: failure.code,
          status: failure.status,
          tool: invocation?.tool,
        },
        'tool call refused',
      );

      return reply.code(failure.status).send(failure.toResponseBody());
    });
  };
}
