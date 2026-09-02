import { GatewayError, ScopeDeniedError, isGatewayError } from '@mcpgateway/shared';
import { ErrorCode as McpErrorCode } from '@modelcontextprotocol/sdk/types.js';
import type { z, ZodRawShape } from 'zod';

import type { ToolContext } from './context.js';

/**
 * A tool exposed over MCP.
 *
 * `requiredScopes` is declared next to the handler rather than checked inside
 * it, so the authorisation requirement of every tool is visible in one place
 * and cannot be forgotten in a new handler.
 */
export interface ToolDefinition<Shape extends ZodRawShape> {
  readonly name: string;
  readonly title?: string;
  readonly description: string;
  readonly inputSchema: Shape;
  readonly requiredScopes: readonly string[];
  /** Advertised to clients; purely informational. */
  readonly readOnly?: boolean;
  handler(args: z.objectOutputType<Shape, z.ZodTypeAny>, context: ToolContext): Promise<unknown>;
}

/** Identity helper that preserves the shape's inferred argument type. */
export function defineTool<Shape extends ZodRawShape>(
  definition: ToolDefinition<Shape>,
): ToolDefinition<Shape> {
  return definition;
}

export { ScopeDeniedError };

/**
 * Map an application error onto an MCP error code.
 *
 * MCP carries JSON-RPC error codes, which are far coarser than this system's
 * error taxonomy. The code is what a client can branch on; the message and the
 * structured data carry the detail an operator needs.
 */
export function toMcpErrorCode(error: unknown): number {
  if (!isGatewayError(error)) return McpErrorCode.InternalError;
  switch (error.status) {
    case 400:
      return McpErrorCode.InvalidParams;
    case 401:
    case 403:
      // JSON-RPC has no authorisation code. InvalidRequest is the closest
      // honest mapping; the HTTP layer has already returned 401/403 where the
      // failure happened before dispatch.
      return McpErrorCode.InvalidRequest;
    case 404:
      return McpErrorCode.MethodNotFound;
    default:
      return McpErrorCode.InternalError;
  }
}

export interface ToolFailure {
  readonly code: number;
  readonly message: string;
  readonly data: Record<string, unknown>;
}

export function describeFailure(error: unknown): ToolFailure {
  if (error instanceof GatewayError) {
    return {
      code: toMcpErrorCode(error),
      message: error.message,
      data: { code: error.code, ...error.details },
    };
  }
  return {
    code: McpErrorCode.InternalError,
    message: error instanceof Error ? error.message : 'Unexpected error',
    data: { code: 'internal_error' },
  };
}
