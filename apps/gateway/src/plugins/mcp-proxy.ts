import { callUpstreamTool } from '@mcpgateway/mcp-runtime';
import { PermissionMirrorError, UpstreamError } from '@mcpgateway/shared';
import { annotate, GatewayAttr } from '@mcpgateway/telemetry';
import type { FastifyRequest } from 'fastify';

import type { GatewayServices } from '../services.js';

export interface ProxyResult {
  readonly isError: boolean;
  readonly text: string;
  readonly structured: Record<string, unknown> | null;
  readonly latencyMs: number;
}

/**
 * Stage 7 of the pipeline.
 *
 * Forwards the tool call to the target MCP server over Streamable HTTP,
 * carrying the exchanged token and the current trace context. The target server
 * verifies that token independently — it does not trust the gateway's word for
 * who the caller is, which is what makes the gateway a policy enforcement point
 * rather than a single point of trust.
 */
export function createMcpProxy(services: GatewayServices) {
  return async function proxy(request: FastifyRequest): Promise<ProxyResult> {
    const invocation = request.invocation;
    if (!invocation) throw new UpstreamError('gateway', 'No invocation in flight');

    const token = invocation.tokenExchange;
    if (!token) {
      // Unreachable if the pipeline ran in order; asserted rather than assumed
      // because the failure mode would be calling upstream unauthenticated.
      throw new PermissionMirrorError('No downstream token was minted for this call', {
        server: invocation.server,
      });
    }

    const target = services.targets[invocation.server];
    annotate({
      [GatewayAttr.MCP_SERVER]: invocation.server,
      [GatewayAttr.MCP_TOOL]: invocation.tool,
    });

    const result = await callUpstreamTool({
      url: target.url,
      server: invocation.server,
      toolName: invocation.tool,
      arguments: invocation.args,
      accessToken: token.accessToken,
      timeoutMs: 20_000,
    });

    invocation.upstreamLatencyMs = result.latencyMs;

    // A tool that reports an error is still an allowed call: the caller was
    // permitted to make it and the upstream answered. Recording it as a denial
    // would conflate authorisation with outcome.
    if (result.isError) {
      invocation.denyReason = null;
    }

    return result;
  };
}
