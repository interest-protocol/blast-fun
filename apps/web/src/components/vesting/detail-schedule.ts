import {
  vestingAmounts,
  isContinuousLinear,
  type PublicVesting,
} from "@blast/core/modules/vesting/model.ts";

export type Release = Readonly<{
  time: bigint;
  cumulative: bigint;
  amount: bigint;
}>;

export function isContinuousSchedule(schedule: PublicVesting): boolean {
  return isContinuousLinear(schedule.terms);
}

/** Find the next positive payout, including atom rounding and a cliff between periods. */
export function releaseAfter(
  schedule: PublicVesting,
  after: bigint,
): Release | null {
  const projection = { ...schedule, status: "active" as const, released: "0" };
  const previous = after < 0n ? 0n : vestingAmounts(projection, after)?.vested;
  if (previous === undefined || previous === BigInt(schedule.total))
    return null;
  const terms = schedule.terms;
  let time: bigint;
  if (terms.kind === "checkpoints") {
    const point = terms.checkpoints?.find(
      (point) => BigInt(point.timestamp_ms) > after,
    );
    if (!point) return null;
    time = BigInt(point.timestamp_ms);
  } else {
    const total = BigInt(schedule.total);
    const count = BigInt(terms.periods);
    const index = ((previous + 1n) * count + total - 1n) / total;
    const boundary = BigInt(terms.start_ms) + BigInt(terms.period_ms) * index;
    const cliff = BigInt(terms.start_ms) + BigInt(terms.cliff_ms);
    time = boundary > cliff ? boundary : cliff;
  }
  const cumulative = vestingAmounts(projection, time)!.vested;
  return { time, cumulative, amount: cumulative - previous };
}

export function releasePage(
  schedule: PublicVesting,
  after: bigint,
  limit = 32,
): Release[] {
  const page: Release[] = [];
  let cursor = after;
  for (let index = 0; index < limit; index++) {
    const next = releaseAfter(schedule, cursor);
    if (!next) break;
    page.push(next);
    cursor = next.time;
  }
  return page;
}

export function scheduleState(schedule: PublicVesting, now: bigint): string {
  if (schedule.status === "canceled") return "Canceled";
  if (schedule.status === "closed") return "Closed";
  const amounts = vestingAmounts(schedule, now);
  if (!amounts) return "Schedule data unavailable";
  if (amounts.vested === BigInt(schedule.total)) {
    return amounts.releasable > 0n
      ? "Fully unlocked · claim available"
      : "Fully claimed";
  }
  if (amounts.vested === 0n)
    return isContinuousSchedule(schedule)
      ? "Awaiting vesting"
      : "Awaiting first release";
  return isContinuousSchedule(schedule)
    ? "Vesting continuously"
    : "Releases in progress";
}
