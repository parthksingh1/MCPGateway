# Rate limiting

## Why Lua

A token bucket needs four operations that must not be interleaved: read the current tokens, add what
has accrued since the last call, decide, write back. Done from the application that is:

```ts
const state = await redis.hgetall(key); // ← another replica reads the same state here
const tokens = refill(state);
if (tokens >= 1) {
  await redis.hset(key, { tokens: tokens - 1, ts: now }); // ← and writes over yours here
}
```

Two replicas read the same bucket, both conclude there is room, and both admit the request. Under
concurrency the effective limit overshoots by roughly the number of replicas — precisely when a
limit matters. It is also three round trips instead of one, on the critical path of every call.

Inside a Lua script Redis executes the whole thing as one indivisible step.

## The script

`packages/rate-limit/token-bucket.lua`, in full:

```lua
local key                = KEYS[1]
local capacity           = tonumber(ARGV[1])
local refill_tokens      = tonumber(ARGV[2])
local refill_interval_ms = tonumber(ARGV[3])
local cost               = tonumber(ARGV[4])
local ttl_ms             = tonumber(ARGV[5])
local now_override       = tonumber(ARGV[6])

-- Prefer the Redis clock. Gateway replicas drift relative to one another, and a
-- caller-supplied timestamp lets a fast clock refill a bucket early.
local now
if now_override > 0 then
  now = now_override
else
  local server_time = redis.call('TIME')
  now = (tonumber(server_time[1]) * 1000) + math.floor(tonumber(server_time[2]) / 1000)
end

local state  = redis.call('HMGET', key, 'tokens', 'ts')
local tokens = tonumber(state[1])
local ts     = tonumber(state[2])

if tokens == nil or ts == nil then
  -- First sighting of this bucket: start full so a new caller is not penalised.
  tokens = capacity
  ts     = now
end

-- A backwards jump (clock correction, failover) must not mint tokens.
local elapsed_ms = now - ts
if elapsed_ms < 0 then
  elapsed_ms = 0
end

if refill_interval_ms > 0 and refill_tokens > 0 then
  -- Continuous refill: fractional tokens carry over between calls, so a bucket
  -- configured at 60/minute admits one call per second rather than 60 at the
  -- top of each minute.
  tokens = tokens + ((elapsed_ms / refill_interval_ms) * refill_tokens)
end

if tokens > capacity then
  tokens = capacity
end

local allowed        = 0
local retry_after_ms = 0

if tokens >= cost then
  allowed = 1
  tokens  = tokens - cost
else
  local deficit = cost - tokens
  if refill_tokens > 0 and refill_interval_ms > 0 then
    retry_after_ms = math.ceil((deficit / refill_tokens) * refill_interval_ms)
  else
    retry_after_ms = ttl_ms
  end
end

redis.call('HSET', key, 'tokens', tokens, 'ts', now)
redis.call('PEXPIRE', key, ttl_ms)

return { allowed, math.floor(tokens), retry_after_ms, capacity }
```

Details worth noting:

**The Redis clock, not the caller's.** Replicas drift. A caller-supplied timestamp from a fast clock
would refill the bucket early. `now_override` exists only so tests can be deterministic.

**Fractional tokens persist.** `tokens` is written back as a float, so a call arriving 300 ms into a
one-second refill window carries 0.3 tokens of credit forward. Truncating would systematically
under-admit.

**A backwards clock jump adds nothing.** `elapsed_ms` is floored at zero, so an NTP correction or a
failover cannot mint tokens.

**`retry_after_ms` is computed, not guessed.** The caller is told exactly how long until the deficit
is covered, and it becomes the `Retry-After` header.

## Loading, and the NOSCRIPT path

The script is registered once at boot with `SCRIPT LOAD` and invoked with `EVALSHA` thereafter, so
the body crosses the wire once per process rather than once per request.

Redis can forget it — a restart, `SCRIPT FLUSH`, or failover to a replica that never cached it — and
answers `NOSCRIPT`. The wrapper replays that one call with `EVAL` and re-registers in the
background:

```ts
try {
  return await this.redis.evalsha(sha, 1, ...args);
} catch (error) {
  if (!isNoScriptError(error)) throw error;
  this.sha = null;
  const result = await this.redis.eval(source, 1, ...args);
  void this.load().catch(() => undefined); // re-register for next time
  return result;
}
```

