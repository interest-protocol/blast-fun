import { createHash } from "node:crypto";

import { optionalSecret } from "../../lib/config/secret.ts";
import { publicErrorResponse } from "../../lib/http-errors.ts";
import { processSingleton } from "../../lib/process-singleton.ts";
import type { ClientAddress } from "../../lib/web-security/client-address.ts";
import {
  DEFAULT_RATE_POLICIES,
  OperationalRateLimited,
  assertNestedWindows,
  countedWindows,
  rateLimitSubjectKey,
  type RateBucket,
  type RateLimitDecision,
  type RateLimitPort,
  type RateLimitSubject,
  type RatePolicy,
} from "../../lib/web-security/rate-limits.ts";

/**
 * Rate limits for routes outside the presale and social kits (WP3,
 * docs/security/bot-protection.md): a few lines around a handler that count
 * the attested client address in one or more buckets before it runs.
 *
 * Two stores:
 *
 * - `sharedRouteLimiter()`: Redis for explicitly eligible public-read traffic
 *   when configured, PostgreSQL otherwise and for all remaining budgets.
 *   Expensive calls retain their budgets across instances.
 * - `MemoryRateLimiter`: counts in this instance only, never a database
 *   write. For cheap reads served from caches (Mission Control's polled
 *   snapshots), where a primary write per poll would cost more than the
 *   read; the Vercel Firewall's rate rules bound the total.
 */

type Environment = Readonly<Record<string, string | undefined>>;

/**
 * The shared traffic limiter (`RATE_LIMIT_SUBJECT_PEPPER`),
 * created on first use; null without a pepper, and a short one throws. `pool`
 * is resolved only then, so importing this never opens a connection.
 */
export async function sharedRouteLimiter(environment: Environment = process.env): Promise<RateLimitPort | null> {
  if (optionalSecret(environment, "RATE_LIMIT_SUBJECT_PEPPER") === null) {
    return null;
  }
  const { trafficRateLimiter } = await import("./traffic-rate-limits.ts");
  return processSingleton("routeLimits.shared", () => trafficRateLimiter(environment));
}

/**
 * Fixed windows like the shared table's, counted in this process. Keys are
 * hashed subjects; at most `maxEntries` windows are kept, the oldest dropped
 * first (dropping only ever forgets counts, which a per-instance limit
 * tolerates).
 */
export class MemoryRateLimiter implements RateLimitPort {
  readonly #counts = new Map<string, { count: number; expiresAt: number }>();
  readonly #clock: () => Date;
  readonly #maxEntries: number;
  readonly #policies: Readonly<Record<RateBucket, RatePolicy>>;

