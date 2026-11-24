import { z } from "zod";
import type { Pool } from "pg";

import { recordMetric } from "@blast/core/lib/metrics.ts";
import type { RateLimitPort } from "@blast/core/lib/web-security/rate-limits.ts";
import {
  LAUNCHPAD_REPORTING_POLICY,
  parseCoinViewEvent,
  parseCompletedOutcome,
  parseOutcomeReport,
  parseVisitorId,
  reportingPeriodStart,
} from "@blast/core/modules/launchpad-telemetry/contracts.ts";
import { withTelemetrySlot } from "@blast/server/modules/launchpad-telemetry/gate.ts";
import {
  LaunchpadTelemetryRepository,
  type LaunchpadFunnelPeriod,
  type RecordResult,
} from "@blast/server/modules/launchpad-telemetry/repository.ts";

const DAY_MS = 24 * 60 * 60 * 1_000;
const PERIOD_DATE = /^\d{4}-\d{2}-\d{2}$/;

function day(value: string): number {
  const time = z.string().regex(PERIOD_DATE).safeParse(value).success ? Date.parse(`${value}T00:00:00.000Z`) : Number.NaN;
  if (!Number.isFinite(time)) throw new TypeError("Funnel dates must be YYYY-MM-DD.");
  return time;
}

/**
 * Records launchpad telemetry and answers aggregate funnel queries under
 * `LAUNCHPAD_REPORTING_POLICY`. Every input is validated here, so a caller
 * cannot store a private value. Recording and admission run through the
 * per-pool telemetry gate (`gate.ts`), so they never take the product's
 * connections. Methods throw on rejection, saturation or storage failure;
 * product code reaches them only through the non-blocking adapters
 * (`emitter.ts`, `route.ts`).
 */
export class LaunchpadTelemetryService {
  readonly #clock: () => Date;
  readonly #limiter: RateLimitPort | undefined;
  readonly #pool: Pool;
  readonly #repository: LaunchpadTelemetryRepository;

  constructor(
    pool: Pool,
    dependencies: {
      clock?: () => Date;
      /** Required for `admitCoinView`, `admitOutcomeReport` and `admitOutcomeCommitment`; ingestion refuses without it. */
      limiter?: RateLimitPort;
      repository?: LaunchpadTelemetryRepository;
    } = {},
  ) {
    this.#pool = pool;
    this.#clock = dependencies.clock ?? (() => new Date());
    this.#limiter = dependencies.limiter;
    this.#repository = dependencies.repository ?? new LaunchpadTelemetryRepository();
  }

  /** Counts the client's beacon in its IP-scoped rate bucket. */
  async admitCoinView(clientIp: string): Promise<"allowed" | "limited"> {
    const limiter = this.#limiter;
    if (!limiter) throw new Error("Launchpad telemetry has no rate limiter.");
    const decision = await withTelemetrySlot(this.#pool, () =>
      limiter.consume("launchpad_telemetry", { ip: clientIp }));
    return decision.allowed ? "allowed" : "limited";
  }

  /** Counts the client's outcome report in its IP-scoped rate bucket. */
  async admitOutcomeReport(clientIp: string): Promise<"allowed" | "limited"> {
    const limiter = this.#limiter;
    if (!limiter) throw new Error("Launchpad telemetry has no rate limiter.");
    const decision = await withTelemetrySlot(this.#pool, () =>
      limiter.consume("launchpad_outcome", { ip: clientIp }));
    return decision.allowed ? "allowed" : "limited";
  }

  /** Counts the client's digest commitment in its IP-scoped rate bucket. */
  async admitOutcomeCommitment(clientIp: string): Promise<"allowed" | "limited"> {
    const limiter = this.#limiter;
    if (!limiter) throw new Error("Launchpad telemetry has no rate limiter.");
    const decision = await withTelemetrySlot(this.#pool, () =>
      limiter.consume("launchpad_outcome_commitment", { ip: clientIp }));
    return decision.allowed ? "allowed" : "limited";
  }

  /**
   * Stores `visitorId`'s commitment of a signed transaction's digest with this
   * server's receipt time, once per digest and visitor: `receivedAt`, the
   * request's arrival as the route saw it (the service clock when absent). No
   * node is read and no outcome is recorded.
   */
  async recordOutcomeCommitment(visitorId: unknown, input: unknown, receivedAt?: Date): Promise<RecordResult> {
    const report = parseOutcomeReport(input);
    const visitor = parseVisitorId(visitorId);
    if (receivedAt !== undefined && !(receivedAt instanceof Date && Number.isFinite(receivedAt.getTime()))) {
      throw new TypeError("A commitment's receipt time must be a valid Date.");
    }
    const committedAt = receivedAt ?? this.#clock();
    return withTelemetrySlot(this.#pool, () =>
      this.#repository.recordCommitment(this.#pool, { ...report, visitorId: visitor, committedAt }));
  }

  /** Counts `visitorId`'s first view of the coin once in the current reporting period. */
  async recordCoinView(visitorId: unknown, input: unknown): Promise<RecordResult> {
    const view = parseCoinViewEvent(input);
    const visitor = parseVisitorId(visitorId);
    const viewedAt = this.#clock();
    return withTelemetrySlot(this.#pool, () =>
      this.#repository.recordFirstView(this.#pool, {
        periodStart: reportingPeriodStart(viewedAt, LAUNCHPAD_REPORTING_POLICY),
        visitorId: visitor,
        launchId: view.launchId,
        surface: view.surface,
        viewedAt,
      }));
  }

  /**
   * Stores a flow's verified completed outcome for its event's sender and
   * decides its visitor link (`LaunchpadTelemetryRepository.recordOutcome`);
   * anything short of completion is refused. Each commitment that arrived at
   * or after the checkpoint's time is a `launchpad.telemetry` metric
   * (`outcome_commitment`, `late`), so server clock skew shows.
   */
  async recordOutcome(input: unknown): Promise<RecordResult> {
    const outcome = parseCompletedOutcome(input);
    const { result, late } = await withTelemetrySlot(this.#pool, () =>
      this.#repository.recordOutcome(this.#pool, outcome));
    for (let commitment = 0; commitment < late; commitment += 1) {
      recordMetric("launchpad.telemetry", { event: "outcome_commitment", result: "late" });
    }
    return result;
  }

  /**
   * Aggregate counts for each reporting period from the one containing `from`
   * through the one containing `to` (UTC dates). The range may not exceed the
   * retention the policy keeps. An operator read: not gated.
   */
  async funnel(range: { from: string; to: string }): Promise<LaunchpadFunnelPeriod[]> {
    const policy = LAUNCHPAD_REPORTING_POLICY;
    const from = day(reportingPeriodStart(new Date(day(range.from)), policy));
    const to = day(range.to);
    if (to < from || to - from >= policy.retentionDays * DAY_MS) {
      throw new TypeError("Funnel range is empty or longer than the retention period.");
    }
    const starts: string[] = [];
    for (let start = from; start <= to; start += policy.periodDays * DAY_MS) {
      starts.push(new Date(start).toISOString().slice(0, 10));
    }
    return this.#repository.funnel(this.#pool, starts, policy.periodDays);
  }
}