A limiter should never fail a request over its own cache state. Both paths are covered in
`packages/rate-limit/src/limiter.test.ts`, and the recovery is exercised against real Redis in the
integration suite.

## Two buckets, narrower first

Every call is guarded by two buckets:

| Scope                  | Key                                   | Guards against                             |
| ---------------------- | ------------------------------------- | ------------------------------------------ |
| `(tenant, user, tool)` | `rl:{acme-corp}:u:usr_alice:sf.query` | one caller hammering one tool              |
| `tenant`               | `rl:{acme-corp}:t`                    | a tenant exceeding its contracted capacity |

The narrower one is checked first. Otherwise a single noisy user would spend tenant-wide tokens on
calls their own bucket was going to reject anyway, letting one caller degrade the whole tenant.

The tenant id sits inside braces so Redis Cluster hashes every bucket belonging to a tenant to the
same slot — keeping a tenant's limits on one node, and leaving room to evaluate several buckets in
one script later without a cross-slot error.

## Configuration and hot reload

Limits live in `rate_limit_configs`, keyed by `(tenant, scope type, tool, tier)`. Resolution order
for each scope: exact tool at the requested tier, exact tool at `default`, wildcard at the requested
tier, wildcard at `default`, then a built-in fallback.

That fallback is deliberately conservative — an unconfigured tenant is throttled rather than
unlimited, so a missing row can never become an availability incident.

Configuration is cached in memory, because a database round trip in front of every call would be its
own performance problem. Invalidation goes over Redis pub/sub on `mcpgw:rate-limit:reload`, so an
operator raising a limit during an incident reaches every replica in one hop without a deploy. The
console's rate limits page does exactly this.

Note what a raised limit does and does not do: a bucket that already exists keeps its current token
count, and the new capacity applies as it refills. Raising a limit grants headroom going forward; it
does not retroactively refund calls already spent. The integration suite asserts this.

## Tiers

A policy rule may attach a rate tier, which selects a different configuration row:

```yaml
- id: tier-enterprise-burst
  priority: 50
  effect: annotate # attaches metadata, does not decide the request
  rateTier: burst
  match:
    all:
      - path: tenant.plan
        op: eq
        value: enterprise
```

`annotate` rules do not decide; evaluation continues past them. Seeded tiers are `default`, `burst`
(enterprise) and `throttled` (restricted plans).

## Correctness under concurrency

From `tests/integration/rate-limit.test.ts`, against real Redis:

```ts
it('admits exactly the bucket capacity under 500 concurrent callers', async () => {
  const config = { capacity: 100, refillTokens: 0, refillIntervalMs: 0 };
  const verdicts = await Promise.all(
    Array.from({ length: 500 }, () => limiter.consume(target, config)),
  );
  expect(verdicts.filter((v) => v.allowed)).toHaveLength(100);
});

it('stays exact when several limiter instances share one bucket', async () => {
  // Four independent clients, as four gateway replicas would be.
  const verdicts = await Promise.all(
    Array.from({ length: 400 }, (_, i) => limiters[i % 4].consume(target, config)),
  );
  expect(verdicts.filter((v) => v.allowed)).toHaveLength(50);
});
```

Exactly the capacity, no more and no fewer. Anything above is a lost update; anything below means
the script dropped a legitimate call.

Also asserted there: cost accounting for multi-token calls, continuous refill (a partially refilled
bucket admits a call a fixed window would still be refusing), capacity never exceeded however long a
bucket idles, an actionable retry delay, `SCRIPT FLUSH` recovery, and isolation across tenants,
users and tools.

Run them with `pnpm test:integration`. These need Docker, so they live in the integration suite
rather than the unit run; the unit tests cover key construction, argument marshalling, the
`EVALSHA`/`EVAL` fallback, verdict mapping and configuration resolution with a Redis double.

## Operational notes

- **429 responses carry `Retry-After`**, plus `X-RateLimit-Limit`, `X-RateLimit-Remaining` and
  `X-RateLimit-Scope`, so a client can tell which bucket refused it.
- **Refusals are audited.** Being throttled is a security-relevant event; an investigator needs to
  see it, not just observe that traffic stopped.
- **Buckets expire when idle**, at roughly twice a full refill with a one-minute floor, so state
  does not accumulate for one-off callers.
- **The console shows live bucket state** read straight from Redis, so an operator sees what the
  limiter is working with rather than what was configured.
