import { UpstreamError, UpstreamUnavailableError } from '@mcpgateway/shared';
import {
  injectTraceHeaders,
  upstreamLatency,
  withSpan,
  annotate,
  GatewayAttr,
} from '@mcpgateway/telemetry';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

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
 * Calls one tool on an upstream MCP server.
 *
 * A client is created per call rather than pooled. The Authorization header is
 * fixed at transport construction, and the token differs for every caller, so a
 * pooled client would either have to mutate shared state or risk sending one
 * user's token on another user's request. Connection reuse is handled a layer
 * down by the HTTP agent, which is where it belongs.
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

    const transport = new StreamableHTTPClientTransport(new URL(call.url), {
      requestInit: { headers },
    });
    const client = new Client({ name: 'mcpgateway', version: '0.1.0' }, { capabilities: {} });

    try {
      await client.connect(transport);

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
    } finally {
      await client.close().catch(() => undefined);
      await transport.close().catch(() => undefined);
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
