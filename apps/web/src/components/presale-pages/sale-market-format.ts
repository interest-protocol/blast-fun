import { bpsPercent } from "@blast/core/lib/bps.ts";
import { divideExact, exactDecimal, exactText } from "@blast/core/web/exact-amount.ts";
import type { SocialPriceHistory } from "@blast/core/web/contracts/prices.ts";
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

export function presaleHolderShare(holder: HomeHolder) {
  if (holder.share_bps === null) return null;
  if (holder.share_bps === 0 && holder.balance !== "0") return "<0.01%";
  return bpsPercent(BigInt(holder.share_bps));
}

export function poolHeadlinePrice({ usd, asOf, coinType, quoteType, displayRate, history }: Readonly<{
  usd: string | null;
  asOf: number | null;
  coinType: string;
  quoteType: string;
  displayRate: string | null;
  history: SocialPriceHistory | null | undefined;
}>) {
  if (usd == null) {
    const quote = history?.quote;
    return history?.coin_type === coinType && quote?.coin_type === quoteType
      ? { value: quote.price, asOf: quote.as_of_ms, quoted: true }
      : null;
  }
  const rate = exactDecimal(displayRate);
  const price = exactDecimal(usd);
  const converted = rate && price ? divideExact(price, rate) : null;
  return converted ? { value: exactText(converted), asOf, quoted: true } : { value: usd, asOf, quoted: false };
}
