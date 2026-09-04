# Security

## Read this first

**This is a portfolio project. Do not run it in production as it stands.**

It is not insecure by accident — the authorisation model, the audit guarantees and the isolation
properties are real and tested. But a repository that is meant to be cloned and run in ninety
seconds makes deliberate trade-offs that a production deployment must not inherit. They are listed
below, explicitly, rather than left for someone to discover.

## What must change before production

### Credentials

Every secret in this repository is a placeholder committed to git.

- `gateway-secret-change-me`, `dashboard-secret-change-me`, the Postgres passwords, the Grafana
  `admin` / `admin` login and the session cookie secret are all public.
- Move them to a secret manager and rotate on a schedule. Nothing in the code reads a secret from
  anywhere but the environment, so this is a deployment change.
- The `SESSION_COOKIE_SECRET` must be at least 32 random bytes per environment. The config schema
  enforces the length, not the randomness.

### Transport

- Everything runs over plain HTTP on localhost. Terminate TLS at the edge, and require TLS between
  the gateway and the MCP servers — the downstream token is a bearer credential in a header.
- Set `Strict-Transport-Security`, and the session cookie's `secure` flag turns on automatically
  once `GATEWAY_PUBLIC_URL` is `https` in production.
- Add the security headers this project does not set: `Content-Security-Policy`,
  `X-Content-Type-Options`, `Referrer-Policy`, `Permissions-Policy`.

### Identity provider

- `apps/mock-idp` is a real OIDC provider, but it is not a production one. It stores passwords in
  plaintext in `seed.json`, has no MFA, no account lockout, no password policy, no session
  management and no administrative audit of its own.
- Point `OIDC_ISSUER` at Okta, Entra ID, Auth0 or Keycloak. The gateway needs no code change; see
  the last section of `PERMISSION_MIRRORING.md` for what to configure there.
- Signing keys are generated at boot and never persisted, so every restart invalidates outstanding
  tokens. A real provider handles key rotation with overlap.

### Data protection

- Enable encryption at rest for both databases and for Redis.
- Redis holds exchanged access tokens and session records. Require `AUTH`, enable TLS, and put it on
  a network only the gateway can reach.
- Decide retention for `audit_events` and `audit_payloads` deliberately. Payload capture is off by
  default for a reason; if a tenant enables it, that data needs a deletion policy.

### The audit chain

- The chain detects tampering by anyone without table ownership. It does **not** defend against an
  attacker who owns the table, has time to rewrite the entire tail, and can update the chain head
  consistently.
- Close that by shipping the chain head somewhere the database role cannot reach: append it to a
  write-once log, publish it to a separate account's object store with object lock, or countersign
  it. Periodic anchoring of the head is the standard answer and does not require restructuring the
  log.
- Ship audit rows to a SIEM as well. A log that only lives in the system being audited is a log an
  attacker with that system can reason about.

### Availability

- The console's live stream is per-process. With several replicas a client only sees events from the
  one it connected to. Durability is unaffected — the audit table is the record — but an operator
  watching the stream should know. A Redis stream fixes it.
- Tenant context and rate-limit configuration are cached in memory with short TTLs; a change is
  visible within seconds, not instantly, except for rate limits which are invalidated over pub/sub.
- There is no circuit breaker in front of the MCP servers. A slow upstream will consume gateway
  concurrency up to the request timeout.
- The gateway has no request queue or shed-load mechanism beyond rate limiting.

### Operations

- No admin authentication beyond the `gateway:admin` scope. There is no approval flow, no change
  audit for configuration edits, and no separation of duties.
- Container images run as `node` but have not been scanned. Add image scanning and a base image
  update policy.
- No supply-chain attestation. Add provenance and dependency review to CI.
- Postgres roles are created by migrations with passwords in the file. In production, create roles
  out of band.

## What is genuinely enforced

So that the list above is not read as "none of it is real":

| Property                                         | How                                               | Verified by                                 |
| ------------------------------------------------ | ------------------------------------------------- | ------------------------------------------- |
| A downstream call carries the caller's identity  | RFC 8693 exchange, `sub` preserved and checked    | `token-exchange.test.ts`, `gateway.test.ts` |
| An exchange can only narrow authority            | Intersection of three filters at the provider     | `mock-idp/src/server.test.ts`               |
| A failed exchange refuses the request            | No fallback path exists in the code               | `gateway.test.ts`                           |
| A token for one server cannot be used on another | Per-server `aud` required at verification         | `mcp-runtime`, `verify.test.ts`             |
| Rate limits are exact under concurrency          | Single Lua script, atomic in Redis                | 500-concurrent integration test             |
| Audit rows cannot be altered or deleted          | Role grants plus a guard trigger                  | `audit.test.ts`                             |
| Tampering is detectable and localised            | Per-tenant hash chain over canonical JSON         | `hash.test.ts`, `audit.test.ts`             |
| Tenant isolation in the warehouse                | Row-level security with `FORCE`, `SET LOCAL ROLE` | `gateway.test.ts`                           |
| The console cannot leak a bearer token           | BFF pattern; browser holds an opaque session id   | `bff.ts`                                    |
| Secrets do not reach logs                        | pino path-based redaction                         | `logger.ts`                                 |

## Deliberate design decisions

**Fail closed everywhere.** Policy engine unreachable, exchange refused, tenant unknown, scope
missing — all refuse the request. A gateway that admits traffic when its checks are unavailable has
checks in name only.

**Nothing is trusted from the request.** Subject, tenant, role, territory and scopes all come from a
signature-verified token. There is no header, query parameter or body field that changes who the
caller is.

**Not-found is indistinguishable from not-permitted.** `sf.get_contact` returns the same error for a
record that does not exist and one the caller may not see. Distinguishing them confirms the record's
existence to someone with no right to know it.

**Least privilege between the system's own components.** The gateway holds two database roles. The
audit role has `INSERT` plus a column-level `SELECT` on one column. The warehouse pool assumes a
per-request role with only `SELECT`. An MCP server has no service credential at all.

**Defence in depth on the warehouse.** Three layers: a static SQL guard, a read-only transaction
with `SELECT`-only grants, and row-level security. The guard is the outermost and the least
load-bearing — bypassing it entirely still yields a read restricted to the caller's own rows. It
exists to produce a clear, fast, auditable refusal rather than an opaque database error.

**Algorithm allow-list on token verification.** Accepting whatever the token header asks for is how
`alg: none` and HMAC-confusion attacks get in.

**Authorization codes and login state are single-use.** Consumed before validation, so a replay
cannot succeed even if the first attempt failed for another reason.

**PKCE on a confidential client.** OAuth 2.1 requires it for every authorization-code flow and it
costs nothing.

## Reporting

This is a portfolio repository with no production deployment. If you find a flaw in the reasoning
above, open an issue — being wrong about a security property in public is more useful to me than
being quietly wrong in private.
