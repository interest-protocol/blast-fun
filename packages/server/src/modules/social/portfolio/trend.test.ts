import assert from "node:assert/strict";
import test from "node:test";

import type { PortfolioTrendPoint } from "@blast/core/modules/social/contracts/portfolio.ts";
import { SocialRouteError } from "@blast/core/modules/social/route-kit/errors.ts";
import { PORTFOLIO_HISTORY_MAX_DAYS } from "@blast/core/modules/social/contracts/portfolio.ts";
import type { ReadableDatabase } from "@blast/core/modules/database/transaction.ts";
import { changeBps, portfolioHistoryOf, portfolioHistoryRange, portfolioTrendOf, readPortfolioHistory } from "@blast/server/modules/social/portfolio/trend.ts";

/** OA-25 Q16: the gold card's trend from the daily snapshots: empty until a month of them, then exact. */

const day = (offset: number, from = "2026-10-06") => new Date(Date.parse(`${from}T00:00:00.000Z`) + offset * 86_400_000).toISOString().slice(0, 10);
/** Valued days `from`..`to` days relative to 2026-10-06, newest first, worth 100 + the offset. */
function days(from: number, to: number, value = (offset: number) => `${100 + offset}.00`): PortfolioTrendPoint[] {
  const rows: PortfolioTrendPoint[] = [];
  for (let offset = to; offset >= from; offset -= 1) rows.push({ day: day(offset), value_usd: value(offset) });
  return rows;
}


test("OA-25 Q16: no line until a month of snapshots exists, its newest day today or yesterday", () => {
  const today = "2026-10-06";
  // Nothing yet, or 29 days: empty.
  assert.deepEqual(portfolioTrendOf([], today), { days: 30, points: [], change_bps: null });
  assert.deepEqual(portfolioTrendOf(days(-29, 0), today).points, []);
  // 31 valued days ending today: the 30 days back from today, 31 points, oldest first.
  const month = portfolioTrendOf(days(-30, 0), today);
  assert.equal(month.points.length, 31);
  assert.deepEqual([month.points[0], month.points.at(-1)], [{ day: "2026-09-06", value_usd: "70.00" }, { day: "2026-10-06", value_usd: "100.00" }]);
  assert.equal(month.change_bps, "4286");
  // Today's sweep has not reached the account yet: yesterday's line.
  const yesterday = portfolioTrendOf(days(-31, -1), today);
  assert.deepEqual([yesterday.points[0]!.day, yesterday.points.at(-1)!.day], ["2026-09-05", "2026-10-05"]);
  // Two days without a snapshot (the job stopped): no line rather than a stale one.
  assert.deepEqual(portfolioTrendOf(days(-32, -2), today).points, []);
  // The day 30 days before the newest one was skipped: no line (never a 29- or 31-day change under "30 days").
  const holed = days(-30, 0).filter((row) => row.day !== day(-30));
  assert.deepEqual(portfolioTrendOf(holed, today).points, []);
  // A skipped day inside the window is a gap, never filled.
  const gap = portfolioTrendOf(days(-30, 0).filter((row) => row.day !== day(-10)), today);
  assert.equal(gap.points.length, 30);
  assert.ok(!gap.points.some((point) => point.day === day(-10)));
  // Older rows than the window are not points.
  assert.equal(portfolioTrendOf(days(-60, 0), today).points.length, 31);
});

