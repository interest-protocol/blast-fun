import type { DeploymentIdentity } from "../config/deployment-identity.ts";
import { createHash, createHmac } from "node:crypto";
import { MINIMUM_SECRET_LENGTH } from "@blast/core/lib/config/secret.ts";

import { z } from "zod";

import { redisNamespace, redisScript, type RedisCommands } from "../redis.ts";
import {
  DEFAULT_RATE_POLICIES,
  OperationalRateLimited,
  LAUNCHPAD_MARKET_RATE_BUCKETS,
  assertNestedWindows,
  rateLimitSubjectKey,
  type RateBucket,
  type RateLimitDecision,
  type RateLimitPort,
  type RateLimitSubject,
  type RatePolicy,
} from "./rate-limits.ts";

/** IP read guards only: private-account, sign-in, mutation and financial execution budgets stay durable. */
export const FIRST_PARTY_READ_BUCKETS: ReadonlySet<RateBucket> = new Set([
  "launchpad_search",
  "launchpad_discovery",
  "launchpad_wallet_launches",
  "launchpad_theses_read",
  "social_read",
  "social_read_search",
  "social_read_presales",
  "social_read_prices",
  "social_read_trade_coins",
  "social_read_portfolio",
  "social_read_quote",
  ...LAUNCHPAD_MARKET_RATE_BUCKETS,
]);
// Portfolio and coin lists are public. Quotes can contain viewer-specific data,
// but only their outer IP read guard moves here: social_trade_quote and
// social_trade_quote_anon still run in PostgreSQL; quote payloads are never cached.

const REDIS_RATE_BUCKETS: ReadonlySet<RateBucket> = new Set([
  "defillama_read",
  "defillama_public_global",
  "admin_login_ip",
  "admin_login_global",
  "partner_read",
  "partner_read_global",
  "partner_auth_ip",
  "partner_auth_global",
  // Partner keys count proofs here; first-party proofs stay in the presale kit's PostgreSQL table.
  "presale_proof",
  "presale_allowlist_csv",
  ...FIRST_PARTY_READ_BUCKETS,
]);

/** Keep existing counters stable while isolating preview branches from production. */
export function quotaNamespace(
  base: string | undefined,
  identity: Pick<DeploymentIdentity, "target" | "branch">,
): string {
  return createHash("sha256")
    .update(JSON.stringify([redisNamespace(base), identity.target, identity.branch]))
    .digest("hex");
}

// Redis owns the clock. Check every window before writing any: rejected calls
// never spend a daily allowance. Counter keys exclude caps so policy changes
// cannot reset usage. A noeviction store is mandatory for quota counters.
export class GatewayReplayError extends Error {
  constructor() {
    super("Gateway nonce already consumed.");
  }
}

