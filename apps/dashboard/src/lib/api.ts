/**
 * Typed client for the gateway.
 *
 * Every request carries the session cookie and nothing else — the console never
 * holds a bearer token, so there is no header to attach and nothing for a
 * script injection to steal. A 401 means the session has gone, and the caller
 * is sent back to sign in rather than shown a broken page.
 */

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    ...init,
    credentials: 'include',
    headers: {
      accept: 'application/json',
      ...(init.body ? { 'content-type': 'application/json' } : {}),
      ...init.headers,
    },
  });

  if (response.status === 204) return undefined as T;

  const body: unknown = await response.json().catch(() => null);

  if (!response.ok) {
    const error =
      body && typeof body === 'object' && 'error' in body
        ? (body.error as { code?: string; message?: string; details?: unknown })
        : null;
    throw new ApiError(
      response.status,
      error?.code ?? 'request_failed',
      error?.message ?? `Request failed with status ${response.status}`,
      error?.details,
    );
  }

  return body as T;
}

// ---------------------------------------------------------------- session

export interface SessionUser {
  subject: string;
  email: string;
  name: string;
  role: string;
  tenantId: string;
  tenantName: string;
  tenantPlan: string;
  scopes: string[];
}

export interface Session {
  authenticated: true;
  user: SessionUser;
  links: { traces: string; metrics: string };
}

