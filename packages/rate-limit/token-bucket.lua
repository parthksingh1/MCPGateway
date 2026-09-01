--[[
  Atomic token bucket.

  The whole point of putting this in Lua is that read-refill-decide-write
  happens as one indivisible step on the Redis server. Doing the same work with
  GET / compute / SET from the application is a textbook race: two gateway
  instances read the same bucket, both conclude there is room, and both admit a
  request. Under concurrency that overshoots the configured limit by roughly the
  number of instances, which is exactly when a limit matters most.

  It is also one round trip rather than three, which keeps the limiter off the
  critical path of the p99.

  KEYS[1]  bucket key
  ARGV[1]  capacity          maximum tokens the bucket can hold (burst size)
  ARGV[2]  refill_tokens     tokens added every refill_interval_ms
  ARGV[3]  refill_interval_ms
  ARGV[4]  cost              tokens this request consumes
  ARGV[5]  ttl_ms            idle expiry for the bucket key
  ARGV[6]  now_ms            0 => use the Redis server clock

  Returns { allowed, remaining, retry_after_ms, limit }
]]

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
    -- No refill configured: the bucket only resets when the key expires.
    retry_after_ms = ttl_ms
  end
end

redis.call('HSET', key, 'tokens', tokens, 'ts', now)
redis.call('PEXPIRE', key, ttl_ms)

return { allowed, math.floor(tokens), retry_after_ms, capacity }
