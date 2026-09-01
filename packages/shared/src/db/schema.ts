import {
  bigserial,
  boolean,
  char,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

/** Control-plane schema. The analytics warehouse lives in its own database. */

export const tenants = pgTable('tenants', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  plan: text('plan').notNull(),
  region: text('region').notNull().default('us-east-1'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const users = pgTable(
  'users',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    email: text('email').notNull(),
    name: text('name').notNull(),
    role: text('role').notNull(),
    title: text('title').notNull().default(''),
    /** Sales territory / book of business, used by scope-based row filtering. */
    territory: text('territory'),
    managerId: text('manager_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    emailIdx: uniqueIndex('users_email_idx').on(table.email),
    tenantIdx: index('users_tenant_idx').on(table.tenantId),
  }),
);

export const oauthClients = pgTable('oauth_clients', {
  clientId: text('client_id').primaryKey(),
  name: text('name').notNull(),
  confidential: boolean('confidential').notNull().default(true),
  redirectUris: jsonb('redirect_uris').$type<string[]>().notNull().default([]),
  allowedScopes: jsonb('allowed_scopes').$type<string[]>().notNull().default([]),
  allowedGrants: jsonb('allowed_grants').$type<string[]>().notNull().default([]),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Token-bucket configuration. `scopeType` selects the key the limiter builds:
 *   tenant     -> rl:{tenant}
 *   user_tool  -> rl:{tenant}:{user}:{tool}
 * A row with a `toolName` of `*` is the tenant-wide default for user_tool scope.
 */
export const rateLimitConfigs = pgTable(
  'rate_limit_configs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: text('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    scopeType: text('scope_type').notNull(),
    toolName: text('tool_name').notNull().default('*'),
    tier: text('tier').notNull().default('default'),
    /** Bucket size: the largest burst a caller may spend at once. */
    capacity: integer('capacity').notNull(),
    /** Tokens added every `refillIntervalMs`. */
    refillTokens: integer('refill_tokens').notNull(),
    refillIntervalMs: integer('refill_interval_ms').notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    lookupIdx: uniqueIndex('rate_limit_lookup_idx').on(
      table.tenantId,
      table.scopeType,
      table.toolName,
      table.tier,
    ),
  }),
);

/**
 * Append-only audit trail. `rowHash = sha256(prevHash || canonical(row))`, so
 * altering any historical row invalidates every hash after it. The gateway
 * connects as a role holding INSERT only — see the migration for the grant.
 */
export const auditEvents = pgTable(
  'audit_events',
  {
    id: uuid('id').primaryKey(),
    seq: bigserial('seq', { mode: 'number' }).notNull(),
    ts: timestamp('ts', { withTimezone: true }).notNull(),
    tenantId: text('tenant_id').notNull(),
    userId: text('user_id').notNull(),
    actorTokenJti: text('actor_token_jti').notNull(),
    mcpServer: text('mcp_server').notNull(),
    toolName: text('tool_name').notNull(),
    argumentsHash: char('arguments_hash', { length: 64 }).notNull(),
    decision: text('decision').notNull(),
    denyReason: text('deny_reason'),
    latencyMs: integer('latency_ms').notNull(),
    traceId: text('trace_id'),
    prevHash: char('prev_hash', { length: 64 }).notNull(),
    rowHash: char('row_hash', { length: 64 }).notNull(),
  },
  (table) => ({
    seqIdx: uniqueIndex('audit_events_seq_idx').on(table.seq),
    tsIdx: index('audit_events_ts_idx').on(table.ts),
    tenantTsIdx: index('audit_events_tenant_ts_idx').on(table.tenantId, table.ts),
    toolIdx: index('audit_events_tool_idx').on(table.toolName),
    decisionIdx: index('audit_events_decision_idx').on(table.decision),
  }),
);

/**
 * Opt-in argument capture. Off unless a tenant enables it, because tool
 * arguments routinely contain customer data and the chain only needs the digest.
 */
export const auditPayloads = pgTable(
  'audit_payloads',
  {
    eventId: uuid('event_id').notNull(),
    tenantId: text('tenant_id').notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({ pk: primaryKey({ columns: [table.eventId] }) }),
);

/** Per-tenant switches surfaced in the console settings page. */
export const tenantSettings = pgTable('tenant_settings', {
  tenantId: text('tenant_id')
    .primaryKey()
    .references(() => tenants.id, { onDelete: 'cascade' }),
  auditPayloadCapture: boolean('audit_payload_capture').notNull().default(false),
  policyBundle: text('policy_bundle').notNull().default('baseline'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export type TenantRow = typeof tenants.$inferSelect;
export type UserRow = typeof users.$inferSelect;
export type RateLimitConfigRow = typeof rateLimitConfigs.$inferSelect;
export type AuditEventRow = typeof auditEvents.$inferSelect;
export type OAuthClientRow = typeof oauthClients.$inferSelect;

/**
 * Head of each tenant's audit chain.
 *
 * Appending is serialised by taking a row lock here inside the same
 * transaction as the insert, which is what guarantees a total order per tenant
 * even with several gateway replicas writing at once. The lock is per tenant,
 * so tenants never contend with each other.
 */
export const auditChainHeads = pgTable('audit_chain_heads', {
  tenantId: text('tenant_id').primaryKey(),
  prevHash: char('prev_hash', { length: 64 }).notNull(),
  length: integer('length').notNull().default(0),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export type AuditChainHeadRow = typeof auditChainHeads.$inferSelect;
