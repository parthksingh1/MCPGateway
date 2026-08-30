-- Runs once, on first boot of an empty data directory.
--
-- Creates the two databases and the roles the system relies on. Privileges on
-- individual tables are granted by the migrations, because the tables do not
-- exist yet at this point.

CREATE DATABASE warehouse;

-- Least-privilege identity for the audit writer. The migration grants it INSERT
-- on audit_events and nothing else, so a compromised gateway process cannot
-- rewrite or delete history even though it can append to it.
CREATE ROLE mcpgw_audit WITH LOGIN PASSWORD 'mcpgw_audit';

-- Application roles mirrored one-to-one from the app-level roles in `users`.
-- The warehouse MCP server issues SET LOCAL ROLE per request based on the role
-- claim in the caller's downstream token, so row-level security in the database
-- enforces the same boundary the application believes it is enforcing.
CREATE ROLE app_admin NOLOGIN;
CREATE ROLE app_manager NOLOGIN;
CREATE ROLE app_analyst NOLOGIN;
CREATE ROLE app_viewer NOLOGIN;

GRANT app_admin, app_manager, app_analyst, app_viewer TO mcpgw;