// Validate every argument, key type and stored value before the first write:
// Redis script errors do not roll back writes already made by the script.
const consumeScript = redisScript(`
local replay = ARGV[1] == '1'
if ARGV[1] ~= '0' and not replay then return redis.error_reply('ARGUMENTS') end
local offset = replay and 1 or 0
local windows = #KEYS - offset
if windows < 0 or #ARGV ~= 1 + windows * 3 then return redis.error_reply('ARGUMENTS') end
local function integer(value, minimum, maximum)
  local number = tonumber(value)
  return number and number >= minimum and number <= maximum and number == math.floor(number)
end
local seen = {}
for i, key in ipairs(KEYS) do
  if seen[key] then return redis.error_reply('DUPLICATE KEY') end
  seen[key] = true
end
for i = 1, windows do
  if not integer(ARGV[(i - 1) * 3 + 2], 1, 86400) or
     not integer(ARGV[(i - 1) * 3 + 3], 1, 9007199254740990) or
     not integer(ARGV[(i - 1) * 3 + 4], 1, 128) then return redis.error_reply('ARGUMENTS') end
end
if replay then
  local kind = redis.call('TYPE', KEYS[1]).ok
  if kind ~= 'none' and kind ~= 'string' then return redis.error_reply('CORRUPT REPLAY') end
  if redis.call('EXISTS', KEYS[1]) == 1 then return {2, 0, 0} end
end
local now = tonumber(redis.call('TIME')[1])
local starts = {}
local counts = {}
local retry = 0
local refused = 0
for i = 1, windows do
  local key = KEYS[i + offset]
  local kind = redis.call('TYPE', key).ok
  if kind ~= 'none' and kind ~= 'string' then return redis.error_reply('CORRUPT ' .. i) end
  local seconds = tonumber(ARGV[(i - 1) * 3 + 2])
  local limit = tonumber(ARGV[(i - 1) * 3 + 3])
  local started = now - now % seconds
  local count = 0
  local previous = redis.call('GET', key)
  if previous then
    local stamp, total = string.match(previous, '^(%d+):(%d+)$')
    if not stamp or not integer(stamp, 0, 9007199254740990) or
       not integer(total, 0, 9007199254740990) then return redis.error_reply('CORRUPT ' .. i) end
    if tonumber(stamp) == started then count = tonumber(total) end
  end
  starts[i] = started
  counts[i] = count
  if count >= limit and started + seconds - now > retry then
    retry = started + seconds - now
    refused = tonumber(ARGV[(i - 1) * 3 + 4])
  end
end
if replay then redis.call('SET', KEYS[1], '1', 'NX', 'EX', 30) end
if retry > 0 then return {0, retry, refused} end
for i = 1, windows do
  local seconds = tonumber(ARGV[(i - 1) * 3 + 2])
  redis.call('SET', KEYS[i + offset], starts[i] .. ':' .. string.format('%.0f', counts[i] + 1), 'EXAT', starts[i] + seconds)
end
return {1, 0, 0}
`);

/** Server-owned operational window joined atomically with commercial admission. */
export type OperationalRateWindow = Readonly<{ key: string; limit: number }>;
export { OperationalRateLimited } from "./rate-limits.ts";

function assertTrafficBuckets(buckets: readonly RateBucket[]): void {
  if (
    buckets.length > REDIS_RATE_BUCKETS.size ||
    new Set(buckets).size !== buckets.length ||
    buckets.some((bucket) => !REDIS_RATE_BUCKETS.has(bucket))
  ) {
    throw new TypeError(
      "Redis quotas are restricted to distinct traffic buckets.",
    );
  }
}

function assertOperationalWindow(
  operational: OperationalRateWindow,
  prefix: string,
): void {
  if (
    !operational.key.startsWith(prefix) ||
    !/^(internal|tenant:[a-f0-9]{64})$/.test(
      operational.key.slice(prefix.length),
    ) ||
    !Number.isSafeInteger(operational.limit) ||
    operational.limit < 1 ||
    operational.limit > 2147483647
  ) {
    throw new TypeError("Invalid operational rate window.");
  }
}

/** The script's exact replay refusal: [2, 0, 0]. */
function isReplayReply(reply: unknown): boolean {
  return (
    Array.isArray(reply) &&
    reply.length === 3 &&
    reply[0] === 2 &&
    reply[1] === 0 &&
    reply[2] === 0
  );
}

/** [allowed, retryAfterSeconds, refusing scope]; scopes are 1-based over buckets then operational. */
function quotaDecisionReply(
  reply: unknown,
  scopes: number,
): [0 | 1, number, number] {
  const decisionSchema = z.union([
    z.tuple([z.literal(1), z.literal(0), z.literal(0)]),
    z.tuple([z.literal(0), z.number().int().min(1).max(86_400), z.number().int().min(1).max(scopes)]),
  ]);
  const parsed = decisionSchema.safeParse(reply);
  if (!parsed.success) throw new Error("Invalid Redis quota decision.");
  return parsed.data;
}

/** Distributed traffic quotas only; financial budgets retain PostgreSQL durability. */
export class RedisRateLimitEnforcer implements RateLimitPort {
  readonly #redis: RedisCommands;
  readonly #namespace: string;
  readonly #operationalNamespace: string;
  readonly #pepper: string;
  readonly #policies: Readonly<Record<RateBucket, RatePolicy>>;

