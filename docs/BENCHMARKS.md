# Benchmarks

**No benchmark number appears anywhere in this project except in this file, next to the machine it
came from.** A figure without that context is decoration.

The run below is a real measurement, recorded so the method is checkable — not a claim about what
this design is capable of. It was taken on a four-year-old laptop running every container, both
databases and the load generator on the same eight cores. Run it yourself and add your own.

---

## What is being measured

`scripts/load-test.ts` drives real tool calls through the running gateway. Each request pays for the
entire enforcement path:

1. token signature verification against the cached JWKS
2. tenant resolution (cached)
3. two token-bucket checks — a Redis round trip
4. policy evaluation — a token exchange plus a network call to the policy engine
5. token exchange for the target server — cached after the first
6. the upstream MCP call over Streamable HTTP
7. the audit append — an indexed insert plus a per-tenant chain-head lock

It is not a microbenchmark of any one of those. If you want to attribute time between them, the
trace for a single request in Jaeger is the better tool.

## Method

```bash
make demo        # stack up, migrated, seeded
pnpm bench       # 30 seconds, 50 connections, sf.list_opportunities
```

Options:

```bash
pnpm bench -- --duration 60 --connections 100
pnpm bench -- --tool pg.query --server postgres
pnpm bench -- --json --out docs/benchmark.json
```

The harness:

- **discards a warm-up window** (3 s by default) — the first calls pay for JIT, connection setup, an
  uncached token exchange and a cold JWKS fetch, none of which is steady state
- **computes percentiles from every recorded sample**, not a sliding estimate
- **drains every response body**, because leaving it unread keeps the socket busy and would
  understate latency while overstating throughput
- **counts 429s separately** and warns if most requests were rate limited — in that case the latency
  figures describe refusals rather than work, and should not be quoted

## Before you quote anything

- **Raise the tenant rate limit**, or run against an enterprise-plan tenant. The seeded per-user
  limit is 600/minute, which a load test will exhaust in seconds. The console's rate limits page
  changes it live.
- **Say whether the token exchange cache was warm.** It is, after the warm-up. A cold cache measures
  the identity provider, not the gateway.
- **Note that everything shares one machine.** Gateway, three MCP servers, identity provider,
  Postgres and Redis all compete for the same cores. Numbers from a distributed deployment will
  differ, in both directions.
- **Docker Desktop on macOS or Windows adds virtualisation overhead** to every database and Redis
  round trip. Linux with a native daemon is the fairer comparison.

---

## Results

Copy this block per run.

### Run 1 — baseline on constrained hardware

|                      |                                                              |
| -------------------- | ------------------------------------------------------------ |
| Date                 | 2026-09-06                                                   |
| Commit               | `5d62fb6`                                                    |
| Machine              | Intel i5-10300H @ 2.50 GHz, 8 logical cores, 8 GB RAM        |
| OS                   | Windows 11                                                   |
| Docker               | Docker Desktop 28.1.1 (WSL2 backend)                         |
| Node                 | v24.15.0 (load generator); images run Node 20                |
| Deployment           | all 14 containers plus the load generator on the one machine |
| Tool exercised       | `salesforce` / `sf.list_opportunities`                       |
| Rate limit in effect | 600/min per user (enterprise plan) — not reached             |

**Serial latency — 1 connection, 8 s**

| min  | p50  | p99   | mean | requests/sec |
| ---- | ---- | ----- | ---- | ------------ |
| 36.6 | 78.5 | 291.9 | 92.2 | 10.8         |

**Under concurrency — 20 connections, 10 s**

| min    | p50    | p75    | p90    | p95    | p99    | max    | mean   |
| ------ | ------ | ------ | ------ | ------ | ------ | ------ | ------ |
| 1355.1 | 3167.4 | 3977.4 | 4658.5 | 4803.4 | 4960.9 | 4960.9 | 3221.8 |

| requests | requests/sec | 200 | 429 | other |
| -------- | ------------ | --- | --- | ----- |
| 68       | 6.0          | 68  | 0   | 0     |

**Notes**

Serial latency is what you would expect from the path: roughly 78 ms covering token verification,
two Redis round trips, a policy call that is itself a network request to another container, a cached
token exchange, the upstream MCP call, and a synchronous audit append.

The interesting result is that **throughput falls as concurrency rises** — 10.8 requests/second with
one connection, 6.0 with twenty. That is the signature of serialisation, not saturation, and this run
does not distinguish between the two plausible causes:

1. **The audit chain-head lock.** Every request in this run is for one tenant, so every append
   contends on the same `SELECT ... FOR UPDATE`. This is the behaviour the per-tenant chain design
   predicts, and the section below says to test it by spreading load across tenants.
2. **Per-call MCP client construction.** The gateway builds a client and completes an `initialize`
   handshake for each upstream call, and it makes two of them per request (policy, then target). On
   a machine where every container competes for the same cores that is a meaningful fixed cost.

Both are addressable and neither is inherent to the design; they are named in the roadmap. What this
run establishes is the method and a baseline to measure a fix against — which is more useful than a
flattering number from a machine nobody can check.