export const api = {
  session: () => request<Session>('/auth/session'),
  logout: () => request<{ ok: boolean }>('/auth/logout', { method: 'POST' }),
  loginUrl: (redirectTo = '/') => `/auth/login?redirect=${encodeURIComponent(redirectTo)}`,

  overview: (range: string) => request<Overview>(`/api/overview?range=${range}`),

  /** Unauthenticated: used by the sidebar's dependency panel. */
  readiness: () => request<Readiness>('/readyz'),

  audit: (params: AuditParams) => {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== '') query.set(key, String(value));
    }
    return request<AuditPage>(`/api/audit?${query.toString()}`);
  },

  verifyChain: () => request<ChainVerification>('/api/audit/verify', { method: 'POST' }),

  rateLimits: () => request<RateLimitsResponse>('/api/rate-limits'),
  updateRateLimit: (id: string, body: RateLimitUpdate) =>
    request<{ ok: boolean }>(`/api/rate-limits/${id}`, {
      method: 'PUT',
      body: JSON.stringify(body),
    }),

  policies: () => request<PolicyBundle>('/api/policies'),
  evaluatePolicy: (body: PolicyProbe) =>
    request<PolicyExplanation>('/api/policies/evaluate', {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  tenant: () => request<TenantResponse>('/api/tenants'),
  clients: () => request<{ clients: OAuthClientRow[] }>('/api/clients'),
  catalog: () => request<{ tools: CatalogTool[] }>('/api/catalog'),

  callTool: (server: string, tool: string, args: Record<string, unknown>) =>
    request<ToolCallResult>(`/v1/servers/${server}/tools/${tool}`, {
      method: 'POST',
      body: JSON.stringify({ arguments: args }),
    }),
};

// ------------------------------------------------------------------ types

export type HealthState = 'ok' | 'degraded' | 'down';

export interface Readiness {
  ready: boolean;
  checks: Record<string, HealthState>;
  jwks: { keys: number; hits: number; misses: number; fetches: number };
  upstreamPool?: Record<string, number>;
}

export interface Overview {
  range: string;
  since: string;
  totals: { invocations: number; allowed: number; denied: number; denyRate: number };
  latency: { p50: number; p95: number; p99: number };
  topTools: { tool: string; count: number }[];
  topTenants: { tenantId: string; name: string | null; count: number }[];
  series: { bucket: string; allowed: number; denied: number; p95LatencyMs: number }[];
  liveListeners: number;
}

export interface AuditParams {
  limit?: number;
  offset?: number;
  decision?: string;
  tool?: string;
  server?: string;
  user?: string;
  search?: string;
  range?: string;
}

export interface AuditRow {
  id: string;
  seq: number;
  ts: string;
  tenantId: string;
  userId: string;
  userName: string | null;
  actorTokenJti: string;
  mcpServer: string;
  toolName: string;
  argumentsHash: string;
  decision: 'allow' | 'deny';
  denyReason: string | null;
  latencyMs: number;
  traceId: string | null;
  prevHash: string;
  rowHash: string;
}

export interface AuditPage {
  rows: AuditRow[];
  total: number;
  limit: number;
  offset: number;
}

export interface ChainVerification {
  tenantId: string;
  valid: boolean;
  rowsChecked: number;
  durationMs: number;
  headHash: string;
  recordedHeadHash: string | null;
  firstBreak: {
    seq: number | null;
    id: string;
    reason: string;
    expected: string;
    actual: string;
  } | null;
}

export interface RateLimitConfig {
  id: string;
  scopeType: string;
  toolName: string;
  tier: string;
  capacity: number;
  refillTokens: number;
  refillIntervalMs: number;
  updatedAt: string;
}

export interface RateLimitsResponse {
  configs: RateLimitConfig[];
  buckets: { key: string; tokens: number | null; updatedAt: number | null }[];
}

export interface RateLimitUpdate {
  capacity: number;
  refillTokens: number;
  refillIntervalMs: number;
}

export interface PolicyRule {
  id: string;
  priority: number;
  effect: 'allow' | 'deny' | 'annotate';
  description: string;
  reason: string | null;
  rateTier: string | null;
  match: unknown;
}

export interface PolicyBundle {
  bundle: string;
  defaultEffect: string;
  rules: PolicyRule[];
}

export interface PolicyProbe {
  tool: string;
  server: string;
  role: string;
  scopes: string[];
  arguments: Record<string, unknown>;
}

export interface PolicyExplanation {
  decision: 'allow' | 'deny';
  ruleId: string;
  reason: string;
  rateTier: string | null;
  defaultEffect: string;
  decidingRule: { id: string; priority: number; description: string } | null;
  trace: { ruleId: string; matched: boolean; effect: string | null; detail?: string }[];
  durationMs: number;
}

export interface TenantResponse {
  tenant: {
    id: string;
    name: string;
    plan: string;
    region: string;
    users: number;
    createdAt: string;
  } | null;
  users: { id: string; name: string; email: string; role: string; territory: string | null }[];
}

export interface OAuthClientRow {
  client_id: string;
  name: string;
  confidential: boolean;
  allowed_scopes: string[];
  allowed_grants: string[];
  redirect_uris: string[];
}

export interface CatalogTool {
  name: string;
  server: string;
  title: string;
  description: string;
  requiredScopes: string[];
  readOnly: boolean;
  permitted?: boolean;
}

export interface ToolCallResult {
  ok: boolean;
  server: string;
  tool: string;
  result: Record<string, unknown>;
  meta: {
    requestId: string;
    latencyMs: number;
    upstreamLatencyMs: number;
    policy: { ruleId: string; decision: string } | null;
    tokenExchange: {
      audience: string;
      cached: boolean;
      scopes: string[];
      subject: string;
    } | null;
    rateLimit: { remaining: number; limit: number; scope: string } | null;
  };
}

export interface InvocationEvent {
  id: string;
  ts: string;
  tenantId: string;
  tenantName?: string;
  userId: string;
  userName?: string;
  server: string;
  tool: string;
  decision: 'allow' | 'deny';
  denyReason: string | null;
  latencyMs: number;
  traceId: string | null;
  tokenExchange: {
    cached: boolean;
    latencyMs: number;
    audience: string;
    downstreamSubject: string;
  } | null;
  policy: { decision: string; ruleId: string; reason: string; rateTier: string | null } | null;
  rateLimit: { allowed: boolean; remaining: number; limit: number; scope: string } | null;
}
