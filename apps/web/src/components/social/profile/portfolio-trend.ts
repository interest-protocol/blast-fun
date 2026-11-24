import {
  PORTFOLIO_TREND_DAYS,
  type PortfolioTrend,
  type SocialPortfolio,
} from "@blast/core/web/contracts/portfolio.ts";

/**
 * The gold card's 30-day line (R3-08, FEATURE-MAP-R3 §6), from the portfolio
 * read's `trend` (OA-25 Q16): the account's daily portfolio-value snapshots,
 * written once a UTC day by the social worker (`portfolio/snapshots.ts`).
 *
 * **Empty until a month of data exists.** The read answers no points until
 * the account's newest snapshot is today or yesterday and the day 30 days
 * before it was valued too (`portfolio/trend.ts`); the card's slot then
 * stays empty — no line, no caption, no placeholder figure — and keeps its
 * height, so nothing moves when the line arrives. Nothing here computes a
 * series client-side, and the line is never today's holdings at old prices.
 *
 * - `portfolioTrend(portfolio)` is what the card draws, or null for the
 *   empty slot;
 * - `trendPath(points)` is the reference's geometry (a 400×100 box,
 *   `preserveAspectRatio: none`, the area closed 40 units below the floor),
 *   each point placed by its day, so a skipped day stays a gap between two
 *   real values and is never filled; `trendDomain` and `trendData` are the
 *   same geometry as the card's recharts plot (`TrendPlot.tsx`, OA-28 M4)
 *   is given it;
 * - `trendCaption(trend)` is `30 days +18%` / `30 days −18%` from the
 *   read's exact basis points, or no figure when the change is undefined
 *   (the earlier value was zero).
 */

export { PORTFOLIO_TREND_DAYS };

/** One point as the card draws it: the day (00:00 UTC) and the value, for geometry only. */
export type PortfolioTrendViewPoint = Readonly<{ at_ms: number; usd: number }>;

export type PortfolioTrendView = Readonly<{
  points: readonly PortfolioTrendViewPoint[];
  /** The 30-day change in basis points (signed integer text), exact from the read; null when undefined. */
  changeBps: string | null;
}>;

/** The reference's drawing box (`goldTrend`): 400×100, stretched to the slot. */
export const TREND_WIDTH = 400;
export const TREND_HEIGHT = 100;
/** How far below the floor the filled area closes, so its gradient never shows a bottom edge. */
export const TREND_OVERSHOOT = 40;

/** The read's trend as the card draws it, or null when there is nothing to draw (fewer than two points). */
export function trendFrom(body: (Omit<PortfolioTrend, "days"> & Partial<Pick<PortfolioTrend, "days">>) | null | undefined): PortfolioTrendView | null {
  if (!body || body.points.length < 2) return null;
  return {
    // Geometry only: the figures shown are the read's exact strings and basis points.
    points: body.points.map((point) => ({ at_ms: Date.parse(`${point.day}T00:00:00.000Z`), usd: Number(point.value_usd) })),
    changeBps: body.change_bps,
  };
}

/** The portfolio's 30-day line, or null while the account has less than a month of daily snapshots. */
export function portfolioTrend(portfolio: SocialPortfolio | null): PortfolioTrendView | null {
  return trendFrom(portfolio?.trend);
}

/**
 * The line and the filled area under it, in the reference's geometry: x by
 * each point's time across the series' span, y scaled between the series'
 * own low and high, the area closed below the floor. A flat series sits on
 * the middle line (the reference divides by zero there and draws nothing).
 */
export function trendPath(points: readonly PortfolioTrendViewPoint[], width = TREND_WIDTH, height = TREND_HEIGHT): Readonly<{ line: string; area: string }> {
  const values = points.map((point) => point.usd);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min;
  const start = points[0]?.at_ms ?? 0;
  const length = (points[points.length - 1]?.at_ms ?? start) - start;
  const line = points
    .map((point, index) => {
      const x = length === 0 ? (index / Math.max(points.length - 1, 1)) * width : ((point.at_ms - start) / length) * width;
      const y = span === 0 ? height / 2 : height - ((point.usd - min) / span) * height;
      return `${index === 0 ? "M" : "L"}${x.toFixed(1)} ${y.toFixed(1)}`;
    })
    .join(" ");
  const floor = height + TREND_OVERSHOOT;
  return { line, area: `${line} L${width} ${floor} L0 ${floor}Z` };
}

/**
 * `trendPath`'s geometry as value ranges, for a chart that maps `min` to the
 * box's bottom and `max` to its top: a flat series is widened by one either
 * way so it sits on the middle line, and `base` is the value the area closes
 * at, `TREND_OVERSHOOT` (40% of the box) below the floor.
 */
export function trendDomain(points: readonly PortfolioTrendViewPoint[]): Readonly<{ min: number; max: number; base: number }> {
  const values = points.map((point) => point.usd);
  let min = Math.min(...values);
  let max = Math.max(...values);
  if (max === min) {
    min -= 1;
    max += 1;
  }
  return { min, max, base: min - (TREND_OVERSHOOT / TREND_HEIGHT) * (max - min) };
}

/**
 * The plot's data: `x` from 0 to 1 across the box, each point placed by its
 * day as `trendPath` places it (evenly when every point is the same day), and
 * both coordinates moved by at most 0.05 of the 400×100 box so each vertex
 * lands where `trendPath` writes it (one decimal, as the gate's `goldTrend`
 * does) before the box is stretched to the slot.
 */
export function trendData(points: readonly PortfolioTrendViewPoint[]): { x: number; v: number }[] {
  const { min, max } = trendDomain(points);
  const start = points[0]?.at_ms ?? 0;
  const length = (points[points.length - 1]?.at_ms ?? start) - start;
  return points.map((point, index) => {
    const share = length === 0 ? index / Math.max(points.length - 1, 1) : (point.at_ms - start) / length;
    const x = Number((share * TREND_WIDTH).toFixed(1));
    const y = Number((TREND_HEIGHT - ((point.usd - min) / (max - min)) * TREND_HEIGHT).toFixed(1));
    return { x: x / TREND_WIDTH, v: min + ((TREND_HEIGHT - y) / TREND_HEIGHT) * (max - min) };
  });
}

export type TrendCaption = Readonly<{
  /** Always "30 days". */
  label: string;
  /** "+18%" or "−18%" (U+2212), whole percent; null when the change is undefined (no figure is shown). */
  value: string | null;
  /** What a screen reader hears for the whole chart. */
  description: string;
}>;

/**
 * The caption under the line, and the chart's accessible description. The
 * sign is the exact change's (the reference's `d30 >= 0`), the figure its
 * magnitude rounded half up to a whole percent, in integers.
 */
export function trendCaption(trend: PortfolioTrendView): TrendCaption {
  const label = `${PORTFOLIO_TREND_DAYS} days`;
  if (trend.changeBps === null || !/^(0|-?[1-9][0-9]*)$/.test(trend.changeBps)) {
    return { label, value: null, description: `${PORTFOLIO_TREND_DAYS}-day trend` };
  }
  const bps = BigInt(trend.changeBps);
  const down = bps < 0n;
  const percent = ((down ? -bps : bps) + 50n) / 100n;
  return {
    label,
    value: `${down ? "−" : "+"}${percent}%`,
    description: `${PORTFOLIO_TREND_DAYS}-day trend: ${down ? "down" : "up"} ${percent}%`,
  };
}
