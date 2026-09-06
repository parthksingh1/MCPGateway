import { UpstreamError, UpstreamUnavailableError } from '@mcpgateway/shared';
import {
  injectTraceHeaders,
  upstreamLatency,
  withSpan,
  annotate,
  GatewayAttr,
} from '@mcpgateway/telemetry';

import { UpstreamClientPool } from './client-pool.js';

export interface UpstreamToolCall {
  /** Streamable HTTP endpoint of the target MCP server. */
  readonly url: string;
  readonly server: string;
  readonly toolName: string;
  readonly arguments: Record<string, unknown>;
  /** Downstream token minted for the caller and addressed to this server. */
  readonly accessToken: string;
  readonly timeoutMs?: number;
}

export interface UpstreamToolResult {
  readonly isError: boolean;
  readonly text: string;
  readonly structured: Record<string, unknown> | null;
  readonly latencyMs: number;
}

interface ContentBlock {
  type?: string;
  text?: string;
}

/**
 * Process-wide pool. Connections are per destination and are handed out
 * exclusively for the duration of a call — see client-pool.ts for why that is
 * what makes pooling safe when the credential differs per caller.
 */
const pool = new UpstreamClientPool();

/** Idle pooled connections per destination. Surfaced by readiness checks. */
export function upstreamPoolStats(): Record<string, number> {
  return pool.stats();
}

export async function closeUpstreamPool(): Promise<void> {
  await pool.close();
}

/**
 * Calls one tool on an upstream MCP server.
 *
 * The connection is taken from a pool, because the MCP `initialize` handshake
 * costs roughly four times the call itself and the gateway makes two upstream
 * calls per request. The per-caller token is applied at request time rather
 * than captured when the transport was built, and an entry is never shared
 * concurrently.
 *
 * `traceparent` is injected explicitly rather than relying solely on
 * auto-instrumentation, so propagation still holds if the SDK is disabled.
 */
export async function callUpstreamTool(call: UpstreamToolCall): Promise<UpstreamToolResult> {
  return withSpan(`mcp.call ${call.toolName}`, async () => {
    annotate({
      [GatewayAttr.MCP_SERVER]: call.server,
      [GatewayAttr.MCP_TOOL]: call.toolName,
    });

    const startedAt = performance.now();
    const headers = injectTraceHeaders({
      authorization: `Bearer ${call.accessToken}`,
    });

    try {
      return await pool.withClient(call.url, headers, async ({ client }) => {
        const result = await client.callTool(
          { name: call.toolName, arguments: call.arguments },
          undefined,
          { timeout: call.timeoutMs ?? 15_000 },
        );

        const latencyMs = performance.now() - startedAt;
        upstreamLatency.record(latencyMs, { server: call.server, tool: call.toolName });

        const blocks = Array.isArray(result.content) ? (result.content as ContentBlock[]) : [];
        const text = blocks
          .filter((block) => block.type === 'text' && typeof block.text === 'string')
          .map((block) => block.text)
          .join('\n');

        return {
          isError: result.isError === true,
          text,
          structured: isRecord(result.structuredContent) ? result.structuredContent : null,
          latencyMs,
        };
      });
    } catch (error) {
      const latencyMs = performance.now() - startedAt;
      upstreamLatency.record(latencyMs, { server: call.server, tool: call.toolName, error: true });

      if (isConnectionError(error)) {
        throw new UpstreamUnavailableError(call.server, error);
      }
      throw new UpstreamError(
        call.server,
        error instanceof Error ? error.message : 'Upstream tool call failed',
        { tool: call.toolName },
      );
    }
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isConnectionError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const message = error.message.toLowerCase();
  return (
    message.includes('econnrefused') ||
    message.includes('enotfound') ||
    message.includes('fetch failed') ||
    message.includes('socket hang up') ||
    message.includes('timeout')
  );
}
