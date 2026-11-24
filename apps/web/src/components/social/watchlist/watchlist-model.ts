import { NOT_OPEN_YET, fillPct, multiple, opensAt, signPct, timeLeft, utc } from "@blast/core/web/format.ts";
import { readablePrice } from "#web/lib/market-format.ts";
import { PHASE_LABEL } from "@blast/core/modules/presale/presentation.ts";
import type { PresalePhase, SocialPresaleSummary } from "@blast/core/web/contracts/presales.ts";
import type { ProfilePresale } from "@blast/core/web/contracts/profile-page.ts";

/** What a card row shows, from either a watchlist page (`SocialPresaleSummary`) or the profile's holdings (`ProfilePresale`). */
export type WatchlistRow = Readonly<{
  presale_id: string;
  name: string;
  symbol: string;
  icon_url: string;
  phase: PresalePhase;
  start_ms: number;
  end_ms: number;
  fill_pct: number;
  /** Price now over the presale price; null when not trading or unknown. */
  multiple: number | null;
  /** The coin's price in dollars (a plain decimal) once it trades; null when unknown. */
  price_usd?: string | null;
  /** Blast checked who is behind the sale (`verified_team`); absent on rows cached before it. */
  verifiedTeam?: boolean;
}>;

export function rowOfSummary(presale: SocialPresaleSummary): WatchlistRow {
  const m = presale.multiple === null ? null : Number(presale.multiple);
  return {
    presale_id: presale.presale_id,
    name: presale.name,
    symbol: presale.symbol,
    icon_url: presale.icon_url,
    phase: presale.phase,
    start_ms: presale.start_ms,
    end_ms: presale.end_ms,
    fill_pct: fillPct(presale.fill_bps),
    multiple: m !== null && Number.isFinite(m) && m > 0 ? m : null,
    price_usd: presale.price_usd,
    verifiedTeam: presale.verified_team === true,
  };
}

export function rowOfProfilePresale(presale: ProfilePresale): WatchlistRow {
  return { ...presale, phase: presale.status, multiple: null, verifiedTeam: presale.verified_team === true };
}

/**
 * A watchlist row's line (§5.5): "73% filled · 6h 12m left", "Opens Oct 14,
 * 18:00 UTC", "4.2× since presale", or the status.
 */
export function watchlistLine(row: WatchlistRow, nowMs: number): string {
  if (row.phase === "open") return `${row.fill_pct}% filled · ${timeLeft(Math.max(row.end_ms - nowMs, 0))} left`;
  if (row.phase === "pending") return opensAt(row.start_ms) === null ? NOT_OPEN_YET : `Opens ${utc(row.start_ms)}`;
  if (row.phase === "trading" && row.multiple !== null) return `${multiple(row.multiple)} since presale`;
  return PHASE_LABEL[row.phase];
}

/** A watched presale the card draws as a coin: one that trades, with a known price. */
const isCoin = (row: WatchlistRow): row is WatchlistRow & Readonly<{ price_usd: string }> => row.phase === "trading" && !!row.price_usd && Number(row.price_usd) > 0;

/** The sales the card draws as coins, whose 24-hour change it reads (its ten rows fit one `GET /api/social/prices`). */
export function watchedCoinIds(rows: readonly WatchlistRow[]): string[] {
  return rows.filter(isCoin).map((row) => row.presale_id);
}

/**
 * A watched presale that now trades, as the boards' coin row draws it: the
 * price with subscript zeros and, under it, the last 24 hours' change
 * ("+5.71%", "−3.05%"; R3-20's `change_24h_bps`, undefined while the prices
 * read, null without one, when the line is left out). Null for any other
 * presale, or a trading one without a known price.
 */
export function watchedCoin(row: WatchlistRow, changeBps: number | null | undefined): Readonly<{ price: string; move: Readonly<{ text: string; tone: "up" | "down" }> | "loading" | null; label: string }> | null {
  if (!isCoin(row)) return null;
  const price = `$${readablePrice(row.price_usd)}`;
  const move = changeBps === undefined ? ("loading" as const) : changeBps === null ? null : { text: signPct(changeBps / 100), tone: changeBps >= 0 ? ("up" as const) : ("down" as const) };
  return { price, move, label: `${row.symbol}, ${price}${move !== null && move !== "loading" ? `, ${move.text} today` : ""}` };
}

/** The card's order (the Portfolio board): coins first, then open presales, then the rest, each kind in the list's own order. */
export function watchlistOrder(rows: readonly WatchlistRow[]): WatchlistRow[] {
  const rank = (row: WatchlistRow) => isCoin(row) ? 0 : row.phase === "open" ? 1 : row.phase === "pending" ? 2 : 3;
  return rows.map((row, index) => ({ row, index })).sort((a, b) => rank(a.row) - rank(b.row) || a.index - b.index).map(({ row }) => row);
}
