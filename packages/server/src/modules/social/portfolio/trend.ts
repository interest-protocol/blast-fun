import type { ReadableDatabase } from "@blast/core/modules/database/transaction.ts";
import {
  PORTFOLIO_HISTORY_DAYS,
  PORTFOLIO_HISTORY_MAX_DAYS,
  PORTFOLIO_HISTORY_RANGES,
  PORTFOLIO_TREND_DAYS,
  type PortfolioHistory,
  type PortfolioHistoryRange,
  type PortfolioTrend,
  type PortfolioTrendPoint,
} from "@blast/core/modules/social/contracts/portfolio.ts";
import { SocialRouteError } from "@blast/core/modules/social/route-kit/errors.ts";

/**
 * The gold card's 30-day trend (R3-08, OA-25 Q16) from the daily snapshots
 * (`snapshots.ts`, 0097), and the read behind it.
 *
 * **The read** is one account's valued days, newest first, keyset on `day`:
 * `day < before` and `day >= since`, at most `limit` rows. It is one range of
 * 0097's key `(account_id, day)`, whose index carries `value_usd`, so it is
 * an index-only scan whatever the table's size; an older page starts
 * `before` the last day of the previous one. Skipped days are not points.
 *
 * **The trend** is shown only once the account has a month of them: its
 * newest valued day `L` is today or yesterday (UTC; today's sweep may not
 * have reached it yet), and `L − 30 days` is valued too. The points are the
 * valued days from `L − 30` to `L` (a skipped day is a gap, never filled),
 * and the change is `value(L) / value(L − 30) − 1` in basis points, exact
 * and rounded half away from zero; none when the earlier value is zero.
 * Otherwise there are no points and the slot stays empty: never today's
 * holdings at old prices, never a series the account did not hold.
 *
 * **A public portfolio** (OA-10, the owner's answer of 2026-10-06) shows
 * only the days on or after the UTC day it became public
 * (`social_accounts.portfolio_public_since`, 0097): the read's window starts
 * there, so the month the trend needs is a month of public history, and a
 * portfolio made public again after going private starts over. The owner's
 * own view (`/me/portfolio`) reads the whole history.
 */

const DAY_MS = 86_400_000;

/** `limit` and the bounds of one page of an account's snapshots. */
export type PortfolioSnapshotPage = Readonly<{
  /** Exclusive upper bound, `YYYY-MM-DD`: the page's days are before it. */
  before: string;
  /** Inclusive lower bound, `YYYY-MM-DD`, or null for none. */
  since: string | null;
  limit: number;
}>;

// `s.day` in the ORDER BY: the output column `day` is text, and ordering by it would sort instead of reading the key backward.
const SNAPSHOTS_SQL = `SELECT s.day::text AS day, s.value_usd::text AS value_usd
  FROM social_portfolio_snapshots s
  WHERE s.account_id = $1::uuid AND s.day < $2::date AND s.day >= $3::date AND s.value_usd IS NOT NULL
  ORDER BY s.day DESC
  LIMIT $4`;

export const PORTFOLIO_TREND_STATEMENTS = Object.freeze({ snapshots: SNAPSHOTS_SQL });

/** One page of the account's valued days, newest first. */
export async function readPortfolioSnapshots(
  db: ReadableDatabase,
  accountId: string,
  page: PortfolioSnapshotPage,
): Promise<PortfolioTrendPoint[]> {
  const { rows } = await db.read<PortfolioTrendPoint>(SNAPSHOTS_SQL, [accountId, page.before, page.since ?? "-infinity", page.limit]);
  return rows;
}

