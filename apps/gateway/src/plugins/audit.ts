import { invocationEventSchema, type InvocationEvent } from '@mcpgateway/shared';
import { currentTraceId } from '@mcpgateway/telemetry';
import type { FastifyRequest } from 'fastify';

import type { GatewayServices } from '../services.js';

/**
 * Stage 8 of the pipeline.
 *
 * Writes exactly one audit row per tool call, whatever the outcome. Denials are
 * the rows that matter most: a log containing only successful calls tells an
 * investigator nothing about what was attempted.
 *
 * `audited` guards against a double write when a request both throws and then
 * completes through the error handler. The append is deliberately synchronous
 * with respect to the response: an audit trail that can silently lose its most
 * interesting rows under load is not an audit trail. The cost is one indexed
 * insert plus a per-tenant row lock, which the benchmark measures.
 */
export function createAuditStage(services: GatewayServices) {
  return async function audit(request: FastifyRequest): Promise<void> {
    const invocation = request.invocation;
    const principal = request.principal;
    if (!invocation || !principal || invocation.audited) return;
    invocation.audited = true;

    const latencyMs = Math.round(performance.now() - invocation.startedAt);
    const traceId = currentTraceId();

    try {
      const row = await services.audit.append({
        tenantId: principal.tenantId,
        userId: principal.subject,
        actorTokenJti: principal.tokenId,
        mcpServer: invocation.server,
        toolName: invocation.tool,
        arguments: invocation.args,
        decision: invocation.decision,
        denyReason: invocation.denyReason,
        latencyMs,
        traceId,
      });

      request.log?.debug?.({ seq: row.seq }, 'audit row appended');
    } catch (error) {
      // The request has already been answered by this point. Losing the row is
      // serious, so it is logged at error level with everything needed to
      // reconstruct it rather than swallowed.
      services.logger.error(
        {
          err: error,
          tenantId: principal.tenantId,
          userId: principal.subject,
          tool: invocation.tool,
          decision: invocation.decision,
          traceId,
        },
        'failed to append audit row',
      );
    }

    const event: InvocationEvent = invocationEventSchema.parse({
      id: request.requestId,
      ts: new Date().toISOString(),
      tenantId: principal.tenantId,
      tenantName: request.tenant?.name,
      userId: principal.subject,
      userName: principal.name,
      server: invocation.server,
      tool: invocation.tool,
      decision: invocation.decision,
      denyReason: invocation.denyReason,
      latencyMs,
      traceId,
      tokenExchange: invocation.tokenExchange
        ? {
            cached: invocation.tokenExchange.cached,
            latencyMs: Number(invocation.tokenExchange.latencyMs.toFixed(2)),
            audience: invocation.tokenExchange.audience,
            downstreamSubject: invocation.tokenExchange.subject,
          }
        : null,
      policy: invocation.policy,
      rateLimit: invocation.rateLimit,
    });

    services.stream.publish(event);
  };
}