  constructor(options: Readonly<{ clock?: () => Date; maxEntries?: number; policies?: Readonly<Record<RateBucket, RatePolicy>> }> = {}) {
    this.#clock = options.clock ?? (() => new Date());
    this.#maxEntries = options.maxEntries ?? 50_000;
    this.#policies = options.policies ?? DEFAULT_RATE_POLICIES;
    assertNestedWindows(this.#policies);
  }

  /** Whether one more request of `subject` would be allowed in `bucket`, without counting it. */
  async peek(bucket: RateBucket, subject: RateLimitSubject): Promise<RateLimitDecision> {
    return this.#decide(bucket, subject).decision;
  }

  #decide(bucket: RateBucket, subject: RateLimitSubject) {
    const policy = this.#policies[bucket];
    const subjectHash = createHash("sha256").update(rateLimitSubjectKey(policy, subject)).digest("base64url");
    const now = this.#clock();
    const windows = countedWindows(policy, now);
    const keys = windows.map((window) => `${bucket}\0${policy.version}\0${subjectHash}\0${window.windowSeconds}\0${window.startedAt.getTime()}`);
    const full = windows.find((window, index) => (this.#counts.get(keys[index]!)?.count ?? 0) >= window.limit);
    const decision: RateLimitDecision = {
      allowed: !full,
      bucket,
      policyVersion: policy.version,
      retryAfterSeconds: full ? Math.max(1, Math.ceil((full.expiresAt.getTime() - now.getTime()) / 1_000)) : 0,
    };
    return { decision, keys, now, windows };
  }

  async consume(bucket: RateBucket, subject: RateLimitSubject): Promise<RateLimitDecision> {
    const { decision, keys, now, windows } = this.#decide(bucket, subject);
    if (!decision.allowed) return decision;
    windows.forEach((window, index) => {
      const key = keys[index]!;
      const entry = this.#counts.get(key);
      if (entry) entry.count += 1;
      else this.#counts.set(key, { count: 1, expiresAt: window.expiresAt.getTime() });
    });
    this.#prune(now.getTime());
    return decision;
  }

  /**
   * Once over `maxEntries`, drops every expired window, then the oldest ones
   * (Map iteration is insertion order) down to 90% of the bound. The full
   * sweep therefore runs at most once per tenth of the bound's new windows:
   * amortized O(1) per count (review L11), where sweeping back to exactly the
   * bound made every new key at the bound pay a full scan.
   */
  #prune(now: number): void {
    if (this.#counts.size <= this.#maxEntries) return;
    for (const [key, entry] of this.#counts) {
      if (entry.expiresAt <= now) this.#counts.delete(key);
    }
    const lowWater = Math.floor(this.#maxEntries * 0.9);
    for (const key of this.#counts.keys()) {
      if (this.#counts.size <= lowWater) break;
      this.#counts.delete(key);
    }
  }
}

/** This process's `MemoryRateLimiter` (one per process, shared by every route bundle). */
export function instanceRouteLimiter(): MemoryRateLimiter {
  return processSingleton("routeLimits.instance", () => new MemoryRateLimiter());
}

export type RouteLimitCodes = Readonly<{
  /** The 429's `error.code` (default `RATE_LIMITED`). */
  rateLimited?: string;
  /** The 503's `error.code` when the limiter cannot answer (default `SERVICE_UNAVAILABLE`). */
  unavailable?: string;
}>;

export type RouteLimitOptions = RouteLimitCodes & Readonly<{
  /** The limiter, or a promise of it; null (no pepper) answers 503. Default `sharedRouteLimiter()`. */
  limiter?: RateLimitPort | null | Promise<RateLimitPort | null>;
  /** Extra subject parts (an account) for buckets keyed by more than the IP. */
  subject?: RateLimitSubject;
}>;

function errorResponse(status: number, code: string, message: string, retryAfterSeconds: number, cause?: unknown): Response {
  return publicErrorResponse(code, message, status, {
    cause,
    headers: { "Retry-After": String(retryAfterSeconds) },
  });
}

/**
 * Counts `client` in each bucket in order. Returns the
 * refusal to send (429 with `Retry-After`, or 503 when the limiter cannot
 * answer), or null when every bucket has room. Fails closed, like the kits.
 */
export async function routeLimitRefusal(
  client: ClientAddress,
  buckets: readonly RateBucket[],
  options: RouteLimitOptions = {},
): Promise<Response | null> {
  const unavailable = (cause?: unknown) => errorResponse(503, options.unavailable ?? "SERVICE_UNAVAILABLE", "This service is temporarily unavailable.", 5, cause);
  try {
    const limiter = await ("limiter" in options ? options.limiter : sharedRouteLimiter());
    if (!limiter) return unavailable();
    const subject: RateLimitSubject = { ...options.subject, ip: client.rateKey };
    if (limiter.consumeAll && buckets.length) {
      const decision = await limiter.consumeAll(buckets, subject);
      return decision.allowed ? null : errorResponse(429, options.rateLimited ?? "RATE_LIMITED", "Too many requests.", decision.retryAfterSeconds);
    }
    for (const bucket of buckets) {
      const decision = await limiter.consume(bucket, subject);
      if (!decision.allowed) {
        return errorResponse(429, options.rateLimited ?? "RATE_LIMITED", "Too many requests.", decision.retryAfterSeconds);
      }
    }
    return null;
  } catch (error) {
    if (error instanceof OperationalRateLimited)
      return errorResponse(503, options.unavailable ?? "SERVICE_UNAVAILABLE", "This service is temporarily unavailable.", error.retryAfterSeconds);
    return unavailable(error);
  }
}

/** Runs `handler` when `client` has room in every bucket, else answers the refusal. */
export async function withRouteLimits(
  client: ClientAddress,
  buckets: readonly RateBucket[],
  handler: () => Promise<Response>,
  options: RouteLimitOptions = {},
): Promise<Response> {
  try {
    return (await routeLimitRefusal(client, buckets, options)) ?? await handler();
  } catch (cause) {
    return publicErrorResponse("INTERNAL_ERROR", "The request could not be completed. Please retry.", 500, {
      cause, route: buckets.join(","),
    });
  }
}
