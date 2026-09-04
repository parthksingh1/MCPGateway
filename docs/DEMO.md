# Ten-minute walkthrough

A script you can read aloud. Times are the pace to aim for, not a limit.

**Before you start:** run `make demo` once ahead of time so images are built and data is loaded. A
second `make demo` takes seconds; the first takes minutes.

---

## 0 · Bring it up — 60 seconds

```bash
make demo
```

> While that runs: what is starting is a gateway, an identity provider, three MCP servers, Postgres,
> Redis, and a full observability stack — a collector, Jaeger, Prometheus, Loki and Grafana. It also
> migrates, loads three tenants with twelve users, generates a fifty-thousand-row warehouse and
> writes a week of audit history. The audit history goes through the real writer, so the hash chain
> it produces genuinely verifies — seeding it with fabricated hashes would make the verifier's green
> tick meaningless the first time anyone checked.

End with the URL banner it prints.

---

## 1 · The problem — 45 seconds

> Most MCP deployments today put a service-account token in a config file. It has to work for every
> user the agent serves, so it holds the union of everyone's permissions. The agent knows who is
> asking; the downstream system does not. Every user is silently operating at the level of the most
> privileged one.
>
> The usual fix is to filter in the agent — it knows the caller, so it adds a `WHERE` clause. That
> works exactly as long as every code path remembers to. It is a convention, not a boundary, and a
> convention is not what you want between a language model and a customer database.
>
> This moves the boundary back to where it can be enforced.

---

## 2 · Alice — 90 seconds

Open <http://localhost:3000>, sign in as `alice.chen@acme-corp.com` / `Passw0rd!`.

> Alice is a revenue analyst at Acme. Note the sign-in page: the console never receives an access
> token. The OAuth flow terminates in a backend-for-frontend and the browser gets an opaque session
> cookie, so a cross-site scripting bug in this UI cannot exfiltrate a bearer credential.

Land on **Overview**. Point at the volume chart and the p95/p99 tiles.

> This is a week of real traffic from the audit log — not a metrics estimate. The percentiles come
> from `percentile_disc` over the audit rows, so the numbers here always agree with the rows you can
> click through to.

Go to **Live requests**, leave it open, and in another terminal:

```bash
curl -s -X POST localhost:8080/v1/servers/salesforce/tools/sf.list_opportunities \
  -H "Authorization: Bearer $(pnpm -s oauth:walkthrough --print-token 2>/dev/null || echo TOKEN)" \
  -d '{"arguments":{"limit":200}}'
```

Simpler for a live demo: go to **Policies**, use the evaluate form, or just narrate the seeded
traffic already streaming.

Expand a row in the live view.

> Every call shows what happened to it: which policy rule decided, whether the downstream token was
> minted or served from cache, how many rate-limit tokens remain, and a link straight to the trace.

---

## 3 · Bob — 90 seconds. **This is the demo.**

Sign out. Sign in as `bob.martinez@acme-corp.com` / `Passw0rd!`. Bob is Alice's manager.

Make the same call both times — the cleanest way is two terminals side by side, or the console's
policy page. What matters is the number.

| Caller       | Same tool, same arguments | Opportunities |
| ------------ | ------------------------- | ------------- |
| Alice        | `sf.list_opportunities`   | **26**        |
| Bob          | `sf.list_opportunities`   | **52**        |
| Dana (admin) | `sf.list_opportunities`   | **100**       |

> Identical request. Identical arguments. Different answers.
>
> This is not role-based access control in the application layer. Nothing in the CRM server knows
> anything about Alice or Bob. What differs is the credential: the gateway exchanged each person's
> own token for one scoped to them, and the CRM server filtered on the scopes in the token it was
> handed. Alice's token carries `salesforce:read`, which means the records she owns. Bob's also
> carries `salesforce:read.team`, which adds his territory.
>
> Under a service account both would see all one hundred, and the difference between them would
> exist only in whatever the application remembered to filter.

If you have a spare thirty seconds, run this in a terminal:

```bash
pnpm oauth:walkthrough
```

> That is the real flow, printed step by step. Look at step five: the subject is unchanged, the
> audience narrowed to one service, nine scopes became one, and there is an actor claim naming the
> gateway — "Alice, acting through the gateway". Step six asks for an admin-only scope and gets
> refused. Widening is not expressible.

---

## 4 · A policy denial — 60 seconds

Sign in as `liam.novak@initech.dev` / `Passw0rd!`. Initech is on the restricted plan.

Go to **Policies** and run the evaluate form, or make the call:

```jsonc
// sf.query
{ "soql": "SELECT Id, Email, Phone FROM Contact" }
```

It is refused: `deny-pii-on-restricted-plan`.

> Initech has not signed the data processing terms that cover personal data leaving the source
> system, so queries reaching for identifying columns are refused regardless of the caller's role.
>
> Two things to notice. First, the policy engine is called _before_ any token is minted — no
> credential is created for a call that is going to be refused. Second, the gateway calls the policy
> engine with Liam's own exchanged token, not a service credential. There is no exception carved out
> for the gateway's own infrastructure calls.

Show the same request succeeding as Alice — enterprise plan, same query, allowed.

Then open **Live requests** or **Audit log** and show the denial recorded there.

> Denials are the rows that matter most. A log containing only successful calls tells an
> investigator nothing about what was attempted.

---

## 5 · The audit chain — 2 minutes

On the **Audit log** page, click **Verify chain**.

> Green. That recomputed every hash from this tenant's genesis value and confirmed each link. It is
> not reading a stored flag.

