import { linearVestedAt } from "@interest-protocol/blast-util-sdk/vesting";
import {
  isContinuousLinear,
  vestingAmounts,
  type PublicVesting,
} from "@blast/core/modules/vesting/model.ts";
import { scheduleBounds } from "./schedule-display";
import { releaseAfter } from "./detail-schedule";

export type VestingPlotPoint = Readonly<{ time: bigint; amount: bigint }>;

/** Continuous slopes, checkpoint corners, and historical stepped terms retain their actual shape. */
export function vestingPlot(
  schedule: Pick<PublicVesting, "terms" | "total">,
): readonly VestingPlotPoint[] | null {
  const bounds = scheduleBounds(schedule.terms);
  if (!bounds) return null;
  const [start, end] = bounds;
  const terms = schedule.terms;
  const total = BigInt(schedule.total);
  const points: VestingPlotPoint[] = [{ time: start, amount: 0n }];
  if (terms.kind === "checkpoints") {
    let previous = 0n;
    for (const checkpoint of terms.checkpoints!) {
      const time = BigInt(checkpoint.timestamp_ms);
      const amount = BigInt(checkpoint.cumulative_amount);
      points.push({ time, amount: previous }, { time, amount });
      previous = amount;
    }
    return points;
  }
  const shape = {
    startMs: start,
    cliffMs: BigInt(terms.cliff_ms),
    periodMs: BigInt(terms.period_ms),
    periods: BigInt(terms.periods),
  };
  const cliff = start + shape.cliffMs;
  if (isContinuousLinear(terms)) {
    if (cliff > start) {
      points.push(
        { time: cliff, amount: 0n },
        { time: cliff, amount: linearVestedAt(total, shape, cliff) },
      );
    }
    points.push({ time: end, amount: total });
    return points;
  }
  // Bound chart work for old schedules with very large period counts.
  const samples = shape.periods < 1024n ? shape.periods : 512n;
  const times = new Set<bigint>([cliff, end]);
  for (let i = 1n; i <= samples; i++) {
    times.add(start + shape.periodMs * ((shape.periods * i) / samples));
  }
  let previous = 0n;
  for (const time of [...times].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))) {
    const amount = linearVestedAt(total, shape, time);
    points.push({ time, amount: previous }, { time, amount });
    previous = amount;
  }
  return points;
}

/** Only normalized chart coordinates become numbers; token arithmetic stays exact. */
export function vestingChartData(schedule: PublicVesting, now: bigint) {
  const bounds = scheduleBounds(schedule.terms);
  const points = vestingPlot(schedule);
  if (!bounds || !points) return null;

  const [start, end] = bounds;
  const duration = end - start || 1n;
  const total = BigInt(schedule.total) || 1n;
  const coordinate = (time: bigint, amount: bigint) => ({
    x: Number(((time - start) * 1_000_000n) / duration) / 1_000_000,
    y: Number((amount * 1_000_000n) / total) / 1_000_000,
  });
  const projection = points.map(({ time, amount }) => coordinate(time, amount));
  if (schedule.status !== "active") {
    return { projection, unlocked: [], current: null, next: null };
  }

  const time = now < start ? start : now > end ? end : now;
  const current = coordinate(time, vestingAmounts(schedule, now)!.vested);
  const unlocked = [
    ...points
      .filter((point) => point.time <= time)
      .map(({ time, amount }) => coordinate(time, amount)),
    current,
  ];
  const release = isContinuousLinear(schedule.terms)
    ? null
    : releaseAfter(schedule, now);
  const next = release ? coordinate(release.time, release.cumulative) : null;
  return { projection, unlocked, current, next };
}