Do not read these figures as a capacity estimate. A deployment with the databases on their own
hardware, several gateway replicas and load spread across tenants would behave differently, and the
only honest way to find out is to run it there.

---

### Run 2 — after pooling upstream MCP connections

Same machine, same method, same commit-to-commit comparison. The only change is that the gateway
now takes upstream MCP connections from a pool instead of building one per call.

|                      |                                                              |
| -------------------- | ------------------------------------------------------------ |
| Date                 | 2026-09-06                                                   |
| Commit               | `838c605` + the connection pool                              |
| Machine              | Intel i5-10300H @ 2.50 GHz, 8 logical cores, 8 GB RAM        |
| OS                   | Windows 11                                                   |
| Docker               | Docker Desktop 28.1.1 (WSL2 backend)                         |
| Node                 | v24.15.0 (load generator); images run Node 20                |
| Deployment           | all 14 containers plus the load generator on the one machine |
| Tool exercised       | `salesforce` / `sf.list_opportunities`                       |
| Rate limit in effect | 600/min per user (enterprise plan) — not reached             |

**Serial latency — 1 connection, 8 s**

| min   | p50   | p99   | mean  | requests/sec |
| ----- | ----- | ----- | ----- | ------------ |
| 22.81 | 39.07 | 306.1 | 51.68 | 19.3         |

**Under concurrency — 20 connections, 10 s**

| min    | p50    | p75    | p90     | p95     | p99     | max     | mean   |
| ------ | ------ | ------ | ------- | ------- | ------- | ------- | ------ |
| 248.91 | 593.07 | 991.17 | 1836.49 | 3173.35 | 3570.18 | 3851.33 | 933.23 |

| requests | requests/sec | 200 | 429 | other |
| -------- | ------------ | --- | --- | ----- |
| 222      | 20.8         | 222 | 0   | 0     |

**Against Run 1**

|                        | Run 1 | Run 2 | change |
| ---------------------- | ----- | ----- | ------ |
| p50, 1 connection      | 78.5  | 39.1  | −50 %  |
| mean, 1 connection     | 92.2  | 51.7  | −44 %  |
| requests/sec, 1 conn   | 10.8  | 19.3  | +79 %  |
| p50, 20 connections    | 3167  | 593   | −81 %  |
| requests/sec, 20 conns | 6.0   | 20.8  | ×3.5   |

**Notes**

Run 1 named two candidate causes for throughput falling as concurrency rose. Measuring rather than
guessing settled it. Timing the layers separately showed `/api/overview` — which authenticates and
queries Postgres but makes no MCP call — at 10 ms p50, while a tool call was 170 ms. That put
roughly 160 ms in the two upstream MCP calls, not in the audit lock.

Timing the MCP client directly localised it further:

|                                             | p50     |
| ------------------------------------------- | ------- |
| `healthz` on the MCP server (network floor) | 4.5 ms  |
| `connect` + `callTool` + `close`            | 64.1 ms |
| `callTool` alone, connection reused         | 12.1 ms |

So about 52 of every 64 ms was the `initialize` handshake and transport setup, and the gateway paid
it twice per request. Pooling the connections removed it.

**The audit chain-head lock was not the bottleneck** on this hardware, which Run 1 could not have
told you. It remains a real serialisation point that a much higher-throughput single-tenant
deployment would eventually meet, and `AUDIT_LOG.md` still describes the sharding answer — but it is
not what these numbers were measuring.

What is left is genuine saturation rather than serialisation: throughput now rises with concurrency
(19.3 → 20.8 req/s) instead of falling, and the p95/p99 spread at 20 connections is eight cores
running fourteen containers, two databases and the load generator at once. A deployment with the
databases on their own hardware and several gateway replicas would look different, and the only
honest way to find out is to run it there.

---

## Interpreting the shape

Some things worth checking against your own numbers rather than taking on faith:

**p50 against p99, and throughput against concurrency.** If throughput falls as connections rise,
something is serialising. Resist guessing which thing: Run 1 assumed the audit chain-head lock and
was wrong. Time the layers separately first — `/healthz`, then `/api/overview` (authentication and
Postgres, no MCP), then a tool call — and the gap tells you which layer to open in Jaeger. Only
then test a specific hypothesis, such as splitting load across the three tenants so audit appends
contend on three locks instead of one.

**Cached against uncached exchange.** The Permission Mirroring dashboard splits token exchange
latency by cache outcome. If the hit rate is not near 100 % during a steady-state run, something is
evicting — check the configured maximum TTL against the token lifetime.

**Where the time goes.** Open a single trace in Jaeger. The policy call is a full network round trip
and is usually the largest non-upstream span. If it dominates, that is the cost of having a separate
decision point, and the alternative — evaluating policy in-process — is a real trade-off worth
naming rather than hiding.

**Throughput ceiling.** If requests/second plateaus while latency climbs linearly, you are saturated;
find out where with the saturation panel on the Gateway SLOs dashboard before assuming it is the
gateway.

## Related claims

If you have seen a figure quoted for this project anywhere — in a CV, a talk, a README — and it is
not in the table above with a machine next to it, treat it as unverified. This file is the only
place numbers belong.