  constructor(input: {
    redis: RedisCommands;
    namespace: string;
    /** Trusted shared registry budget; request counters retain namespace above. */
    operationalNamespace?: string;
    subjectPepper: string;
    policies?: Readonly<Record<RateBucket, RatePolicy>>;
  }) {
    if (!z.string().min(MINIMUM_SECRET_LENGTH).safeParse(input.subjectPepper).success) throw new TypeError("Rate-limit subject pepper must be at least 32 characters.");
    if (!z.string().regex(/^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/).safeParse(input.namespace).success) throw new TypeError("Invalid quota namespace.");
    this.#redis = input.redis;
    this.#namespace = input.namespace;
    this.#operationalNamespace = redisNamespace(
      input.operationalNamespace ?? input.namespace,
    );
    this.#pepper = input.subjectPepper;
    this.#policies = input.policies ?? DEFAULT_RATE_POLICIES;
    assertNestedWindows(this.#policies);
  }

  async consume(
    bucket: RateBucket,
    subject: RateLimitSubject,
  ): Promise<RateLimitDecision> {
    return this.consumeAll([bucket], subject);
  }

  async claimGatewayNonce(nonce: string): Promise<void> {
    await this.#consume([], {}, nonce);
  }

  async consumeAll(
    buckets: readonly RateBucket[],
    subject: RateLimitSubject,
    nonce?: string,
  ): Promise<RateLimitDecision> {
    if (!buckets.length)
      throw new TypeError("A quota decision requires traffic buckets.");
    return this.#consume(buckets, subject, nonce) as Promise<RateLimitDecision>;
  }

  async consumeAllWithOperational(
    buckets: readonly RateBucket[],
    subject: RateLimitSubject,
    operational: OperationalRateWindow,
    redis?: RedisCommands,
  ): Promise<RateLimitDecision> {
    return this.#consume(
      buckets,
      subject,
      undefined,
      operational,
      redis,
    ) as Promise<RateLimitDecision>;
  }

  async #consume(
    buckets: readonly RateBucket[],
    subject: RateLimitSubject,
    nonce?: string,
    operational?: OperationalRateWindow,
    redis?: RedisCommands,
  ): Promise<RateLimitDecision | void> {
    assertTrafficBuckets(buckets);
    if (nonce !== undefined && !/^[A-Za-z0-9_-]{32}$/.test(nonce))
      throw new TypeError("Invalid gateway nonce.");
    const keys: string[] =
      nonce === undefined
        ? []
        : [`${this.#namespace}:{partner-quota}:gateway-replay:${nonce}`];
    const arguments_: string[] = [nonce === undefined ? "0" : "1"];
    for (const [index, bucket] of buckets.entries()) {
      const policy = this.#policies[bucket];
      const hash = createHmac("sha256", this.#pepper)
        .update(rateLimitSubjectKey(policy, subject))
        .digest("hex");
      const prefix = `${this.#namespace}:{partner-quota}:${bucket}:v${policy.version}:${hash}`;
      for (const window of policy.windows) {
        keys.push(`${prefix}:${window.windowSeconds}`);
        arguments_.push(
          String(window.windowSeconds),
          String(window.limit),
          String(index + 1),
        );
      }
    }
    if (operational) {
      assertOperationalWindow(
        operational,
        `${this.#operationalNamespace}:{partner-quota}:recognition-admission:`,
      );
      keys.push(operational.key);
      arguments_.push(
        "60",
        String(operational.limit),
        String(buckets.length + 1),
      );
    }
    const raw = await consumeScript(redis ?? this.#redis, keys, arguments_);
    if (nonce !== undefined && isReplayReply(raw))
      throw new GatewayReplayError();
    const reply = quotaDecisionReply(
      raw,
      buckets.length + (operational ? 1 : 0),
    );
    if (operational && reply[0] === 0 && reply[2] === buckets.length + 1)
      throw new OperationalRateLimited(reply[1]);
    if (!buckets.length) return;
    const bucket = buckets[reply[0] === 1 ? 0 : reply[2] - 1]!;
    const policy = this.#policies[bucket];
    return {
      allowed: reply[0] === 1,
      bucket,
      policyVersion: policy.version,
      retryAfterSeconds: reply[1],
    };
  }
}
