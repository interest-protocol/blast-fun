import { bpsPercent } from "@blast/core/lib/bps.ts";
import { changeBps } from "@blast/core/modules/social/prices/change.ts";
import { exactDecimal, exactText, subtractExact } from "@blast/core/web/exact-amount.ts";
import type { HomeHolder } from "@blast/core/web/contracts/home.ts";
import { readablePrice } from "#web/lib/market-format.ts";

/** The day's move from the coin's market read (`windows["24h"]`): the signed USD change and its basis points, from one opening price. */
export type PriceMove = Readonly<{ usd: string; bps: number }>;

export function priceDirection(change: number) {
  return change > 0 ? "up" : change < 0 ? "down" : undefined;
}

export function formatChange(change: number) {
  return `${change > 0 ? "+" : ""}${(change / 100).toFixed(2)}%`;
}

/** The board's "+$0.0137 (3.42%)": the signed dollar move, then the percentage; the percentage alone when the dollar move is unreadable. */
export function formatMove(move: PriceMove) {
  const magnitude = readablePrice(move.usd.replace(/^[-+]/, ""));
  if (magnitude === "—") return formatChange(move.bps);
  const sign = magnitude === "0" ? "" : move.usd.startsWith("-") ? "-" : "+";
  return `${sign}$${magnitude} (${(Math.abs(move.bps) / 100).toFixed(2)}%)`;
}

/** The day's move of a dollar price shown now against the read's price 24 hours back, so the move ticks with the price. */
export function liveDayMove(usdNow: string | null, openUsd: string | null): PriceMove | null {
  const bps = changeBps(usdNow, openUsd);
  const now = exactDecimal(usdNow);
  const open = exactDecimal(openUsd);
  if (bps === null || !now || !open) return null;
  const up = subtractExact(now, open);
  return { usd: up ? exactText(up) : `-${exactText(subtractExact(open, now)!)}`, bps };
}

export function presaleHolderShare(holder: HomeHolder) {
  if (holder.share_bps === null) return null;
  if (holder.share_bps === 0 && holder.balance !== "0") return "<0.01%";
  return bpsPercent(BigInt(holder.share_bps));
}
