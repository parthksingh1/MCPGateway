-- Append-only enforcement for the audit trail.
--
-- The hash chain makes tampering *detectable*. These grants make the ordinary
-- case — a bug, a careless migration, or a compromised gateway process —
-- structurally impossible rather than merely visible after the fact.
--
-- The gateway connects to Postgres twice:
--   * mcpgw       full access to the control plane, read access to audit rows
--   * mcpgw_audit INSERT on audit_events and nothing else
--
-- There is no UPDATE or DELETE grant on audit_events for any application role.
-- A statement that tries to rewrite history fails with a permission error at the
-- database, not with a warning in a log nobody reads.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'mcpgw_audit') THEN
    CREATE ROLE mcpgw_audit WITH LOGIN PASSWORD 'mcpgw_audit';
  END IF;
END
$$;

GRANT CONNECT ON DATABASE mcpgateway TO mcpgw_audit;
GRANT USAGE ON SCHEMA public TO mcpgw_audit;

-- Append only. Note the absence of UPDATE and DELETE.
GRANT INSERT ON TABLE audit_events TO mcpgw_audit;
GRANT USAGE, SELECT ON SEQUENCE audit_events_seq_seq TO mcpgw_audit;

-- The writer needs the sequence value its own INSERT allocated, so that the
-- caller can be told where the row landed. Postgres treats INSERT ... RETURNING
-- as a read, so a column-level grant on exactly that one column is required.
-- Granting SELECT on the whole table instead would let the audit role read every
-- tenant's event history, which is precisely what this split is avoiding.
GRANT SELECT (seq) ON TABLE audit_events TO mcpgw_audit;

-- The chain head must be read and advanced to link a new row, so this one table
-- is read-write. It holds a single hash per tenant and no event data: rewriting
-- it cannot forge history, it can only make verification fail loudly.
GRANT SELECT, INSERT, UPDATE ON TABLE audit_chain_heads TO mcpgw_audit;

-- Opt-in payload capture, when a tenant has enabled it.
GRANT INSERT ON TABLE audit_payloads TO mcpgw_audit;

-- The read path (console, verifier) uses the ordinary application role and is
-- read-only over audit data. Note that a REVOKE against the table owner is a
-- no-op in Postgres: owners hold their privileges implicitly. The owner case is
-- covered by the trigger below, not by grants.
GRANT SELECT ON TABLE audit_events TO mcpgw;
GRANT SELECT ON TABLE audit_chain_heads TO mcpgw;
GRANT SELECT ON TABLE audit_payloads TO mcpgw;

-- Belt and braces: a trigger that refuses the operation even if a future
-- migration hands out the privilege by accident. Superusers and the table owner
-- bypass grants, so the trigger is the layer that catches an owner-level mistake.
CREATE OR REPLACE FUNCTION audit_events_reject_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION
    'audit_events is append-only; % is not permitted (attempted on row %)',
    TG_OP, COALESCE(OLD.id::text, '(unknown)')
    USING ERRCODE = 'insufficient_privilege';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS audit_events_no_update ON audit_events;
CREATE TRIGGER audit_events_no_update
  BEFORE UPDATE OR DELETE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION audit_events_reject_mutation();