function dayPlus(day: string, days: number): string {
  return new Date(Date.parse(`${day}T00:00:00.000Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

const USD = /^(0|[1-9][0-9]*)\.([0-9]{2})$/;

function centsOf(value: string): bigint {
  const match = USD.exec(value);
  if (!match) throw new TypeError(`Not a USD amount: ${JSON.stringify(value)}.`);
  return BigInt(match[1] + match[2]);
}

/** `(last / first − 1)` in basis points, half away from zero; null when `first` is zero. */
export function changeBps(first: string, last: string): string | null {
  const from = centsOf(first);
  if (from === 0n) return null;
  const scaled = (centsOf(last) - from) * 10_000n;
  const negative = scaled < 0n;
  const magnitude = negative ? -scaled : scaled;
  let bps = magnitude / from;
  if ((magnitude % from) * 2n >= from) bps += 1n;
  return bps === 0n ? "0" : `${negative ? "-" : ""}${bps}`;
}

/**
 * The trend from the account's newest valued days (newest first, as
 * `readPortfolioSnapshots` returns them), on UTC day `today`.
 */
export function portfolioTrendOf(newestFirst: readonly PortfolioTrendPoint[], today: string): PortfolioTrend {
  const empty: PortfolioTrend = { days: PORTFOLIO_TREND_DAYS, points: [], change_bps: null };
  const latest = newestFirst[0];
  if (!latest || latest.day < dayPlus(today, -1)) return empty;
  const anchorDay = dayPlus(latest.day, -PORTFOLIO_TREND_DAYS);
  const anchor = newestFirst.find((point) => point.day === anchorDay);
  if (!anchor) return empty;
  const points = newestFirst.filter((point) => point.day >= anchorDay).reverse();
  return { days: PORTFOLIO_TREND_DAYS, points, change_bps: changeBps(anchor.value_usd, latest.value_usd) };
}

/**
 * The account's trend at `nowMs`: its valued days from today − 31 through
 * today (32 at most, the window an anchor can be in), then `portfolioTrendOf`.
 * With `publicSinceMs` (a public portfolio's `portfolio_public_since`) the
 * window starts no earlier than that UTC day, so no day before the portfolio
 * became public is read, and the anchor must be inside the public history.
 */
export async function readPortfolioTrend(
  db: ReadableDatabase,
  accountId: string,
  nowMs: number,
  publicSinceMs: number | null = null,
): Promise<PortfolioTrend> {
  const today = new Date(nowMs).toISOString().slice(0, 10);
  const window = dayPlus(today, -(PORTFOLIO_TREND_DAYS + 1));
  const publicSince = publicSinceMs === null ? null : new Date(publicSinceMs).toISOString().slice(0, 10);
  const rows = await readPortfolioSnapshots(db, accountId, {
    before: dayPlus(today, 1),
    since: publicSince !== null && publicSince > window ? publicSince : window,
    limit: PORTFOLIO_TREND_DAYS + 2,
  });
  return portfolioTrendOf(rows, today);
}

/**
 * Redesign gap 13: one range of the portfolio chart (`PortfolioHistory`)
 * from the account's newest valued days (newest first), on UTC day `today`.
 * `1w` and `1m` are the trend's rule for 7 and 30 days; `all` runs from the
 * oldest valued day read, once there are two.
 */
export function portfolioHistoryOf(newestFirst: readonly PortfolioTrendPoint[], today: string, range: PortfolioHistoryRange): PortfolioHistory {
  const empty: PortfolioHistory = { range, points: [], change_bps: null };
  const latest = newestFirst[0];
  if (!latest || latest.day < dayPlus(today, -1)) return empty;
  const anchor = range === "all"
    ? (newestFirst.length > 1 ? newestFirst.at(-1) : undefined)
    : newestFirst.find((point) => point.day === dayPlus(latest.day, -PORTFOLIO_HISTORY_DAYS[range]));
  if (!anchor) return empty;
  const points = newestFirst.filter((point) => point.day >= anchor.day).reverse();
  return { range, points, change_bps: changeBps(anchor.value_usd, latest.value_usd) };
}

/** `range`, at most once, one of `PORTFOLIO_HISTORY_RANGES` (required), or `invalid_parameter`. */
export function portfolioHistoryRange(params: URLSearchParams): PortfolioHistoryRange {
  const values = params.getAll("range");
  const value = values.length === 1 ? values[0] : undefined;
  if (!(PORTFOLIO_HISTORY_RANGES as readonly string[]).includes(value ?? "")) throw new SocialRouteError("invalid_parameter", { extra: { parameter: "range" } });
  return value as PortfolioHistoryRange;
}

/**
 * The account's range at `nowMs`: its valued days from the range's first
 * possible anchor (one day before `1w`'s or `1m`'s, as the trend reads; the
 * retention's `PORTFOLIO_HISTORY_MAX_DAYS` days, today's included, for
 * `all`) through today, one index-only range of 0097's key,
 * then `portfolioHistoryOf`. With `publicSinceMs` the window starts no
 * earlier than the UTC day the portfolio became public.
 */
export async function readPortfolioHistory(
  db: ReadableDatabase,
  accountId: string,
  nowMs: number,
  range: PortfolioHistoryRange,
  publicSinceMs: number | null = null,
): Promise<PortfolioHistory> {
  const today = new Date(nowMs).toISOString().slice(0, 10);
  // Days back from today: `all` reads at most PORTFOLIO_HISTORY_MAX_DAYS days, today's included.
  const days = range === "all" ? PORTFOLIO_HISTORY_MAX_DAYS - 1 : PORTFOLIO_HISTORY_DAYS[range] + 1;
  const window = dayPlus(today, -days);
  const publicSince = publicSinceMs === null ? null : new Date(publicSinceMs).toISOString().slice(0, 10);
  const rows = await readPortfolioSnapshots(db, accountId, {
    before: dayPlus(today, 1),
    since: publicSince !== null && publicSince > window ? publicSince : window,
    limit: days + 1,
  });
  return portfolioHistoryOf(rows, today, range);
}
