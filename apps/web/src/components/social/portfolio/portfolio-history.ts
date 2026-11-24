"use client";

import { useQueries } from "@tanstack/react-query";

import {
  PORTFOLIO_HISTORY_RANGES,
  socialPortfolioHistoryPath,
  socialPortfolioHistorySchema,
  type PortfolioHistory,
  type PortfolioHistoryRange,
} from "@blast/core/web/contracts/portfolio.ts";
import { signPct, usd } from "@blast/core/web/format.ts";
import { unwrapApiResult } from "#web/lib/query/client.ts";
import { queryKeys } from "#web/lib/query/keys.ts";
import { useAppQueryClient } from "#web/lib/query/provider.tsx";

import { trendFrom, type PortfolioTrendView } from "../profile/portfolio-trend";
import { callSocialApi } from "#web/components/social/social-api.ts";
import type { AccessTokenSource } from "../social-fetch";

/**
 * The hero's value chart (redesign data gap 13): `GET
 * /api/social/me/portfolio/history?range=` over the daily snapshots. `1D` is
 * the live portfolio’s `today` move. History ranges remain selectable when
 * daily snapshots are missing so a user can check a wider window.
 */
export type PortfolioPeriod = "1d" | PortfolioHistoryRange;

export const PORTFOLIO_PERIODS: readonly (readonly [PortfolioPeriod, string])[] = [["1d", "1D"], ["1w", "1W"], ["1m", "1M"], ["all", "All"]];

/** What the change line says after the move. */
export const PERIOD_WORDS: Readonly<Record<PortfolioPeriod, string>> = { "1d": "today", "1w": "past week", "1m": "past month", all: "all time" };

export type PortfolioHistoryRead =
  | Readonly<{ status: "loading" }>
  | Readonly<{ status: "ready"; trend: PortfolioTrendView | null; first: number | null; last: number | null }>
  | Readonly<{ status: "error"; retry: () => void }>;

export type PortfolioHistoryReads = Readonly<Record<PortfolioHistoryRange, PortfolioHistoryRead>>;

/** One range's read; it shares the portfolio's key prefix, so a completed transaction refreshes it with the rest. */
export function portfolioHistoryQuery(getAccessToken: AccessTokenSource, range: PortfolioHistoryRange) {
  return {
    queryKey: queryKeys.me.portfolioHistory(range),
    queryFn: async ({ signal }: Readonly<{ signal: AbortSignal }>) => unwrapApiResult(
      await callSocialApi({ getAccessToken, signal }, socialPortfolioHistoryPath(range), { method: "GET" }, socialPortfolioHistorySchema),
    ),
    staleTime: 5 * 60_000,
  };
}

/** A range's read as the hero draws it: its line (two points or more), and its first and last values for the change. */
export function historyRead(data: PortfolioHistory | undefined, failed: boolean, retry: () => void): PortfolioHistoryRead {
  if (data) {
    const values = data.points.map((point) => Number(point.value_usd));
    return { status: "ready", trend: trendFrom(data), first: values[0] ?? null, last: values[values.length - 1] ?? null };
  }
  return failed ? { status: "error", retry } : { status: "loading" };
}

/** The three ranges, read once the page has an account. */
export function usePortfolioHistory(getAccessToken: AccessTokenSource, enabled: boolean): PortfolioHistoryReads {
  const reads = useQueries({ queries: PORTFOLIO_HISTORY_RANGES.map((range) => ({ ...portfolioHistoryQuery(getAccessToken, range), enabled })) }, useAppQueryClient());
  const [week, month, all] = PORTFOLIO_HISTORY_RANGES.map((_, index) => {
    const read = reads[index]!;
    return historyRead(read.data, read.isError, () => void read.refetch());
  });
  return { "1w": week!, "1m": month!, all: all! };
}

/** Whether a range has a line to show; 1D never has one. */
export function periodHasLine(period: PortfolioPeriod, history: PortfolioHistoryReads | undefined): boolean {
  if (period === "1d" || !history) return false;
  const read = history[period];
  return read.status === "ready" && read.trend !== null;
}

/**
 * The range's move as the change line draws it: "+$312.40 (2.57%)", the
 * dollars from the first and last valued days and the percentage from the
 * read's exact basis points. Null when the range has no line or no defined
 * change (a zero first value).
 */
export function rangeChange(read: PortfolioHistoryRead | undefined, hidden: boolean): Readonly<{ text: string; tone: "up" | "down" | null }> | null {
  if (!read || read.status !== "ready" || !read.trend || read.first === null || read.last === null) return null;
  if (hidden) return { text: "Hidden", tone: null };
  const delta = read.last - read.first;
  const up = delta >= 0;
  const pct = read.trend.changeBps === null ? null : Math.abs(Number(read.trend.changeBps)) / 100;
  return { text: `${up ? "+" : "−"}${usd(Math.abs(delta), 2)}${pct === null ? "" : ` (${signPct(pct).replace(/^\+/, "")})`}`, tone: up ? "up" : "down" };
}
