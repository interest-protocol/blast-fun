/**
 * Presale team vesting as blast-infra publishes it (`chain_read_v1.vesting_schedules`,
 * T-036, owner amendment OA-18): a schedule of `blast_fun_linear_vesting`
 * starts at `start_ms` (the sale's migration), unlocks nothing before its
 * cliff ends (`start_ms + cliff_ms`), then unlocks in `periods` equal steps,
 * one every `period_ms`, until `end_ms`. Between two steps nothing more is
 * claimable: Sui refuses the claim (`ENothingClaimable`), so the web counts
 * whole steps too. A reader without the steps (an indexer from before they
 * were published) falls back to a straight line, which may run ahead.
 *
 * Reads clamp `end_ms` and the cliff's end at `VESTING_MAX_MS`: `cliff_ms`
 * and `end_ms` are NUMERIC because `period × periods` may exceed BIGINT, and
 * nothing later than that can be a JavaScript date.
 */

/** The latest instant a JavaScript `Date` holds (ms). */
export const VESTING_MAX_MS = 8_640_000_000_000_000;

/** SQL: `ms` (a NUMERIC expression) clamped to `VESTING_MAX_MS`, as text. */
export function vestingMsSql(ms: string): string {
  return `LEAST(${ms}, ${VESTING_MAX_MS}::numeric)::text`;
}

/** A schedule's times: start, the cliff's end (nothing unlocks before it; the start without a cliff) and the end. */
export type VestingTimes = Readonly<{ start_ms: number; cliff_end_ms: number; end_ms: number }>;

/** A schedule's steps: `periods` unlocks, one every `period_ms`, as decimal strings (NUMERIC in the view); null when unknown. */
export type VestingSteps = Readonly<{ period_ms: string; periods: string }> | null;

/** SQL: a schedule row's `period_ms` and `periods` as text, null on a view that does not publish them yet. */
export function vestingStepsSql(row: string): string {
  return `to_jsonb(${row})->>'period_ms' AS period_ms, to_jsonb(${row})->>'periods' AS periods`;
}

/** The steps of a row read with `vestingStepsSql`. */
export function vestingSteps(row: Readonly<{ period_ms: string | null; periods: string | null }>): VestingSteps {
  return row.period_ms === null || row.periods === null ? null : { period_ms: row.period_ms, periods: row.periods };
}

/**
 * Atoms of `total` vested at `nowMs`, as `blast_fun_linear_vesting` counts
 * them: none before the cliff ends, all from the end, otherwise the steps
 * passed since the start (`total × steps ÷ periods`), rounded down. Without
 * the steps, the linear share since the start.
 */
export function vestedAtoms(total: bigint, times: VestingTimes, nowMs: number, steps: VestingSteps = null): bigint {
  if (nowMs < times.cliff_end_ms) return 0n;
  if (nowMs >= times.end_ms || times.end_ms <= times.start_ms) return total;
  const elapsed = BigInt(Math.max(0, Math.floor(nowMs - times.start_ms)));
  if (steps !== null) {
    const periodMs = BigInt(steps.period_ms), periods = BigInt(steps.periods);
    if (periodMs <= 0n || elapsed >= periodMs * periods) return total;
    return (total * (elapsed / periodMs)) / periods;
  }
  return (total * elapsed) / BigInt(Math.floor(times.end_ms - times.start_ms));
}

const MONTH_MS = 30 * 86_400_000;

export const VESTING_UNITS = ["months", "weeks", "days", "hours", "minutes", "seconds", "milliseconds"] as const;
export type VestingUnit = (typeof VESTING_UNITS)[number];
export const VESTING_UNIT_MS: Readonly<Record<VestingUnit, number>> = {
  months: MONTH_MS,
  weeks: 7 * 86_400_000,
  days: 86_400_000,
  hours: 3_600_000,
  minutes: 60_000,
  seconds: 1_000,
  milliseconds: 1,
};
export const VESTING_UNIT_LABEL: Readonly<Record<VestingUnit, string>> = { months: "mo", weeks: "wk", days: "d", hours: "h", minutes: "min", seconds: "s", milliseconds: "ms" };

/** Duration in milliseconds; months are fixed at 30 days, matching existing schedules. */
export function vestingDurationMs(value: number, unit: VestingUnit): bigint {
  return BigInt(value) * BigInt(VESTING_UNIT_MS[unit]);
}

/** The largest exact unit, so short schedules never round to zero months. */
export function vestingDurationText(durationMs: number): string {
  const ms = Math.max(0, durationMs);
  const unit = VESTING_UNITS.find((candidate) => ms >= VESTING_UNIT_MS[candidate] && ms % VESTING_UNIT_MS[candidate] === 0);
  return unit ? `${ms / VESTING_UNIT_MS[unit]} ${VESTING_UNIT_LABEL[unit]}` : `${ms / 1_000} s`;
}

/** The cliff in whole months (30 days), rounded; 0 without a cliff. */
export function cliffMonths(times: Pick<VestingTimes, "start_ms" | "cliff_end_ms">): number {
  return Math.max(0, Math.round((times.cliff_end_ms - times.start_ms) / MONTH_MS));
}
