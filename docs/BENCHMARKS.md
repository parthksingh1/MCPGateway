# Benchmarks

**This file contains no numbers yet. That is deliberate.**

A benchmark figure without the machine, the configuration and the method behind it is decoration.
Run it yourself, on hardware you can name, and fill in the table below.

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

### Run 1

|                      |                              |
| -------------------- | ---------------------------- |
| Date                 |                              |
| Commit               | `git rev-parse --short HEAD` |
| Machine              | CPU / cores / RAM            |
| OS                   |                              |
| Docker               | Desktop or native, version   |
| Node                 | `node -v`                    |
| Tool exercised       |                              |
| Connections          |                              |
| Duration             |                              |
| Rate limit in effect |                              |

**Throughput**

|                     |     |
| ------------------- | --- |
| Requests            |     |
| Requests / second   |     |
| Successful / second |     |

**Latency (ms)**

| min | p50 | p75 | p90 | p95 | p99 | max | mean |
| --- | --- | --- | --- | --- | --- | --- | ---- |
|     |     |     |     |     |     |     |      |

**Outcomes**

| 200 | 429 | other |
| --- | --- | ----- |
|     |     |       |

**Notes**

<!-- Anything that would change the reading: contention on the machine, a cold cache, a limit that
     was hit, a change you made to the configuration. -->

---

### Run 2

<!-- Copy the block above. Comparing a change against a baseline on the same machine is far more
     informative than a single absolute number. -->

---

## Interpreting the shape

Some things worth checking against your own numbers rather than taking on faith:

**p50 against p99.** A wide gap usually means the audit append is queueing behind the per-tenant
chain-head lock. Single-tenant load tests all contend on one lock; spreading load across tenants
should narrow it. If it does, that is the lock, and `AUDIT_LOG.md` describes the sharding answer.

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