test("OA-25 Q16: the change is exact basis points, half away from zero, and none from a zero start", () => {
  assert.equal(changeBps("100.00", "118.00"), "1800");
  assert.equal(changeBps("100.00", "82.00"), "-1800");
  assert.equal(changeBps("3.00", "4.00"), "3333");
  assert.equal(changeBps("3.00", "2.00"), "-3333");
  // 1/8 bp: 0.0125% → 1 bp after rounding half away from zero (0.5 bp exactly rounds up in magnitude).
  assert.equal(changeBps("200.00", "200.01"), "1");
  assert.equal(changeBps("200.00", "199.99"), "-1");
  assert.equal(changeBps("400.00", "400.01"), "0");
  assert.equal(changeBps("0.00", "50.00"), null);
  assert.equal(changeBps("50.00", "0.00"), "-10000");
  // Far beyond a float's integers.
  assert.equal(changeBps("0.01", "999999999999999999.99"), "999999999999999999980000");
  assert.throws(() => changeBps("1e3", "1.00"), TypeError);
  const zeroStart = portfolioTrendOf(days(-30, 0, (offset) => (offset === -30 ? "0.00" : "5.00")), "2026-10-06");
  assert.equal(zeroStart.points.length, 31);
  assert.equal(zeroStart.change_bps, null);
});

test("gap 13: the 1W, 1M and All ranges follow the trend's rule; 1M is the gold card's line", () => {
  const today = "2026-10-06";
  // A week: shown once the day 7 before the newest is valued; a skipped day is a gap, never filled.
  assert.deepEqual(portfolioHistoryOf(days(-6, 0), today, "1w").points, []);
  const week = portfolioHistoryOf(days(-7, 0).filter((point) => point.day !== day(-3)), today, "1w");
  assert.deepEqual(week.points.map((point) => point.day), [day(-7), day(-6), day(-5), day(-4), day(-2), day(-1), day(0)]);
  assert.equal(week.change_bps, changeBps("93.00", "100.00"));
  // 1M answers exactly what the gold card's trend answers.
  for (const rows of [days(-30, 0), days(-31, -1), days(-29, 0), days(-32, -2)]) {
    const month = portfolioHistoryOf(rows, today, "1m");
    const trend = portfolioTrendOf(rows, today);
    assert.deepEqual([month.points, month.change_bps], [trend.points, trend.change_bps]);
  }
  // All: from the oldest valued day, once there are two and the newest is today or yesterday.
  assert.deepEqual(portfolioHistoryOf(days(0, 0), today, "all").points, []);
  const value = (offset: number) => `${200 + offset}.00`;
  const all = portfolioHistoryOf(days(-120, -1, value), today, "all");
  assert.deepEqual([all.points.length, all.points[0]!.day, all.change_bps], [120, day(-120), changeBps("80.00", "199.00")]);
  assert.deepEqual(portfolioHistoryOf(days(-120, -2, value), today, "all"), { range: "all", points: [], change_bps: null });
  // The range parameter: required, once, one of three.
  assert.equal(portfolioHistoryRange(new URLSearchParams("range=1w")), "1w");
  for (const bad of ["", "range=1d", "range=1w&range=1m"]) {
    assert.throws(() => portfolioHistoryRange(new URLSearchParams(bad)), (error: unknown) => error instanceof SocialRouteError && error.code === "invalid_parameter", bad);
  }
});

test("gap 13: `all` reads at most the retention's 400 days, today's included; 1w and 1m read the trend's window", async () => {
  const reads: unknown[][] = [];
  const db = { read: async (_sql: string, values: unknown[]) => { reads.push(values); return { rows: [] }; } } as unknown as ReadableDatabase;
  const now = Date.parse("2026-10-06T12:00:00.000Z");
  await readPortfolioHistory(db, "a", now, "all");
  await readPortfolioHistory(db, "a", now, "1w");
  await readPortfolioHistory(db, "a", now, "all", Date.parse("2026-09-01T08:00:00.000Z"));
  // [account, before, since, limit]
  assert.deepEqual(reads[0]!.slice(1), ["2026-10-07", day(-(PORTFOLIO_HISTORY_MAX_DAYS - 1)), PORTFOLIO_HISTORY_MAX_DAYS]);
  assert.deepEqual(reads[1]!.slice(1), ["2026-10-07", day(-8), 9]);
  assert.equal(reads[2]![2], "2026-09-01", "a public portfolio's history starts the day it became public");
});