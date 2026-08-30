import {
  context,
  propagation,
  SpanStatusCode,
  trace,
  type Attributes,
  type Span,
  type SpanOptions,
  type Tracer,
} from '@opentelemetry/api';

const TRACER_NAME = 'mcpgateway';

export function getTracer(name = TRACER_NAME): Tracer {
  return trace.getTracer(name, '0.1.0');
}

/** Trace id of the currently active span, or null when there is none. */
export function currentTraceId(): string | null {
  const span = trace.getActiveSpan();
  if (!span) return null;
  const ctx = span.spanContext();
  return ctx.traceId === '00000000000000000000000000000000' ? null : ctx.traceId;
}

export function currentSpanId(): string | null {
  const span = trace.getActiveSpan();
  if (!span) return null;
  const ctx = span.spanContext();
  return ctx.spanId === '0000000000000000' ? null : ctx.spanId;
}

/**
 * Run `fn` inside a new span, recording exceptions and setting the span status.
 * The span always ends, including on the error path.
 */
export async function withSpan<T>(
  name: string,
  fn: (span: Span) => Promise<T>,
  options: SpanOptions = {},
  tracerName = TRACER_NAME,
): Promise<T> {
  return getTracer(tracerName).startActiveSpan(name, options, async (span) => {
    try {
      const result = await fn(span);
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (error) {
      span.recordException(error instanceof Error ? error : new Error(String(error)));
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: error instanceof Error ? error.message : String(error),
      });
      throw error;
    } finally {
      span.end();
    }
  });
}

/** Add attributes to the active span, if one exists. */
export function annotate(attributes: Attributes): void {
  trace.getActiveSpan()?.setAttributes(attributes);
}

/**
 * Serialise the active context into W3C `traceparent` / `tracestate` headers.
 * This is what stitches gateway -> MCP server -> downstream into one trace.
 */
export function injectTraceHeaders(carrier: Record<string, string> = {}): Record<string, string> {
  propagation.inject(context.active(), carrier);
  return carrier;
}

/** Rebuild a parent context from inbound request headers. */
export function extractTraceContext(headers: Record<string, string | string[] | undefined>) {
  const carrier: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (typeof value === 'string') carrier[key.toLowerCase()] = value;
    else if (Array.isArray(value) && value[0] !== undefined) carrier[key.toLowerCase()] = value[0];
  }
  return propagation.extract(context.active(), carrier);
}

/** Execute `fn` with `ctx` as the active context. */
export function withContext<T>(ctx: ReturnType<typeof extractTraceContext>, fn: () => T): T {
  return context.with(ctx, fn);
}

/** Semantic attribute keys this project sets on its own spans. */
export const GatewayAttr = {
  TENANT_ID: 'mcpgw.tenant.id',
  USER_ID: 'mcpgw.user.id',
  USER_ROLE: 'mcpgw.user.role',
  MCP_SERVER: 'mcpgw.mcp.server',
  MCP_TOOL: 'mcpgw.mcp.tool',
  DECISION: 'mcpgw.decision',
  DENY_REASON: 'mcpgw.deny.reason',
  POLICY_RULE: 'mcpgw.policy.rule',
  TOKEN_EXCHANGE_CACHED: 'mcpgw.token_exchange.cached',
  TOKEN_AUDIENCE: 'mcpgw.token_exchange.audience',
  RATE_LIMIT_REMAINING: 'mcpgw.rate_limit.remaining',
  RATE_LIMIT_SCOPE: 'mcpgw.rate_limit.scope',
  AUDIT_SEQ: 'mcpgw.audit.seq',
} as const;
