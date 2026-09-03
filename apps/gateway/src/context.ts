import type { MirroredToken } from '@mcpgateway/auth';
import type { PolicyDecision, Principal, RateLimitVerdict } from '@mcpgateway/shared';

import type { GatewayServices, McpTarget } from './services.js';

export interface TenantRecord {
  readonly id: string;
  readonly name: string;
  readonly plan: string;
}

/**
 * State accumulated as a request moves through the pipeline.
 *
 * Every stage writes its outcome here rather than returning it up a call stack,
 * because the audit row has to be written whatever happens — including when a
 * stage refuses the request — and it needs whatever was decided before the
 * refusal.
 */
export interface InvocationState {
  readonly server: McpTarget['id'];
  readonly tool: string;
  readonly args: Record<string, unknown>;
  readonly startedAt: number;
  policy: PolicyDecision | null;
  rateLimit: RateLimitVerdict | null;
  tokenExchange: MirroredToken | null;
  decision: 'allow' | 'deny';
  denyReason: string | null;
  upstreamLatencyMs: number | null;
  audited: boolean;
}

declare module 'fastify' {
  interface FastifyInstance {
    services: GatewayServices;
  }

  interface FastifyRequest {
    /** Set by the auth plugin once the inbound token has been verified. */
    principal?: Principal;
    /** The raw inbound token, needed as the subject of the exchange. */
    inboundToken?: string;
    tenant?: TenantRecord;
    invocation?: InvocationState;
    requestId: string;
  }
}
