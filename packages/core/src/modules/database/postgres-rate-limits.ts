import { createHmac } from "node:crypto";
import { MINIMUM_SECRET_LENGTH } from "@blast/core/lib/config/secret.ts";

import type { Pool, QueryResult, QueryResultRow } from "pg";

import { errorLabel, recordMetric } from "../../lib/metrics.ts";
import {
  DEFAULT_RATE_POLICIES,
  assertNestedWindows,
  countedWindows,
  rateLimitSubjectKey,
  type CountedWindow,
  type RateBucket,
  type RateLimitDecision,
  type RateLimitSubject,
  type RatePolicy,
} from "../../lib/web-security/rate-limits.ts";
import type { TransactionTimeouts } from "./pool.ts";
import { autocommitRead, autocommitWrite, withTransaction } from "./transaction.ts";

interface RateWindowRow {
  request_count: number;
  window_seconds: number;
}

const WINDOW_KEY =
  "policy_name, policy_version, subject_hash, window_seconds, window_started_at";
const WINDOW_COLUMNS = `${WINDOW_KEY}, request_count, expires_at`;

/**
 * One VALUES row per window, in policy order. PostgreSQL applies an
 * INSERT ... ON CONFLICT row by row in this order, so every statement for a
 * subject locks its windows in the same order and none can deadlock another.
 */
function windowValues(windowCount: number): string {
  return Array.from({ length: windowCount }, (_, index) => {
    const first = 4 + index * 3;
    return `($1, $2, $3, $${first}, $${first + 1}, 1, $${first + 2})`;
  }).join(",\n       ");
}

function windowParameters(
  policy: RatePolicy,
  subjectHash: string,
  windows: readonly CountedWindow[],
): unknown[] {
  return [
    policy.bucket,
    policy.version,
    subjectHash,
    ...windows.flatMap((window) => [
      window.windowSeconds,
      window.startedAt,
      window.expiresAt,
    ]),
  ];
}

/**
 * Counts a request in every window of its policy with one autocommit
 * INSERT ... ON CONFLICT statement, then decides from the returned counts.
 *
 * A refused request must not consume budget: the previous transactional
 * implementation rolled its increments back. A single-window policy needs no
 * correction, because the counts past the limit only ever deny requests in a
 * window that is already full. A multi-window policy gives its increments back
 * with a second statement, so refused attempts never exhaust a longer window
 * (and never make a shorter window, rather than the full one, set Retry-After).
 * Until that refund lands, a concurrent request of the same subject can see the
 * extra count and be refused too; the limiter only ever errs toward refusing.
 */
export class PostgresRateLimitEnforcer {
  readonly #clock: () => Date;
  readonly #pepper: string;
  readonly #policies: Readonly<Record<RateBucket, RatePolicy>>;
  readonly #pool: Pool;
  readonly #timeouts: Partial<TransactionTimeouts> | undefined;

  constructor(input: {
    pool: Pool;
    subjectPepper: string;
    policies?: Readonly<Record<RateBucket, RatePolicy>>;
    clock?: () => Date;
    /**
     * Server-side budgets shorter than the pool's, for optional callers
     * (telemetry). Each count then runs in its own transaction with SET LOCAL
     * budgets, so it ends on the server within them and never commits late.
     */
    timeouts?: Partial<TransactionTimeouts>;
  }) {
    if (input.subjectPepper.length < MINIMUM_SECRET_LENGTH) {
      throw new TypeError("Rate-limit subject pepper must be at least 32 characters.");
    }
    this.#pool = input.pool;
    this.#pepper = input.subjectPepper;
    this.#policies = input.policies ?? DEFAULT_RATE_POLICIES;
    assertNestedWindows(this.#policies);
    this.#clock = input.clock ?? (() => new Date());
    this.#timeouts = input.timeouts;
  }

  /** One owned statement: autocommit, or its own bounded transaction when budgets were given. */
  #write<Row extends QueryResultRow = QueryResultRow>(
    text: string,
    values: readonly unknown[],
  ): Promise<QueryResult<Row>> {
    const timeouts = this.#timeouts;
    if (!timeouts) {
      return autocommitWrite<"web-security", Row>(
        this.#pool,
        "web-security",
        "mission_control_rate_limit_windows",
        text,
        values,
      );
    }
    return withTransaction(
      this.#pool,
      (transaction) =>
        transaction
          .forModule("web-security")
          .write<Row>("mission_control_rate_limit_windows", text, values),
      { timeouts },
    );
  }

