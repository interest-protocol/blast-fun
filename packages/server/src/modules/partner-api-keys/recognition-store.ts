import { createHmac } from "node:crypto";
import {
  redisNamespace,
  redisScript,
  type RedisCommands,
} from "@blast/core/lib/redis.ts";
import {
  GatewayReplayError,
  type OperationalRateWindow,
} from "@blast/core/lib/web-security/redis-rate-limits.ts";
import {
  DEFAULT_RATE_POLICIES,
  rateLimitSubjectKey,
} from "@blast/core/lib/web-security/rate-limits.ts";
import { rateLimitAddress } from "@blast/core/lib/web-security/client-address.ts";
import { canonicalAddress } from "@blast/core/lib/web-security/ingress.ts";
import {
  capacityFingerprint,
  preflightPerIpLimit,
  type PartnerCapacity,
} from "./capacity.ts";
import { MINIMUM_SECRET_LENGTH } from "@blast/core/lib/config/secret.ts";

export type RecognitionIdentity = Readonly<{ tenant: string; keyId: string }>;
export type RecognitionEntry = RecognitionIdentity & {
  digest: string;
  keyRequestsPerMinute: number;
};
export type RecognitionSnapshot = Readonly<{
  entries: readonly RecognitionEntry[];
  origins: readonly string[];
}>;
export type RecognitionMarker = Readonly<{
  generation: string;
  revision: string;
  needsTrim?: boolean;
}>;
/** Which admission counter refused: unknown-key IP/global, recognized key, preflight reserve or per-IP preflight. */
export type RecognitionLimit = "unknown" | "key" | "preflight" | "preflight-ip";
const LIMIT_SCOPES: readonly RecognitionLimit[] = [
  "unknown",
  "key",
  "preflight",
  "preflight-ip",
];
export type RecognitionDecision = Readonly<{
  kind: "known" | "unknown" | "origin" | "limited";
  identity?: RecognitionIdentity;
  retryAfter?: number;
  recognized?: boolean;
  limit?: RecognitionLimit;
}>;
export class RecognitionUnavailable extends Error {
  constructor() {
    super("Partner recognition is unavailable.");
  }
}

export class RecognitionIntegrityError extends RecognitionUnavailable {}

/** A request-scoped input refusal; it says nothing about the map and never touches readiness. */
export class RecognitionRequestInvalid extends Error {
  constructor() {
    super("Partner recognition input is invalid.");
  }
}

