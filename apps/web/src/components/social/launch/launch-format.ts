import { coinDisplay } from "#web/components/social/coins/coin-display.ts";
import { createQuoteOf } from "@blast/core/web/contracts/create.ts";

/** A whole-coin figure, short: `10.2K`, `1.25M`, `840`. */
export function compact(value: number): string {
  return new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: value >= 1_000 ? 1 : 2 }).format(value);
}

/** The quote coin's symbol as amounts read (`SUI`, `USDC`). */
export function quoteLabel(quoteType: string): string {
  const quote = createQuoteOf(quoteType);
  return coinDisplay(quoteType, quote?.symbol ?? "", quote?.name ?? "").symbol;
}

/**
 * A share the curve projects (sold, unsold), in whole percent: `39%`. Shares
 * the creator or the contracts set keep `pct`, which reads them as set.
 */
export function share(bps: number): string {
  return `${Math.round(bps / 100)}%`;
}

/** The pool opens within half a percent of the curve's last price: one figure says both (TS-2). */
export function poolOpensAtGraduation(pool: number, terminal: number): boolean {
  return Math.abs(Math.round((pool / terminal - 1) * 10_000)) < 50;
}

/** Difference between the selected pool ratio and the projected terminal curve price, in whole percent. */
export function poolPriceDifference(pool: number, terminal: number): string {
  const gap = Math.round((pool / terminal - 1) * 10_000);
  if (poolOpensAtGraduation(pool, terminal)) return "Opens near the curve’s last price";
  return `Opens ${share(Math.abs(gap))} ${gap > 0 ? "above" : "below"} the curve’s last price`;
}
