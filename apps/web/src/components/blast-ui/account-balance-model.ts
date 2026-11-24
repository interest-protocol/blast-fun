import { cents, HIDDEN_AMOUNT } from "@blast/core/lib/format.ts";
import type { PortfolioSummaryState } from "./portfolio";

export const PARTIAL_BALANCE_NOTE = "Some assets have no price and aren’t included in these values.";

export function figureText(value: number | null | undefined, portfolio: PortfolioSummaryState, hidden: boolean): string {
  if (hidden) return HIDDEN_AMOUNT;
  if (value != null) return cents(value);
  if (portfolio.status === "loading") return "Loading…";
  return "Unavailable";
}

export function balanceAmount(portfolio: PortfolioSummaryState, hidden: boolean): string {
  const summary = portfolio.status === "ready" ? portfolio.summary : null;
  if (!hidden && summary?.unpriced_assets) {
    return summary.known_value_usd == null ? "Portfolio" : cents(summary.known_value_usd);
  }
  return figureText(summary?.total_usd, portfolio, hidden);
}

export function balanceBreakdown(portfolio: PortfolioSummaryState, hidden: boolean): readonly Readonly<{ label: string; value: string }>[] {
  const summary = portfolio.status === "ready" ? portfolio.summary : null;
  const row = (label: string, value: number | null | undefined, known: number | undefined) => {
    if (hidden || value != null || !summary?.unpriced_assets || known === undefined) return { label, value: figureText(value, portfolio, hidden) };
    return { label, value: known > 0 ? cents(known) : "No price" };
  };
  return [
    row("Coins", summary?.breakdown?.coins, summary?.known_breakdown?.coins),
    row("In presales", summary?.breakdown?.committed, summary?.known_breakdown?.committed),
    row("To claim", summary?.breakdown?.claimable, summary?.known_breakdown?.claimable),
  ];
}

/**
 * Why the popover shows no full total, in one plain sentence, and whether
 * trying again can help (WS-4). A priced subtotal says what it leaves out;
 * prices that do not exist yet are not an error, so they offer no retry.
 */
export function balanceNote(portfolio: PortfolioSummaryState, hidden: boolean): Readonly<{ title?: string; text: string; retry: boolean }> | null {
  if (hidden) return null;
  if (portfolio.status === "unavailable") return { title: "Your balance didn’t load", text: "Your coins are safe.", retry: true };
  if (portfolio.status !== "ready" || portfolio.summary.total_usd != null) return null;
  const { summary } = portfolio;
  if (summary.unpriced_assets) {
    return summary.known_value_usd != null
      ? { text: PARTIAL_BALANCE_NOTE, retry: false }
      : { text: "Your coins have no USD price yet, so there is no total.", retry: false };
  }
  return { title: "Part of your balance didn’t load", text: "Your coins are safe.", retry: true };
}

const compactUsd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", notation: "compact", maximumFractionDigits: 2 });

export function compactBalanceAmount(summary: Extract<PortfolioSummaryState, { status: "ready" }>["summary"] | null, hidden: boolean, fallback: string) {
  const value = summary?.total_usd ?? summary?.known_value_usd;
  if (hidden) return fallback;
  if (value == null) return fallback;
  if (summary?.unpriced_assets && (summary.known_value_usd ?? 0) <= 0) return fallback;
  if (value > 0 && value < 0.005) return fallback;
  return compactUsd.format(value);
}