  async consume(
    bucket: RateBucket,
    subject: RateLimitSubject,
  ): Promise<RateLimitDecision> {
    const policy = this.#policies[bucket];
    const key = rateLimitSubjectKey(policy, subject);
    const subjectHash = createHmac("sha256", this.#pepper)
      .update(key)
      .digest("hex");
    const now = this.#clock();
    const windows = countedWindows(policy, now);

    const result = await this.#write<RateWindowRow>(
      `INSERT INTO mission_control_rate_limit_windows (
         ${WINDOW_COLUMNS}
       ) VALUES
       ${windowValues(windows.length)}
       ON CONFLICT (
         ${WINDOW_KEY}
       ) DO UPDATE SET
         request_count = mission_control_rate_limit_windows.request_count + 1
       RETURNING window_seconds, request_count`,
      windowParameters(policy, subjectHash, windows),
    );
    const counts = new Map(
      result.rows.map((row) => [row.window_seconds, row.request_count]),
    );
    const exceeded = windows.find(
      (window) => (counts.get(window.windowSeconds) ?? window.limit + 1) > window.limit,
    );
    if (!exceeded) {
      return {
        allowed: true,
        bucket,
        policyVersion: policy.version,
        retryAfterSeconds: 0,
      };
    }
    if (windows.length > 1) {
      await this.#refund(policy, subjectHash, windows);
    }
    return {
      allowed: false,
      bucket,
      policyVersion: policy.version,
      retryAfterSeconds: Math.max(
        1,
        Math.ceil((exceeded.expiresAt.getTime() - now.getTime()) / 1_000),
      ),
    };
  }

  /**
   * Reads whether one more request of `subject` would be allowed in `bucket`,
   * without counting one: for a budget another route spends (the sponsor
   * route reads `presale_sponsor_exec`, which execute consumes). A refusal's
   * Retry-After runs to the end of the full window.
   */
  async peek(
    bucket: RateBucket,
    subject: RateLimitSubject,
  ): Promise<RateLimitDecision> {
    const policy = this.#policies[bucket];
    const subjectHash = createHmac("sha256", this.#pepper)
      .update(rateLimitSubjectKey(policy, subject))
      .digest("hex");
    const now = this.#clock();
    const windows = countedWindows(policy, now);
    const result = await autocommitRead<RateWindowRow>(
      this.#pool,
      "web-security",
      `SELECT window_seconds, request_count FROM mission_control_rate_limit_windows
       WHERE policy_name = $1 AND policy_version = $2 AND subject_hash = $3
         AND (window_seconds, window_started_at) IN (SELECT * FROM unnest($4::int[], $5::timestamptz[]))`,
      [
        policy.bucket,
        policy.version,
        subjectHash,
        windows.map((window) => window.windowSeconds),
        windows.map((window) => window.startedAt),
      ],
      { label: "rate_limit.peek" },
    );
    const counts = new Map(result.rows.map((row) => [row.window_seconds, row.request_count]));
    const full = windows.find((window) => (counts.get(window.windowSeconds) ?? 0) >= window.limit);
    return {
      allowed: !full,
      bucket,
      policyVersion: policy.version,
      retryAfterSeconds: full ? Math.max(1, Math.ceil((full.expiresAt.getTime() - now.getTime()) / 1_000)) : 0,
    };
  }

  /**
   * Gives a refused request's increments back. It is an upsert rather than an
   * UPDATE so it locks the windows in the same order as the count. The rows
   * exist (the count just wrote them); a count never drops below 1 because
   * of the table's CHECK, so a window first created by a refused request keeps
   * a count of 1. Windows are nested (the constructor refuses any policy whose
   * windows are not), so that row cannot change a decision: the longer window
   * stays full until a boundary that also starts a new shorter window. A failed refund leaves the extra count, which
   * only makes the limiter stricter, and the refusal stands.
   */
  async #refund(
    policy: RatePolicy,
    subjectHash: string,
    windows: readonly CountedWindow[],
  ): Promise<void> {
    try {
      await this.#write(
        `INSERT INTO mission_control_rate_limit_windows (
           ${WINDOW_COLUMNS}
         ) VALUES
         ${windowValues(windows.length)}
         ON CONFLICT (
           ${WINDOW_KEY}
         ) DO UPDATE SET
           request_count = mission_control_rate_limit_windows.request_count - 1
         WHERE mission_control_rate_limit_windows.request_count > 1`,
        windowParameters(policy, subjectHash, windows),
      );
    } catch (error) {
      recordMetric("rate_limit.refund", {
        bucket: policy.bucket,
        error: errorLabel(error),
        outcome: "error",
      });
    }
  }
}
