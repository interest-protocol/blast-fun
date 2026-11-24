"use client";
import { DateStamp } from "#web/components/blast-ui/DateStamp.tsx";
import {
  isContinuousLinear,
  type PublicVesting,
} from "@blast/core/modules/vesting/model.ts";
import { MAX_DATE_MS, scheduleBounds, vestingDate } from "./schedule-display";
import { vestingPlot } from "./vesting-plot";
import { ReleasePlot } from "./SchedulePlot";
import styles from "./Vesting.module.css";

export function VestingChart({
  schedule,
}: Readonly<{ schedule: Pick<PublicVesting, "terms" | "total"> }>) {
  const bounds = scheduleBounds(schedule.terms);
  const data = previewData(schedule);
  if (!bounds || !data)
    return (
      <p>
        Unlock dates are unavailable for this schedule, which was created and
        removed in one transaction. Its lifecycle remains public below.
      </p>
    );
  return (
    <>
      <div
        className={styles.chart}
        role="img"
        aria-label={
          isContinuousLinear(schedule.terms)
            ? "Linear vesting: tokens unlock continuously over time, with any cliff shown as a jump. Amounts round down to whole atomic units."
            : "Stepped vesting: tokens unlock at each release date. Exact dates and amounts are listed below."
        }
      >
        <ReleasePlot
          data={data}
          stepped={!isContinuousLinear(schedule.terms)}
        />
      </div>
      <div className={styles.axis}>
        <AxisDate value={bounds[0]} />
        <AxisDate value={bounds[1]} />
      </div>
    </>
  );
}

function AxisDate({ value }: Readonly<{ value: bigint }>) {
  return value > MAX_DATE_MS
    ? <span>{vestingDate(value)}</span>
    : <DateStamp at={value} plain />;
}

function previewData(schedule: Pick<PublicVesting, "terms" | "total">) {
  const range = scheduleBounds(schedule.terms);
  const points = vestingPlot(schedule);
  if (!range || !points) return null;
  const total = BigInt(schedule.total) || 1n;
  const duration = range[1] - range[0] || 1n;
  return {
    projection: points.map((point) => ({
      x: Number(((point.time - range[0]) * 1_000_000n) / duration) / 1_000_000,
      y: Number((point.amount * 1_000_000n) / total) / 1_000_000,
    })),
    unlocked: [],
    current: null,
    next: null,
  };
}
