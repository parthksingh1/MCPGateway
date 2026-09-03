import { callUpstreamTool } from '@mcpgateway/mcp-runtime';
import {
  PolicyDeniedError,
  policyDecisionSchema,
  UpstreamError,
  type PolicyDecision,
} from '@mcpgateway/shared';
import { annotate, GatewayAttr, policyDecisions, policyLatency } from '@mcpgateway/telemetry';
import type { FastifyRequest } from 'fastify';

import type { GatewayServices } from '../services.js';

/**
 * Stage 5 of the pipeline.
 *
 * Asks the policy decision point whether this call may proceed, before any
 * token is minted for the target server.
 *
 * The call to the policy engine is itself permission-mirrored: the gateway
 * exchanges the caller's token for one addressed to `mcp:policy-engine` rather
 * than using a service credential. That keeps a single rule — every outbound
 * call carries the identity of the person who caused it — with no exception
 * carved out for the gateway's own infrastructure calls, and it means the
 * policy engine is told who it is reasoning about by the same mechanism as
 * everything else.
 *
 * Failure is closed. If the policy engine is unreachable the request is
 * refused: a gateway that admits traffic whenever its policy engine is down has
 * a policy engine in name only.
 */
export function createPolicyStage(services: GatewayServices) {
  return async function policyStage(request: FastifyRequest): Promise<void> {
    const principal = request.principal;
    const tenant = request.tenant;
    const invocation = request.invocation;
    if (!principal || !tenant || !invocation) return;

    const target = services.targets['policy-engine'];
    const startedAt = performance.now();

    const policyToken = await services.tokenExchange.mint({
      principal,
      subjectToken: request.inboundToken ?? '',
      audience: target.audience,
      scopes: ['policy:evaluate'],
    });

    const result = await callUpstreamTool({
      url: target.url,
      server: 'policy-engine',
      toolName: 'policy.evaluate',
      accessToken: policyToken.accessToken,
      timeoutMs: 5_000,
      arguments: {
        tool: invocation.tool,
        server: invocation.server,
        bundle: 'baseline',
        principal: {
          subject: principal.subject,
          tenantId: principal.tenantId,
          role: principal.role,
          scopes: [...principal.scopes],
          territory: null,
        },
        tenant: { id: tenant.id, plan: tenant.plan },
        arguments: invocation.args,
      },
    });

    if (result.isError || !result.structured) {
      throw new UpstreamError('policy-engine', 'Policy evaluation did not return a decision', {
        detail: result.text.slice(0, 500),
      });
    }

    const parsed = policyDecisionSchema.safeParse({
      decision: result.structured.decision,
      ruleId: result.structured.ruleId,
      reason: result.structured.reason,
      rateTier: result.structured.rateTier ?? null,
      trace: [],
    });
    if (!parsed.success) {
      throw new UpstreamError('policy-engine', 'Policy decision failed validation');
    }

    const decision: PolicyDecision = parsed.data;
    invocation.policy = decision;

    const latencyMs = performance.now() - startedAt;
    policyLatency.record(latencyMs, { tenant: tenant.id });
    policyDecisions.add(1, {
      tenant: tenant.id,
      rule: decision.ruleId,
      effect: decision.decision,
      tool: invocation.tool,
    });
    annotate({
      [GatewayAttr.POLICY_RULE]: decision.ruleId,
      [GatewayAttr.DECISION]: decision.decision,
    });

    if (decision.decision === 'deny') {
      invocation.decision = 'deny';
      invocation.denyReason = `policy:${decision.ruleId}`;
      throw new PolicyDeniedError(decision.reason, {
        ruleId: decision.ruleId,
        tool: invocation.tool,
      });
    }
  };
}
