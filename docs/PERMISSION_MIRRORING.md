# Permission mirroring

## What it replaces

A typical MCP deployment configures one credential:

```jsonc
{
  "mcpServers": {
    "salesforce": {
      "env": { "SALESFORCE_TOKEN": "00D5f000...service-account" },
    },
  },
}
```

That token has to work for every user the agent serves, so it holds the union of everyone's
permissions. The agent knows who is asking; the CRM does not. Every user is silently operating at
the level of the most privileged one.

The usual mitigation is to filter in the agent: it knows the caller, so it appends a constraint. It
works until a code path forgets, or a prompt talks the model into a different query, or a new tool
ships without the filter. It is a convention, not a boundary.

## What it does instead

The gateway exchanges the caller's token for one addressed to a single downstream service, using
[RFC 8693](https://datatracker.ietf.org/doc/html/rfc8693):

```http
POST /token
Authorization: Basic <gateway client credentials>
Content-Type: application/x-www-form-urlencoded

grant_type=urn:ietf:params:oauth:grant-type:token-exchange
&subject_token=<the caller's access token>
&subject_token_type=urn:ietf:params:oauth:token-type:access_token
&requested_token_type=urn:ietf:params:oauth:token-type:access_token
&audience=mcp:salesforce
&scope=salesforce:read
```

The response is a token that still names the caller:

```jsonc
{
  "sub": "usr_alice", // unchanged — the CRM authorises Alice
  "aud": "mcp:salesforce", // one service, not all of them
  "scope": "salesforce:read", // narrowed to this audience's namespace
  "act": { "sub": "mcp-gateway" }, // who performed the exchange
  "tenant_id": "acme-corp",
  "role": "analyst",
  "exp": 1772539200, // minutes, not hours
}
```

## The full flow

```mermaid
sequenceDiagram
  autonumber
  participant A as Agent
  participant G as Gateway
  participant I as Identity provider
  participant R as Redis
  participant M as MCP server

  A->>G: tools/call, Bearer: Alice's token
  G->>I: GET /jwks (cached; refetched on unknown kid)
  G->>G: verify RS256, build Principal from claims only

  G->>R: GET tex:usr_alice:mcp:salesforce:<scope digest>
  alt cached and not near expiry
    R-->>G: downstream token
  else
    G->>I: POST /token (grant_type=token-exchange)
    I->>I: verify subject token
    I->>I: narrow scopes — see below
    I-->>G: exchanged token
    G->>G: assert sub matches the caller
    G->>R: SETEX min(remaining lifetime, max TTL)
  end

  G->>M: tools/call + traceparent, Bearer: exchanged token
  M->>I: GET /jwks
  M->>M: verify, require aud = mcp:salesforce
  M->>M: filter records by the token's scopes
  M-->>G: only what Alice may see
```

## Narrowing

Three filters compose. The result is a subset of all three, so a request can only ever narrow:

```ts
// apps/mock-idp/src/tokens.ts
return [...new Set(candidates)]
  .filter((scope) => entitled.has(scope)) // 1. the subject's own entitlements
  .filter((scope) => allowed.has(scope)) // 2. the client's registration
  .filter(namespaceFilter) // 3. the audience's namespace
  .sort();
```

1. **Subject entitlements** — derived from the person's role in the directory. An analyst is not
   entitled to `salesforce:read.all` no matter what is requested.
2. **Client registration** — the gateway's own OAuth client lists what it may ever ask for.
3. **Audience namespace** — `mcp:salesforce` may only receive `salesforce:*`. A token bound for the
   CRM cannot carry warehouse scopes, so a compromised CRM server holds nothing useful against the
   warehouse.

On top of that, the exchange intersects with the scopes already on the subject token. That is what
makes it an _exchange_ rather than a fresh grant: a caller who signed in with a narrow scope set
cannot recover breadth by asking for it later. Both properties are asserted in
`apps/mock-idp/src/server.test.ts`.

## Failing closed

```ts
// apps/gateway/src/plugins/token-exchange.ts — the whole error path
try {
  invocation.tokenExchange = await services.tokenExchange.mint({ ... });
} catch (error) {
  invocation.decision = 'deny';
  invocation.denyReason = 'permission_mirror:exchange_failed';
  throw error;
}
```

There is no `else`. A fallback to a service account would be one line and would hand every caller
the union of every user's permissions — the exact behaviour this exists to remove. The absence of
that line is the design.

The service also refuses a token whose subject does not match the caller:

```ts
if (claims.sub !== principal.subject) {
  throw new PermissionMirrorError('Exchanged token names a different subject than the caller', ...);
}
```

A provider returning a different subject has broken the contract, and continuing would mean
silently acting as somebody else.

## Caching

Exchanged tokens are cached in Redis under `tex:{subject}:{audience}:{scope digest}`.

- **Keyed by subject**, so one user's token can never be served to another. Asserted in
  `packages/auth/src/token-exchange.test.ts`.
- **Scope digest is order-insensitive**, so `read write` and `write read` share an entry.
- **TTL is `min(configured maximum, the token's own remaining lifetime − early refresh)`**, so a
  cached token is never served after it expires.
- **Concurrent callers share one exchange.** An in-flight map collapses a burst for the same key
  into a single request rather than a stampede against the provider.
- **A cache outage does not take authorisation with it** — a failed read falls through to a live
  exchange.

## Watching it work

```bash
pnpm oauth:walkthrough
pnpm oauth:walkthrough -- --email bob.martinez@acme-corp.com
```

Prints each step with decoded claims, then a comparison:

```
5. What changed
   subject           unchanged (usr_alice) — the downstream service authorises the human
   audience          dashboard-bff → mcp:salesforce
   scopes            9 → 1 (subset)
   dropped           openid profile email postgres:read postgres:query policy:evaluate ...
   actor             {"sub":"mcp-gateway"}
   lifetime          300s

6. Widening is not expressible
   requested         salesforce:read.all (an admin-only scope)
   result            refused — invalid_scope: Subject holds no scopes valid for audience
```

## The observable consequence

Alice (analyst) and Bob (her manager) call the identical tool with identical arguments:

```bash
POST /v1/servers/salesforce/tools/sf.list_opportunities
{ "arguments": { "limit": 200 } }
```

| Caller       | Scopes on the exchanged token          | Opportunities returned                                  |
| ------------ | -------------------------------------- | ------------------------------------------------------- |
| Alice        | `salesforce:read`                      | **26** — the ones she owns                              |
| Bob          | `salesforce:read salesforce:read.team` | **52** — the whole West territory                       |
| Dana (admin) | `+ salesforce:read.all`                | **100** — the whole tenant                              |
| Anyone       | —                                      | never the other 100 rows, which belong to other tenants |

Nothing in the request differs. The difference is entirely in the credential, which is the point.
Under a service account all three would see 100, and the difference between them would exist only in
whatever the application layer remembered to filter.

The visibility rules live in `apps/mcp-servers/salesforce/src/dataset.ts` and mirror how CRM sharing
actually works:

```ts
salesforce:read       → records the caller owns
salesforce:read.team  → + records owned by anyone in the same territory
salesforce:read.all   → + every record in the tenant
```

A team-scoped token with no territory claim falls back to own-records rather than widening — a
missing claim must never increase reach.

## In the warehouse

The Postgres server goes further and lets the database enforce it. Each statement runs in a
transaction that first assumes the role mirroring the caller's:

```sql
BEGIN READ ONLY;
SET LOCAL statement_timeout = 5000;
SELECT set_config('app.tenant_id', $1, true);
SELECT set_config('app.territory', $2, true);
SET LOCAL ROLE app_analyst;
```

Row-level security policies read those settings:

```sql
CREATE POLICY orders_own_territory ON orders FOR SELECT TO app_analyst, app_viewer
  USING (
    tenant_id = current_setting('app.tenant_id', true)
    AND territory = current_setting('app.territory', true)
  );
```

`FORCE ROW LEVEL SECURITY` is set, because without it the pool's login role owns the tables and
bypasses every policy — which would make the whole mechanism decorative.

If the application forgets a `WHERE` clause, or is talked into dropping one, the database still
returns only the rows that caller is entitled to. Every value in those settings comes from the
verified token; none can be influenced by a tool argument.

## Swapping in a real provider

The gateway speaks standard OAuth. Point it at a provider that supports RFC 8693 — Okta, Entra ID,
Auth0, Keycloak — and no gateway code changes:

```bash
OIDC_ISSUER=https://your-org.okta.com/oauth2/default
GATEWAY_CLIENT_ID=...
GATEWAY_CLIENT_SECRET=...
```

What you configure there instead of in `seed.json`: the audiences (`mcp:salesforce`,
`mcp:postgres`, `mcp:policy-engine`), a scope namespace per audience, and the token-exchange grant
on the gateway's client. `OIDC_ISSUER_INTERNAL` exists for the case where the provider is reachable
at a different address than the one it announces as its issuer — the gateway rebases back-channel
endpoints onto the reachable host while still checking the issuer claim exactly.
