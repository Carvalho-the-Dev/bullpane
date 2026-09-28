--[[
  "What finished in the last W minutes" for ONE queue, from BullMQ's own
  metrics, plus a bounded processing-time sample. One round trip, read only.

  WHY THE :data LISTS AND NOT ZCOUNT. The completed/failed zsets only hold what
  retention left behind: with `removeOnComplete` a healthy queue reads as a
  failing one (300 ok / 15 failed = 4.8% real reads as 23.1% by ZCOUNT).
  BullMQ's metrics are written as each job finishes and pruning never touches
  them.

  HOW BULLMQ WRITES THEM (commands/includes/collectMetrics.lua). Per side
  (completed / failed) there is a hash { count, prevTS, prevCount } and a list:
    - every finished job does HINCRBY count
    - when a job finishes in a LATER minute than prevTS, the jobs counted since
      prevTS (count - prevCount) are LPUSHed, followed by one 0 per idle minute,
      and prevTS/prevCount move to now
  So, with m0 = floor(prevTS / 60000):
    - `count - prevCount` jobs finished in minute m0 and are not in the list yet
    - list index i holds minute m0 - 1 - i
    - minutes after m0, up to now, had no finished job (a finish would have
      flushed), so they are known zeros
  Nothing is extrapolated and no history is kept on our side: the window is
  exact to the minute from the first read, including right after a restart.

  KEYS[1]  metrics:completed hash
  KEYS[2]  metrics:failed hash
  KEYS[3]  metrics:completed:data list
  KEYS[4]  metrics:failed:data list
  KEYS[5]  completed zset (score = finishedOn)

  ARGV[1]  now, unix ms (the server's clock; minute granularity absorbs skew)
  ARGV[2]  rate windows in minutes, comma separated ("" = none)
  ARGV[3]  duration windows in minutes, comma separated ("" = none)
  ARGV[4]  max completed jobs to read for durations (bounded by the caller)
  ARGV[5]  `${prefix}:${queue}:` to build job hash keys

  Returns:
    [1] 1 when either metrics hash exists, else 0 (the Worker has no `metrics`)
    [2] flat { completed, failed, coveredMinutes } per rate window, in ARGV[2] order
    [3] flat { sampled, p50Ms, p95Ms } per duration window, in ARGV[3] order
        (p50/p95 are -1 when nothing was sampled)

  Cost: 2 HMGET + at most 2 LRANGE of max(window) small integers, and for
  durations 1 ZREVRANGEBYSCORE + at most ARGV[4] HMGETs of two fields. Every
  key belongs to this queue (same hash tag), so it is cluster safe.
]]
local rcall = redis.call

local function csv(s)
  local out = {}
  for part in string.gmatch(s or "", "[^,]+") do
    local n = tonumber(part)
    if n and n > 0 then out[#out + 1] = math.floor(n) end
  end
  return out
end

local now = tonumber(ARGV[1])
local nowMin = math.floor(now / 60000)
local rateWindows = csv(ARGV[2])
local durationWindows = csv(ARGV[3])

local maxWindow = 0
for _, w in ipairs(rateWindows) do
  if w > maxWindow then maxWindow = w end
end

-- One side (completed or failed). Returns a reader: window -> total, covered.
local function side(hashKey, listKey)
  local h = rcall("HMGET", hashKey, "count", "prevTS", "prevCount")
  local count = tonumber(h[1])
  if not count then
    -- Hash absent. For `failed` this is normal on a queue that never failed
    -- (BullMQ creates it on the first failure), so it reads as zero, fully
    -- covered; the caller decides "no metrics" from BOTH sides being absent.
    return false, function(w) return 0, w end
  end
  local prevTS = tonumber(h[2])
  local prevCount = tonumber(h[3]) or 0
  if not prevTS then
    -- Written by a BullMQ that sets count before prevTS: all of it is "now".
    return true, function(w) return count, w end
  end
  local m0 = math.floor(prevTS / 60000)
  local ref = nowMin
  if m0 > ref then ref = m0 end -- a worker clock ahead of ours
  local pending = count - prevCount

  -- Read the list once, for the widest window.
  local points = {}
  local need = m0 - (ref - maxWindow + 1)
  if need > 0 then points = rcall("LRANGE", listKey, 0, need - 1) end

  return true, function(w)
    local startMin = ref - w + 1
    if m0 < startMin then return 0, w end -- nothing finished inside the window
    local total = pending
    local covered = ref - m0 + 1
    local n = m0 - startMin
    if n > #points then n = #points end
    for i = 1, n do
      total = total + (tonumber(points[i]) or 0)
    end
    covered = covered + n
    if covered > w then covered = w end
    return total, covered
  end
end

local hasCompleted, completedIn = side(KEYS[1], KEYS[3])
local hasFailed, failedIn = side(KEYS[2], KEYS[4])

local rates = {}
for _, w in ipairs(rateWindows) do
  local c, cc = completedIn(w)
  local f, fc = failedIn(w)
  local covered = cc
  if fc < covered then covered = fc end
  rates[#rates + 1] = c
  rates[#rates + 1] = f
  rates[#rates + 1] = covered
end

-- Processing time: newest completed jobs inside the widest duration window.
local durations = {}
if #durationWindows > 0 then
  local widest = 0
  for _, w in ipairs(durationWindows) do
    if w > widest then widest = w end
  end
  local limit = tonumber(ARGV[4]) or 100
  local ids = rcall("ZREVRANGEBYSCORE", KEYS[5], "+inf", now - widest * 60000, "LIMIT", 0, limit)
  -- { finishedOn, duration } newest first
  local sampled = {}
  for _, id in ipairs(ids) do
    local v = rcall("HMGET", ARGV[5] .. id, "processedOn", "finishedOn")
    local p, f = tonumber(v[1]), tonumber(v[2])
    if p and f and f >= p then sampled[#sampled + 1] = { f, f - p } end
  end

  local function pct(sorted, q)
    local idx = math.ceil(q / 100 * #sorted)
    if idx < 1 then idx = 1 end
    return sorted[idx]
  end

  for _, w in ipairs(durationWindows) do
    local since = now - w * 60000
    local ds = {}
    for _, s in ipairs(sampled) do
      if s[1] >= since then ds[#ds + 1] = s[2] end
    end
    table.sort(ds)
    durations[#durations + 1] = #ds
    if #ds > 0 then
      durations[#durations + 1] = pct(ds, 50)
      durations[#durations + 1] = pct(ds, 95)
    else
      durations[#durations + 1] = -1
      durations[#durations + 1] = -1
    end
  end
end

local has = 0
if hasCompleted or hasFailed then has = 1 end
return { has, rates, durations }
