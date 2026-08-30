import { z } from 'zod';

/** Commercial plan attached to a tenant. Policy rules key off this. */
export const planSchema = z.enum(['enterprise', 'pro', 'restricted']);
export type Plan = z.infer<typeof planSchema>;

/** Application-level role. Mirrored into a Postgres role of the same name. */
export const roleSchema = z.enum(['admin', 'manager', 'analyst', 'viewer']);
export type Role = z.infer<typeof roleSchema>;

export const decisionSchema = z.enum(['allow', 'deny']);
export type Decision = z.infer<typeof decisionSchema>;

export const mcpServerIdSchema = z.enum(['salesforce', 'postgres', 'policy-engine']);
export type McpServerId = z.infer<typeof mcpServerIdSchema>;

/**
 * The authenticated caller, derived solely from a verified access token.
 * Nothing in this object is client-supplied: every field comes out of a
 * signature-verified JWT.
 */
export const principalSchema = z.object({
  subject: z.string().min(1),
  tenantId: z.string().min(1),
  email: z.string().email().optional(),
  name: z.string().optional(),
  role: roleSchema,
  scopes: z.array(z.string()).readonly(),
  /** JWT ID of the inbound token; recorded in the audit row. */
  tokenId: z.string().min(1),
  clientId: z.string().min(1),
  expiresAt: z.number().int().positive(),
});
export type Principal = z.infer<typeof principalSchema>;

export const toolInvocationSchema = z.object({
  server: mcpServerIdSchema,
  tool: z.string().min(1),
  arguments: z.record(z.unknown()).default({}),
});
export type ToolInvocation = z.infer<typeof toolInvocationSchema>;

export const policyDecisionSchema = z.object({
  decision: decisionSchema,
  /** Identifier of the rule that produced the decision. */
  ruleId: z.string(),
  reason: z.string(),
  /** Every rule that was evaluated, in order, with its outcome. */
  trace: z
    .array(
      z.object({
        ruleId: z.string(),
        matched: z.boolean(),
        effect: decisionSchema.nullable(),
        detail: z.string().optional(),
      }),
    )
    .default([]),
  /** Optional rate-tier override applied by a matching rule. */
  rateTier: z.string().nullable().default(null),
});
export type PolicyDecision = z.infer<typeof policyDecisionSchema>;

export const rateLimitVerdictSchema = z.object({
  allowed: z.boolean(),
  remaining: z.number(),
  limit: z.number(),
  retryAfterMs: z.number(),
  scope: z.string(),
});
export type RateLimitVerdict = z.infer<typeof rateLimitVerdictSchema>;

export const auditEventSchema = z.object({
  id: z.string().uuid(),
  ts: z.coerce.date(),
  tenantId: z.string(),
  userId: z.string(),
  actorTokenJti: z.string(),
  mcpServer: z.string(),
  toolName: z.string(),
  argumentsHash: z.string().length(64),
  decision: decisionSchema,
  denyReason: z.string().nullable(),
  latencyMs: z.number().int().nonnegative(),
  traceId: z.string().nullable(),
  prevHash: z.string().length(64),
  rowHash: z.string().length(64),
  seq: z.number().int().nonnegative().optional(),
});
export type AuditEvent = z.infer<typeof auditEventSchema>;

/** Payload streamed to the console's live view over SSE. */
export const invocationEventSchema = z.object({
  id: z.string(),
  ts: z.string(),
  tenantId: z.string(),
  tenantName: z.string().optional(),
  userId: z.string(),
  userName: z.string().optional(),
  server: z.string(),
  tool: z.string(),
  decision: decisionSchema,
  denyReason: z.string().nullable(),
  latencyMs: z.number(),
  traceId: z.string().nullable(),
  tokenExchange: z
    .object({
      cached: z.boolean(),
      latencyMs: z.number(),
      audience: z.string(),
      downstreamSubject: z.string(),
    })
    .nullable()
    .default(null),
  policy: policyDecisionSchema.nullable().default(null),
  rateLimit: rateLimitVerdictSchema.nullable().default(null),
});
export type InvocationEvent = z.infer<typeof invocationEventSchema>;

/** Scope naming convention: `<server>:<action>`, e.g. `salesforce:read`. */
export function scopeFor(server: McpServerId, action: string): string {
  return `${server}:${action}`;
}

export function hasScope(held: readonly string[], required: string): boolean {
  if (held.includes(required)) return true;
  const [namespace] = required.split(':');
  return namespace !== undefined && held.includes(`${namespace}:*`);
}
