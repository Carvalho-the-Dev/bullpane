--[[
  BullMQ Pro: which groups have delayed jobs, and how many. Read only, bounded,
  resumable. Pro keeps delayed jobs in the queue-wide `delayed` zset, marked only by
  the group id on the hash, and a group whose jobs are all delayed is in none of the
  four status zsets, so this scan is the only way to list those groups.

  KEYS[1]  delayed zset (score = when the job becomes runnable)

  ARGV[1]  cursor: index (soonest = 0) of the first job to inspect
  ARGV[2]  batch: max jobs inspected in this call
  ARGV[3]  queue key prefix `${prefix}:${queue}:`
  ARGV[4]  hash fields that may hold the group id, comma separated (GROUP_ID_FIELDS);
           `opts.group.id` is the fallback
  ARGV[5]  byteBudget: stop once this many `opts` bytes were read

  A job costs one HMGET of its group fields and opts (never its payload). opts is
  only decoded when the hash has no group field and opts mentions "group".

  Each distinct group of the slice is then looked up in Pro's four status zsets
  (`groups`, `groups:limit`, `groups:max`, `groups:paused`, under ARGV[3]): one
  ZSCORE each, so the caller knows which groups Pro indexes and which it does not,
  however many groups the queue has.

  Returns { nextCursor, scanned, total, ungrouped, rows } with
    rows = { gid, delayed, soonestScore, status|false, ... } (4 entries per group;
           status is "waiting" | "limited" | "maxed" | "paused", false = not indexed)
    nextCursor = -1 when the zset was walked to the end
]]
local rcall = redis.call
local cursor = tonumber(ARGV[1])
local batch = tonumber(ARGV[2])
local qprefix = ARGV[3]
local byteBudget = tonumber(ARGV[5])

local fields = {}
for f in string.gmatch(ARGV[4], "[^,]+") do fields[#fields + 1] = f end
fields[#fields + 1] = "opts"

local total = rcall("ZCARD", KEYS[1])
local flat = rcall("ZRANGE", KEYS[1], cursor, cursor + batch - 1, "WITHSCORES")

local counts, soonest, order = {}, {}, {}
local scanned, ungrouped, bytes = 0, 0, 0
local stoppedEarly = false

for i = 1, #flat, 2 do
  local id, score = flat[i], flat[i + 1]
  scanned = scanned + 1
  local vals = rcall("HMGET", qprefix .. id, unpack(fields))
  local opts = vals[#vals]
  local gid = nil
  for j = 1, #vals - 1 do
    if vals[j] then gid = vals[j] break end
  end
  if not gid and opts and string.find(opts, "group", 1, true) then
    local ok, decoded = pcall(cjson.decode, opts)
    if ok and type(decoded) == "table" and type(decoded.group) == "table" and decoded.group.id ~= nil then
      gid = tostring(decoded.group.id)
    end
  end
  if opts then bytes = bytes + #opts end
  if gid then
    if not counts[gid] then
      counts[gid] = 0
      soonest[gid] = score
      order[#order + 1] = gid
    end
    counts[gid] = counts[gid] + 1
  else
    ungrouped = ungrouped + 1
  end
  if bytes >= byteBudget then
    stoppedEarly = true
    break
  end
end

local nextCursor = cursor + scanned
if not stoppedEarly and (scanned < batch or nextCursor >= total) then nextCursor = -1 end

local statusKeys = {
  { "waiting", qprefix .. "groups" },
  { "limited", qprefix .. "groups:limit" },
  { "maxed", qprefix .. "groups:max" },
  { "paused", qprefix .. "groups:paused" },
}
local rows = {}
for _, gid in ipairs(order) do
  local status = false
  for _, s in ipairs(statusKeys) do
    if rcall("ZSCORE", s[2], gid) then status = s[1] break end
  end
  rows[#rows + 1] = gid
  rows[#rows + 1] = counts[gid]
  rows[#rows + 1] = soonest[gid]
  rows[#rows + 1] = status
end
return { nextCursor, scanned, total, ungrouped, rows }