Expand any row to show the chain position — previous hash, this row's hash, and the arguments
digest.

> Arguments are stored as a SHA-256 digest, not in full. Tool arguments routinely carry customer
> data, and the chain only needs the digest to prove the call was not altered.

Now the terminal:

```bash
pnpm verify:audit --corrupt-row 42
```

Read the output as it appears.

> Note what the script has to do to alter a row: disable a guard trigger, which requires ownership of
> the table. The gateway's own database role holds `INSERT` and a column-level `SELECT` on one
> column — it cannot reach this code path at all.
>
> One field changed by one millisecond, and the chain no longer verifies. It names the exact row and
> shows both hashes. Then it restores it.

If asked "what if someone recomputes the hash too":

> Then that row verifies against itself, and the _next_ row still points at the old hash. You have to
> rewrite the entire tail. And deleting from the end — which leaves a perfectly consistent prefix —
> is caught by comparing where the walk ends against the recorded chain head.

---

## 6 · One trace — 90 seconds

Open <http://localhost:16686>, select the `gateway` service, find a recent trace.

Walk the spans:

```
gateway  POST /v1/servers/:server/tools/:tool
├── token exchange  mcp:policy-engine
├── mcp.call  policy.evaluate          →  mcp.tool  policy.evaluate     [policy-engine]
├── token exchange  mcp:salesforce
├── mcp.call  sf.list_opportunities    →  mcp.tool  sf.list_opportunities [salesforce]
└── audit append
```

> One trace, four processes. Context propagates as a W3C `traceparent` header on the outbound MCP
> call, so spans recorded in a separate process join the same trace.
>
> The spans carry attributes the system knows and a generic tracer would not — tenant, user, tool,
> decision, which policy rule fired, whether the token exchange was cached. So "show me every denied
> call for this tenant in the last hour and what denied them" is a tag search, not a log grep.

Click through to the logs for that trace if Grafana is open.

---

## 7 · Grafana — 45 seconds

<http://localhost:3001>, `admin` / `admin`. Open **Gateway SLOs**.

> RED metrics, derived from spans by a connector in the collector rather than hand-written counters,
> so they stay correct when a new tool is added.

Then **Permission mirroring**.

> This one answers the first question anyone asks about this design: what does mirroring cost?
> Exchange latency split by cache hit and miss, the hit rate, and denials by rule and tenant.

---

## 8 · Numbers — 60 seconds

```bash
pnpm bench
```

> This drives real calls through the whole enforcement path — verification, rate limit, policy
> evaluation, which is itself a network call, the token exchange, the upstream MCP call and the
> audit append. Not a microbenchmark of any one of them.
>
> It discards a warm-up window, because the first calls pay for JIT, connection setup, an uncached
> exchange and a cold JWKS fetch. Percentiles come from every sample.
>
> There are no benchmark numbers in the README. I am not going to quote a figure I have not measured
> on the machine it is being quoted on. `docs/BENCHMARKS.md` has a template and asks for the hardware
> alongside the numbers.

---

## 9 · The code — 90 seconds

Three files, in this order.

**`apps/gateway/src/plugins/token-exchange.ts`** — the pillar.

> The whole error path. Notice there is no `else`. A fallback to a service account would be one line
> and would hand every caller the union of every user's permissions. The absence of that line is the
> design.

**`packages/rate-limit/token-bucket.lua`** — the atomicity.

> Read, refill, decide, write, as one indivisible step inside Redis. The alternative is a lost-update
> race that overshoots by roughly the number of replicas, exactly when the limit matters.

**`infra/migrations/0001_audit_privileges.sql`** — the enforcement.

> The hash chain makes tampering detectable. This makes it structurally impossible for the ordinary
> case. `INSERT`, a column-level `SELECT` on `seq` because `RETURNING` needs it, and nothing else.
> Plus a trigger, because owners bypass grants.

---

## Questions you should expect

**"Isn't a token exchange per call expensive?"**
It is cached in Redis under `subject:audience:scope_digest` for the shorter of five minutes and the
token's own remaining lifetime, and concurrent callers for the same key share one exchange. The
Permission Mirroring dashboard shows the hit rate. `pnpm bench` measures the whole path with the
cache warm, which is the steady state.

**"What if the identity provider is down?"**
Requests fail closed. The JWKS cache serves its previous key set through a blip, so verification
survives a short outage, but a _new_ exchange cannot be minted and those requests are refused and
audited. That is the correct behaviour: the alternative is a gateway that stops enforcing exactly
when its authority is unreachable.

**"Why not OPA?"**
It is the right answer in production and the roadmap says so. A sidecar plus bundle distribution
plus Rego is a lot of operational surface to demonstrate one property — that policy runs before a
credential is minted — which a small evaluator demonstrates equally well. The interface is a tool
call over MCP, so replacing it is a deployment change, not a code change.

**"How much of this is real?"**
The README has a table. Short version: the OAuth flows, the exchange, the Lua limiter, the audit
chain and privileges, the warehouse row-level security and the whole observability path are real.
The identity provider and the CRM stand in for products you would buy, and both are labelled
`// MOCK:` in the source. The data is generated from a fixed seed.

**"Does it actually work, or does it just have tests?"**
Both, and the tests are the interesting part: the integration suite boots the whole system in one
process against real Postgres and Redis — real signed tokens, a real exchange, real JWKS
verification, real SQL under real row-level security. Nothing is stubbed. `pnpm test:integration`.
