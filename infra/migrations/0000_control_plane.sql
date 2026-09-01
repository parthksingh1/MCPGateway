-- Control plane schema.
-- Mirrors packages/shared/src/db/schema.ts. Kept as checked-in SQL rather than
-- generated on the fly so that privilege grants and row-level security live
-- alongside the tables they protect.

CREATE TABLE IF NOT EXISTS tenants (
  id          text PRIMARY KEY,
  name        text NOT NULL,
  plan        text NOT NULL,
  region      text NOT NULL DEFAULT 'us-east-1',
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS users (
  id          text PRIMARY KEY,
  tenant_id   text NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  email       text NOT NULL,
  name        text NOT NULL,
  role        text NOT NULL,
  title       text NOT NULL DEFAULT '',
  territory   text,
  manager_id  text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS users_email_idx ON users (email);
CREATE INDEX IF NOT EXISTS users_tenant_idx ON users (tenant_id);

CREATE TABLE IF NOT EXISTS oauth_clients (
  client_id      text PRIMARY KEY,
  name           text NOT NULL,
  confidential   boolean NOT NULL DEFAULT true,
  redirect_uris  jsonb NOT NULL DEFAULT '[]'::jsonb,
  allowed_scopes jsonb NOT NULL DEFAULT '[]'::jsonb,
  allowed_grants jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS rate_limit_configs (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          text NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  scope_type         text NOT NULL CHECK (scope_type IN ('tenant', 'user_tool')),
  tool_name          text NOT NULL DEFAULT '*',
  tier               text NOT NULL DEFAULT 'default',
  capacity           integer NOT NULL CHECK (capacity >= 0),
  refill_tokens      integer NOT NULL CHECK (refill_tokens >= 0),
  refill_interval_ms integer NOT NULL CHECK (refill_interval_ms >= 0),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS rate_limit_lookup_idx
  ON rate_limit_configs (tenant_id, scope_type, tool_name, tier);

CREATE TABLE IF NOT EXISTS tenant_settings (
  tenant_id             text PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  audit_payload_capture boolean NOT NULL DEFAULT false,
  policy_bundle         text NOT NULL DEFAULT 'baseline',
  updated_at            timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Audit trail
-- ---------------------------------------------------------------------------

-- row_hash = sha256(prev_hash || canonical(row without its hash columns)).
-- Altering any historical row invalidates every hash after it in the same
-- tenant's chain.
CREATE TABLE IF NOT EXISTS audit_events (
  id              uuid PRIMARY KEY,
  seq             bigserial NOT NULL,
  ts              timestamptz NOT NULL,
  tenant_id       text NOT NULL,
  user_id         text NOT NULL,
  actor_token_jti text NOT NULL,
  mcp_server      text NOT NULL,
  tool_name       text NOT NULL,
  arguments_hash  char(64) NOT NULL,
  decision        text NOT NULL CHECK (decision IN ('allow', 'deny')),
  deny_reason     text,
  latency_ms      integer NOT NULL CHECK (latency_ms >= 0),
  trace_id        text,
  prev_hash       char(64) NOT NULL,
  row_hash        char(64) NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS audit_events_seq_idx ON audit_events (seq);
CREATE INDEX IF NOT EXISTS audit_events_ts_idx ON audit_events (ts DESC);
CREATE INDEX IF NOT EXISTS audit_events_tenant_ts_idx ON audit_events (tenant_id, ts DESC);
CREATE INDEX IF NOT EXISTS audit_events_tool_idx ON audit_events (tool_name);
CREATE INDEX IF NOT EXISTS audit_events_decision_idx ON audit_events (decision);
CREATE INDEX IF NOT EXISTS audit_events_trace_idx ON audit_events (trace_id);

-- One row per tenant. Locked FOR UPDATE inside the append transaction, which is
-- what gives the chain a total order across gateway replicas.
CREATE TABLE IF NOT EXISTS audit_chain_heads (
  tenant_id  text PRIMARY KEY,
  prev_hash  char(64) NOT NULL,
  length     integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Opt-in argument capture. Deliberately not part of the chain: the digest in
-- audit_events is what proves the call was not altered, and payloads carry
-- customer data that most tenants should not retain.
CREATE TABLE IF NOT EXISTS audit_payloads (
  event_id   uuid PRIMARY KEY,
  tenant_id  text NOT NULL,
  payload    jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
