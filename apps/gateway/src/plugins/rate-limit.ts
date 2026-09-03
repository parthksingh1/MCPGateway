import { RateLimitedError } from '@mcpgateway/shared';
import type { FastifyReply, FastifyRequest } from 'fastify';

import type { GatewayServices } from '../services.js';

/**
 * Stage 4 of the pipeline.
 *
 * Runs before policy evaluation and before any token is minted, so a caller
 * flooding the gateway is turned away for the cost of a single Redis round trip
 * rather than a policy call plus a token exchange plus an upstream request.
 *
 * A denial sets the invocation's decision so the audit stage records it. Rate
 * limiting is a security-relevant event: an operator investigating an incident
 * needs to see that a caller was throttled, not just that traffic stopped.
 */
export function createRateLimitStage(services: GatewayServices) {
  return async function rateLimitStage(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> {
    const principal = request.principal;
    const invocation = request.invocation;
    if (!principal || !invocation) return;

    const outcome = await services.rateLimits.check({
      tenantId: principal.tenantId,
      userId: principal.subject,
      toolName: invocation.tool,
      // A policy rule may raise or lower the tier, but policy has not run yet.
      // The tier from the previous evaluation is not carried across requests on
      // purpose: a limiter that depends on a decision it has not seen is a
      // limiter that can be talked out of applying.
      ...(invocation.policy?.rateTier ? { tier: invocation.policy.rateTier } : {}),
    });

    invocation.rateLimit = {
      allowed: outcome.allowed,
      remaining: outcome.verdict.remaining,
      limit: outcome.verdict.limit,
      retryAfterMs: outcome.verdict.retryAfterMs,
      scope: outcome.verdict.scope,
    };

    void reply.header('x-ratelimit-limit', String(outcome.verdict.limit));
    void reply.header('x-ratelimit-remaining', String(Math.max(0, outcome.verdict.remaining)));
    void reply.header('x-ratelimit-scope', outcome.verdict.scope);

    if (!outcome.allowed) {
      invocation.decision = 'deny';
      invocation.denyReason = `rate_limit:${outcome.verdict.scope}`;
      throw new RateLimitedError(outcome.verdict.retryAfterMs, {
        scope: outcome.verdict.scope,
        limit: outcome.verdict.limit,
      });
    }
  };
}