const helpers = `
local function integer(value, minimum, maximum)
  local n = tonumber(value)
  return n and n >= minimum and n <= maximum and n == math.floor(n)
end
local function hex(value, length)
 return type(value) == 'string' and #value == length and string.match(value, '^[a-f0-9]+$')
end
local function uuid(value)
 return type(value) == 'string' and #value == 36 and string.sub(value,9,9) == '-' and string.sub(value,14,14) == '-' and string.sub(value,19,19) == '-' and string.sub(value,24,24) == '-' and hex(string.gsub(value,'-',''),32)
end
local function revision(value)
 return type(value) == 'string' and (value == '0' or string.match(value,'^[1-9][0-9]*$')) and (#value < 19 or (#value == 19 and value <= '9223372036854775807'))
end
local function metadata()
  if redis.call('TYPE', KEYS[1]).ok ~= 'string' then return nil end
  local ok, value = pcall(cjson.decode, redis.call('GET', KEYS[1]))
  if not ok or type(value) ~= 'table' then return nil end
  if value.config ~= ARGV[1] or (value.state ~= 'ready' and value.state ~= 'building') or
    not hex(ARGV[1],64) or not uuid(value.generation) or not revision(value.revision) or
    not integer(value.entries, 0, 20000) or not integer(value.origins, 0, 20000) or
    not integer(value.bytes, 0, 4194304) or type(value.needsTrim) ~= 'boolean' then return nil end
  local mapkind = redis.call('TYPE', KEYS[2]).ok
  local originkind = redis.call('TYPE', KEYS[3]).ok
  if (value.entries == 0 and mapkind ~= 'none') or (value.entries > 0 and mapkind ~= 'hash') or
    (value.origins == 0 and originkind ~= 'none') or (value.origins > 0 and originkind ~= 'set') then return nil end
  if value.entries > 0 and redis.call('HLEN', KEYS[2]) ~= value.entries then return nil end
  if value.origins > 0 and redis.call('SCARD', KEYS[3]) ~= value.origins then return nil end
  return value
end
`;
const inspect = redisScript(
  helpers +
    `
if #KEYS ~= 3 or #ARGV ~= 1 then return redis.error_reply('ARGUMENTS') end
local meta = metadata()
if not meta or meta.state ~= 'ready' then return nil end
return {meta.generation, meta.revision, meta.needsTrim and 1 or 0}
`,
);
const begin = redisScript(
  helpers +
    `
if #KEYS ~= 3 or #ARGV ~= 3 or not hex(ARGV[1],64) or not uuid(ARGV[2]) or not revision(ARGV[3]) then return redis.error_reply('ARGUMENTS') end
local encoded = cjson.encode({state='building',config=ARGV[1],generation=ARGV[2],revision=ARGV[3],entries=0,origins=0,bytes=0,needsTrim=false})
redis.call('DEL', KEYS[2], KEYS[3])
redis.call('SET', KEYS[1], encoded)
return 1
`,
);
const publish = redisScript(
  helpers +
    `
if #KEYS ~= 3 or #ARGV ~= 12 or not uuid(ARGV[5]) or not revision(ARGV[6]) or (ARGV[12] ~= '0' and ARGV[12] ~= '1') then return redis.error_reply('ARGUMENTS') end
local current = metadata()
if not current or current.state ~= ARGV[2] or current.generation ~= ARGV[3] or current.revision ~= ARGV[4] then return redis.error_reply('GENERATION') end
local ok, entries = pcall(cjson.decode, ARGV[7])
local valid, origins = pcall(cjson.decode, ARGV[8])
if not ok or not valid or type(entries) ~= 'table' or type(origins) ~= 'table' or
  not integer(ARGV[9],1,20000) or not integer(ARGV[10],1,4194304) or not integer(ARGV[11],1,20000) or
  #entries > tonumber(ARGV[9]) or #origins > tonumber(ARGV[11]) then return redis.error_reply('CAPACITY') end
local seen, originseen, encoded, bytes = {}, {}, {}, 0
for i, entry in ipairs(entries) do
 if type(entry) ~= 'table' or #entry ~= 4 or not hex(entry[1],64) or
  type(entry[2]) ~= 'string' or not string.match(entry[2],'^[a-z0-9][a-z0-9_-]*$') or #entry[2] > 64 or not uuid(entry[3]) or not integer(entry[4],1,2147483647) or seen[entry[1]] then return redis.error_reply('ARGUMENTS') end
 seen[entry[1]] = true
 encoded[i] = cjson.encode({entry[2], entry[3], entry[4]})
 bytes = bytes + #entry[1] + #encoded[i]
end
for _, origin in ipairs(origins) do
 if type(origin) ~= 'string' or #origin < 1 or #origin > 256 or originseen[origin] then return redis.error_reply('ARGUMENTS') end
 originseen[origin] = true
 bytes = bytes + #origin
end
if bytes > tonumber(ARGV[10]) then return redis.error_reply('CAPACITY') end
local nextmeta = cjson.encode({state='ready',config=ARGV[1],generation=ARGV[5],revision=ARGV[6],entries=#entries,origins=#origins,bytes=bytes,needsTrim=ARGV[12]=='1'})
-- All decoding, bounds, key types and generation guards precede every write.
redis.call('DEL', KEYS[2], KEYS[3])
for i, entry in ipairs(entries) do redis.call('HSET', KEYS[2], entry[1], encoded[i]) end
for _, origin in ipairs(origins) do redis.call('SADD', KEYS[3], origin) end
redis.call('SET', KEYS[1], nextmeta)
return 1
`,
);

