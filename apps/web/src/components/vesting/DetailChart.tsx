"use client";
import { DateStamp } from "#web/components/blast-ui/DateStamp.tsx";
import { Disclosure } from "#web/components/blast-ui/Disclosure.tsx";
import { Pager } from "#web/components/blast-ui/Pager.tsx";
import { useState } from "react";
import { ClientOnly } from "#web/components/ui-libraries/use-hydrated.tsx";
import type { PublicVesting } from "@blast/core/modules/vesting/model.ts";
import { MAX_DATE_MS, scheduleBounds } from "./schedule-display";
import {
  isContinuousSchedule,
  releaseAfter,
  releasePage,
} from "./detail-schedule";
import { compactAmount, readableDate } from "./detail-format";
import { ExactDate, TokenAmount } from "./DetailValues";
import styles from "./VestingDetail.module.css";

import SchedulePlot from "./SchedulePlot";

const timeOptions = {
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  timeZone: "UTC",
  hourCycle: "h23",
} as const;
const timeFormatter = new Intl.DateTimeFormat("en-GB", timeOptions);
const datedTimeFormatter = new Intl.DateTimeFormat("en-GB", {
  ...timeOptions,
  day: "numeric",
  month: "short",
});

const DAY_MS = 86_400_000n;

function AxisDate({ value, bounds }: Readonly<{ value: bigint; bounds: readonly [bigint, bigint] }>) {
  if (value > MAX_DATE_MS) return <span>{readableDate(value)}</span>;
  if (bounds[1] - bounds[0] >= DAY_MS) return <DateStamp at={value} plain />;
  const formatter = bounds[0] / DAY_MS === bounds[1] / DAY_MS ? timeFormatter : datedTimeFormatter;
  const date = new Date(Number(value));
  return <time dateTime={date.toISOString()} title={readableDate(value)}>{formatter.format(date)} UTC</time>;
}

export function DetailChart({
  schedule,
  now,
}: Readonly<{ schedule: PublicVesting; now: bigint }>) {
  const bounds = scheduleBounds(schedule.terms);
  if (!bounds) return null;
  const total = BigInt(schedule.total);
  const next =
    schedule.status === "active" ? releaseAfter(schedule, now) : null;
  const continuous = isContinuousSchedule(schedule);
  const unit =
    schedule.coin_decimals === null
      ? "atomic units"
      : (schedule.coin_symbol ?? "tokens");
  return (
    <div className={styles.chartSection}>
      <div className={styles.chartHeading}>
        <h3>Release schedule</h3>
        <div className={styles.legend}>
          {schedule.status === "active" ? (
            <span>● Unlocked to date</span>
          ) : null}
          <span>┄ Original projection</span>
          {next && !continuous ? <span>○ Next release</span> : null}
        </div>
      </div>
      <p className={styles.chartContext}>Cumulative unlocked · {unit}</p>
      <div className={styles.chartGrid}>
        <div className={styles.scale} aria-hidden="true">
          <span>{compactAmount(total, schedule.coin_decimals)}</span>
          <span>
            {compactAmount(total / BigInt(2), schedule.coin_decimals)}
          </span>
          <span>0</span>
        </div>
        <div
          className={styles.chart}
          role="img"
          aria-label={`Cumulative ${continuous ? "continuous" : "stepped"} release projection in ${unit}. Dashed line: original schedule. ${schedule.status === "active" ? "Solid line and dot: unlocked to date and current time." : "Schedule has ended; the projection does not represent future payouts."} ${continuous ? "Schedule dates are listed below." : "Exact data is available in View all releases below."}`}
        >
          <ClientOnly>
            <SchedulePlot schedule={schedule} now={now} />
          </ClientOnly>
        </div>
      </div>
      <div className={styles.axis}>
        <AxisDate value={bounds[0]} bounds={bounds} />
        <AxisDate value={bounds[1]} bounds={bounds} />
      </div>
      {!continuous ? (
        <>
          <UpcomingReleases schedule={schedule} now={now} />
          <Disclosure title="View all releases">
            <ReleaseData key={schedule.schedule_id} schedule={schedule} />
          </Disclosure>
        </>
      ) : null}
    </div>
  );
}

function UpcomingReleases({
  schedule,
  now,
}: Readonly<{ schedule: PublicVesting; now: bigint }>) {
  if (schedule.status !== "active") return null;
  const rows = releasePage(schedule, now, 3);
  if (!rows.length) return null;
  return (
    <dl className={styles.upcoming} aria-label="Upcoming releases">
      {rows.map((row, index) => (
        <div key={String(row.time)}>
          <dt>
            {index === 0 ? <strong>Next release · </strong> : null}
            <ExactDate value={row.time} clock />
          </dt>
          <dd>
            <TokenAmount
              value={row.amount}
              decimals={schedule.coin_decimals}
              symbol={schedule.coin_symbol ?? "tokens"}
              label="release amount"
            />
          </dd>
        </div>
      ))}
    </dl>
  );
}

function ReleaseData({ schedule }: Readonly<{ schedule: PublicVesting }>) {
  const [cursors, setCursors] = useState<bigint[]>([-BigInt(1)]);
  const after = cursors.at(-1)!;
  const rows = releasePage(schedule, after);
  const last = rows.at(-1);
  const hasNext = last && releaseAfter(schedule, last.time) !== null;
  const symbol =
    schedule.coin_symbol ?? schedule.coin_type.split("::").at(-1) ?? "coin";
  return (
    <>
      <div
        className={styles.tableScroll}
        tabIndex={0}
        role="region"
        aria-label="Exact vesting schedule data"
      >
        <table>
          <caption>Release data · page {cursors.length}</caption>
          <thead>
            <tr>
              <th scope="col">Release (UTC)</th>
              <th scope="col">Newly unlocked</th>
              <th scope="col">Cumulative unlocked</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={String(row.time)}>
                <td>
                  <ExactDate value={row.time} clock />
                </td>
                {row.amount !== null ? (
                  <td>
                    <TokenAmount
                      value={row.amount}
                      decimals={schedule.coin_decimals}
                      symbol={symbol}
                      label="release amount"
                      compact={false}
                    />
                  </td>
                ) : null}
                <td>
                  <TokenAmount
                    value={row.cumulative}
                    decimals={schedule.coin_decimals}
                    symbol={symbol}
                    label="cumulative amount"
                    compact={false}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {/* Each page starts after the last release of the one before: the cursor stack's depth is the page number. */}
      <Pager
        className={styles.pagination}
        hasMore={Boolean(hasNext)}
        onPage={(page) => {
          if (page < cursors.length) setCursors((previous) => previous.slice(0, page));
          else if (last) setCursors((previous) => [...previous, last.time]);
        }}
        page={cursors.length}
        what="releases"
      />
    </>
  );
}
