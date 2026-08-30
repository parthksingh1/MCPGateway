import { z } from 'zod';

import { ConfigurationError } from './errors.js';

/**
 * Every process validates its environment through this module at boot and exits
 * non-zero on a bad value. A gateway that starts with, say, a missing issuer and
 * only discovers it on the first request is a gateway that fails open in
 * production; failing at boot is the cheaper failure.
 */

const port = z.coerce.number().int().min(1).max(65_535);
const url = z.string().url();
const bool = z
  .enum(['true', 'false', '1', '0'])
  .transform((v) => v === 'true' || v === '1')
  .or(z.boolean());

const baseSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  OTEL_EXPORTER_OTLP_ENDPOINT: url.default('http://localhost:4318'),
  OTEL_SDK_DISABLED: bool.default(false),
  SERVICE_VERSION: z.string().default('0.1.0'),
});

export const gatewayConfigSchema = baseSchema.extend({
  GATEWAY_PORT: port.default(8080),
  GATEWAY_HOST: z.string().default('0.0.0.0'),
  GATEWAY_PUBLIC_URL: url.default('http://localhost:8080'),
  DASHBOARD_ORIGIN: url.default('http://localhost:3000'),

  DATABASE_URL: z.string().min(1),
  AUDIT_DATABASE_URL: z.string().min(1).optional(),
  REDIS_URL: z.string().min(1),

  OIDC_ISSUER: url,
  OIDC_ISSUER_INTERNAL: url.optional(),
  GATEWAY_CLIENT_ID: z.string().min(1),
  GATEWAY_CLIENT_SECRET: z.string().min(1),
  DASHBOARD_CLIENT_ID: z.string().min(1).default('dashboard-bff'),
  DASHBOARD_CLIENT_SECRET: z.string().min(1),
  SESSION_COOKIE_SECRET: z.string().min(32, 'SESSION_COOKIE_SECRET must be at least 32 chars'),

  MCP_SALESFORCE_URL: url,
  MCP_POSTGRES_URL: url,
  MCP_POLICY_URL: url,

  TOKEN_EXCHANGE_CACHE_MAX_TTL_SECONDS: z.coerce.number().int().min(10).max(3600).default(300),
  AUDIT_PAYLOAD_CAPTURE: bool.default(false),
  JAEGER_UI_URL: url.default('http://localhost:16686'),
  GRAFANA_URL: url.default('http://localhost:3001'),
});
export type GatewayConfig = z.infer<typeof gatewayConfigSchema>;

export const idpConfigSchema = baseSchema.extend({
  IDP_PORT: port.default(9000),
  IDP_ISSUER: url.default('http://localhost:9000'),
  IDP_SIGNING_KEY_SEED: z.string().min(8).default('mcpgateway-local-signing-seed'),
  IDP_ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().min(60).max(86_400).default(900),
});
export type IdpConfig = z.infer<typeof idpConfigSchema>;

export const mcpServerConfigSchema = baseSchema.extend({
  PORT: port,
  SERVICE_NAME: z.string().min(1),
  OIDC_ISSUER: url,
  OIDC_ISSUER_INTERNAL: url.optional(),
  /** Audience this server accepts in downstream tokens. */
  EXPECTED_AUDIENCE: z.string().min(1),
});
export type McpServerConfig = z.infer<typeof mcpServerConfigSchema>;

export const warehouseConfigSchema = mcpServerConfigSchema.extend({
  WAREHOUSE_DATABASE_URL: z.string().min(1),
  PG_STATEMENT_TIMEOUT_MS: z.coerce.number().int().min(100).max(60_000).default(5_000),
  PG_MAX_ROWS: z.coerce.number().int().min(1).max(10_000).default(500),
});
export type WarehouseConfig = z.infer<typeof warehouseConfigSchema>;

/**
 * Parse `source` against `schema`, throwing a `ConfigurationError` whose message
 * lists every offending variable rather than only the first.
 */
export function loadConfig<T extends z.ZodTypeAny>(
  schema: T,
  source: NodeJS.ProcessEnv = process.env,
): z.infer<T> {
  const result = schema.safeParse(source);
  if (result.success) return result.data;

  const issues = result.error.issues.map((issue) => {
    const path = issue.path.join('.') || '(root)';
    return `  ${path}: ${issue.message}`;
  });
  throw new ConfigurationError(
    `Invalid environment configuration:\n${issues.join('\n')}\n\nSee .env.example for the full list.`,
    { issues: result.error.issues },
  );
}