// Membership and abuse admission share the nonce decision. Neither map nor origins grant data access.
const classify = redisScript(
  helpers +
    `
if (#KEYS ~= 8 and #KEYS ~= 9) or #ARGV ~= 7 then return redis.error_reply('ARGUMENTS') end
local meta = metadata()
if not meta or meta.state ~= 'ready' then return redis.error_reply('NOT READY') end
if not integer(ARGV[4],1,2147483647) or not integer(ARGV[5],1,2147483647) or not integer(ARGV[6],1,2147483647) or not integer(ARGV[7],1,2147483647) then return redis.error_reply('ARGUMENTS') end
local noncekey = KEYS[9] or ''
if noncekey ~= '' then
 local t = redis.call('TYPE', noncekey).ok
 if t ~= 'none' and t ~= 'string' then return redis.error_reply('CORRUPT REPLAY') end
 if redis.call('EXISTS', noncekey) == 1 then return {2} end
end
local identity, reply, counters = nil, {0}, {}
if ARGV[2] == 'origin' then
 if redis.call('SISMEMBER', KEYS[3], ARGV[3]) == 1 then
  reply = {3}
  -- The per-network sub-limit is checked first, so its refusal never spends the shared reserve.
  counters = {{KEYS[7],tonumber(ARGV[7]),3},{KEYS[6],tonumber(ARGV[4]),2}}
 end
elseif ARGV[2] == 'key' then
 local value = redis.call('HGET', KEYS[2], ARGV[3])
 if value then
  local parsed, decoded = pcall(cjson.decode, value)
  if not parsed or type(decoded) ~= 'table' or #decoded ~= 3 or type(decoded[1]) ~= 'string' or #decoded[1] > 64 or not string.match(decoded[1],'^[a-z0-9][a-z0-9_-]*$') or not uuid(decoded[2]) or not integer(decoded[3],1,2147483647) then return {5} end
  identity = decoded
  reply = {1, identity[1], identity[2]}
  counters = {{KEYS[8], tonumber(identity[3]), 1}}
 end
else return redis.error_reply('ARGUMENTS') end
if #counters == 0 then
 counters = {{KEYS[4],tonumber(ARGV[5]),0},{KEYS[5],tonumber(ARGV[6]),0}}
end
local now = tonumber(redis.call('TIME')[1])
local start = now - now % 60
local counts, retry, scope = {}, 0, nil
for i, counter in ipairs(counters) do
 local t = redis.call('TYPE', counter[1]).ok
 if t ~= 'none' and t ~= 'string' then return redis.error_reply('CORRUPT COUNTER') end
 local old = redis.call('GET', counter[1])
 local count = 0
 if old then
  local stamp, number = string.match(old, '^(%d+):(%d+)$')
  if not stamp or not integer(stamp,0,9007199254740990) or not integer(number,0,9007199254740990) then return redis.error_reply('CORRUPT COUNTER') end
  if tonumber(stamp) == start then count = tonumber(number) end
 end
 counts[i] = count
 if count >= counter[2] then
  retry = start + 60 - now
  scope = scope or counter[3]
 end
end
if noncekey ~= '' then redis.call('SET', noncekey, '1', 'EX', 30, 'NX') end
if retry > 0 then return {4,retry,(identity or reply[1] == 3) and 1 or 0,scope} end
for i, counter in ipairs(counters) do redis.call('SET',counter[1],start .. ':' .. string.format('%.0f',counts[i]+1),'EXAT',start+60) end
return reply
`,
);

/** The fixed classify reply grammar; anything else is an integrity failure. */
function classifyDecision(reply: unknown): RecognitionDecision {
  if (!Array.isArray(reply)) throw new RecognitionIntegrityError();
  if (reply.length === 1) return singleDecision(reply[0]);
  return reply[0] === 4 ? limitedDecision(reply) : knownDecision(reply);
}
function singleDecision(code: unknown): RecognitionDecision {
  if (code === 2) throw new GatewayReplayError();
  if (code === 0) return { kind: "unknown" };
  if (code === 3) return { kind: "origin" };
  throw new RecognitionIntegrityError();
}
function limitedDecision(reply: unknown[]): RecognitionDecision {
  const [, retryAfter, recognized, scope] = reply;
  if (
    reply.length !== 4 ||
    !Number.isInteger(retryAfter) ||
    (retryAfter as number) < 1 ||
    (retryAfter as number) > 60 ||
    (recognized !== 0 && recognized !== 1) ||
    !Number.isInteger(scope) ||
    !LIMIT_SCOPES[scope as number]
  )
    throw new RecognitionIntegrityError();
  return {
    kind: "limited",
    retryAfter: retryAfter as number,
    recognized: recognized === 1,
    limit: LIMIT_SCOPES[scope as number],
  };
}
function knownDecision(reply: unknown[]): RecognitionDecision {
  const [code, tenant, keyId] = reply;
  if (
    code !== 1 ||
    reply.length !== 3 ||
    typeof tenant !== "string" ||
    typeof keyId !== "string" ||
    !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(tenant) ||
    !/^[a-f0-9-]{36}$/.test(keyId)
  )
    throw new RecognitionIntegrityError();
  return { kind: "known", identity: { tenant, keyId } };
}

/** One canonical address plus its rate-limit network (IPv6 /64), or a request-scoped refusal. */
function requestSubject(input: { ip: string; nonce?: string }): {
  ip: string;
  network: string;
} {
  const ip = canonicalAddress(input.ip);
  const network = ip && rateLimitAddress(ip);
  if (
    !ip ||
    !network ||
    (input.nonce !== undefined && !/^[A-Za-z0-9_-]{32}$/.test(input.nonce))
  )
    throw new RecognitionRequestInvalid();
  return { ip, network };
}

/** All recognition operations use one reconciled connection epoch, never a replacement. */
export class PartnerRecognitionStore {
  readonly keys: string[];
  readonly fingerprint: string;
  readonly redis: RedisCommands;
  readonly namespace: string;
  readonly pepper: string;
  readonly capacity: PartnerCapacity;
  constructor(
    redis: RedisCommands,
    namespace: string,
    pepper: string,
    capacity: PartnerCapacity,
  ) {
    this.redis = redis;
    this.namespace = namespace;
    this.pepper = pepper;
    this.capacity = capacity;
    redisNamespace(namespace);
    if (pepper.length < MINIMUM_SECRET_LENGTH || !redis.connectionEpoch || !redis.executeAtEpoch)
      throw new RecognitionUnavailable();
    this.keys = ["metadata", "keys", "origins"].map(
      (name) => `${namespace}:{partner-quota}:recognition:${name}`,
    );
    for (const bucket of ["partner_auth_ip", "partner_auth_global"] as const) {
      const windows = DEFAULT_RATE_POLICIES[bucket].windows;
      if (windows.length !== 1 || windows[0].windowSeconds !== 60)
        throw new RecognitionUnavailable();
    }
    this.fingerprint = capacityFingerprint(capacity);
  }
  digest(hash: Uint8Array): string {
    return createHmac("sha256", this.pepper)
      .update("blast.partner.recognition.v1\0")
      .update(hash)
      .digest("hex");
  }
  epoch(): number {
    return this.redis.connectionEpoch!();
  }
  private connection(epoch: number): RedisCommands {
    return { execute: (args) => this.redis.executeAtEpoch!(args, epoch) };
  }
  async connect(): Promise<number> {
    await this.redis.execute(["PING"]);
    return this.epoch();
  }
  async marker(epoch: number): Promise<RecognitionMarker | null> {
    const reply = await inspect(this.connection(epoch), this.keys, [
      this.fingerprint,
    ]);
    if (reply === null) return null;
    if (
      !Array.isArray(reply) ||
      reply.length !== 3 ||
      typeof reply[0] !== "string" ||
      typeof reply[1] !== "string" ||
      ![0, 1].includes(reply[2])
    )
      throw new RecognitionUnavailable();
    return {
      generation: reply[0],
      revision: reply[1],
      needsTrim: reply[2] === 1,
    };
  }
  async building(marker: RecognitionMarker, epoch: number): Promise<void> {
    await begin(this.connection(epoch), this.keys, [
      this.fingerprint,
      marker.generation,
      marker.revision,
    ]);
  }
  async publish(
    previous: RecognitionMarker,
    next: RecognitionMarker,
    snapshot: RecognitionSnapshot,
    epoch: number,
    building = false,
    needsTrim = false,
  ): Promise<void> {
    await publish(this.connection(epoch), this.keys, [
      this.fingerprint,
      building ? "building" : "ready",
      previous.generation,
      previous.revision,
      next.generation,
      next.revision,
      JSON.stringify(
        snapshot.entries.map((entry) => [
          entry.digest,
          entry.tenant,
          entry.keyId,
          entry.keyRequestsPerMinute,
        ]),
      ),
      JSON.stringify(snapshot.origins),
      String(this.capacity.maxEntries),
      String(this.capacity.maxBytes),
      String(this.capacity.maxOrigins),
      needsTrim ? "1" : "0",
    ]);
  }
  responseWindow(
    input: { tenant: string; internal: boolean },
    epoch: number,
  ): { window: OperationalRateWindow; redis: RedisCommands } {
    const tenant = this.capacity.tenants.find(
      (item) => item.id === input.tenant,
    );
    if (!tenant) throw new RecognitionUnavailable();
    const digest = createHmac("sha256", this.pepper)
      .update(`recognition.tenant:${tenant.id}`)
      .digest("hex");
    const prefix = `${this.namespace}:{partner-quota}:recognition-admission`;
    return {
      window: {
        key: input.internal
          ? `${prefix}:internal`
          : `${prefix}:tenant:${digest}`,
        limit: input.internal
          ? this.capacity.reserves.internal
          : tenant.requestsPerMinute,
      },
      redis: this.connection(epoch),
    };
  }
  async classify(
    input: {
      digest?: string;
      origin?: string;
      ip: string;
      nonce?: string;
      nonceNamespace?: string;
    },
    epoch: number,
  ): Promise<RecognitionDecision> {
    const { ip, network } = requestSubject(input);
    const nonceNamespace = redisNamespace(input.nonceNamespace ?? this.namespace);
    const hash = (value: string) =>
      createHmac("sha256", this.pepper).update(value).digest("hex");
    const unknownKeys = (
      ["partner_auth_ip", "partner_auth_global"] as const
    ).map((bucket) => {
      const policy = DEFAULT_RATE_POLICIES[bucket];
      return `${this.namespace}:{partner-quota}:${bucket}:v${policy.version}:${hash(rateLimitSubjectKey(policy, { ip }))}:60`;
    });
    const prefix = `${this.namespace}:{partner-quota}:recognition-admission`;
    // Declare every accessed key to Redis, including the optional replay nonce.
    // The bytes and shared {partner-quota} hash tag remain the deployed identities.
    const keys = [
      ...this.keys,
      ...unknownKeys,
      `${prefix}:preflight`,
      `${prefix}:preflight-ip:${hash(`recognition.preflight-ip:${network}`)}`,
      `${prefix}:key:${input.digest ?? ""}`,
      ...(input.nonce
        ? [`${nonceNamespace}:{partner-quota}:gateway-replay:${input.nonce}`]
        : []),
    ];
    const reply = await classify(this.connection(epoch), keys, [
      this.fingerprint,
      input.origin === undefined ? "key" : "origin",
      input.origin ?? input.digest ?? "",
      String(this.capacity.reserves.preflight),
      String(DEFAULT_RATE_POLICIES.partner_auth_ip.windows[0].limit),
      String(
        Math.min(
          this.capacity.reserves.unknown,
          DEFAULT_RATE_POLICIES.partner_auth_global.windows[0].limit,
        ),
      ),
      String(preflightPerIpLimit(this.capacity)),
    ]);
    return classifyDecision(reply);
  }
}
