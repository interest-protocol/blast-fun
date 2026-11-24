import { coinPagePath } from "@blast/core/modules/launchpad-coin/page-key.ts";
import type { SocialPriceHistory } from "@blast/core/web/contracts/prices.ts";
import type { SocialPresalePerson } from "@blast/core/web/contracts/presales.ts";
import { normalizeSearchQuery, peopleForViewer, type SocialSearchPresale, type SocialSearchResponse } from "@blast/core/web/contracts/search.ts";
import type { SocialTradeCoin } from "@blast/core/web/contracts/trades.ts";
import { bpsToPct } from "@blast/core/modules/social/prices/change.ts";
import { presalePath } from "@blast/core/modules/social/items/do-the-same.ts";
import { indexedPoolCoin } from "@blast/core/modules/social/portfolio/core-coins.ts";

import { SUI_COIN_TYPE, USDC_COIN_TYPE } from "@blast/core/lib/sui/coin-types.ts";

/**
 * The search sheet's model (canonical UI §12), free of React: the device's
 * recent terms, the rows the sheet shows for a term and an answer, and the
 * keyboard highlight.
 */

/** The prototype's key (`store` adds `blast.`), JSON: the five latest terms, newest first. */
export const RECENTS_KEY = "blast.recents";
export const RECENTS_MAX = 5;
/** A stored term is at most this long (a sale name or a callsign is far shorter). */
const RECENT_MAX_LENGTH = 64;

type RecentStorage = Pick<Storage, "getItem" | "setItem">;

/** The stored recents; anything missing or malformed reads as none. */
export function readRecents(storage: RecentStorage | null): string[] {
  try {
    const parsed: unknown = JSON.parse(storage?.getItem(RECENTS_KEY) ?? "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((term): term is string => typeof term === "string" && term.trim() !== "" && term.length <= RECENT_MAX_LENGTH)
      .slice(0, RECENTS_MAX);
  } catch {
    return [];
  }
}

/** `term` first, without its older copy, at most five; storage refusing the write keeps them for the page's life. */
export function rememberRecent(storage: RecentStorage | null, recents: readonly string[], term: string): string[] {
  const next = [term, ...recents.filter((recent) => recent !== term)].slice(0, RECENTS_MAX);
  try {
    storage?.setItem(RECENTS_KEY, JSON.stringify(next));
  } catch {
    // Storage unavailable (a private window): kept in memory only.
  }
  return next;
}

/**
 * A coin the Coins group lists (OA-41 R3-82): SUI, which the browser adds
 * as the gate does, or a launched sale's coin from `GET
 * /api/social/trades/coins`. `presaleId` is null for SUI.
 */
export type SearchCoinListing = Readonly<{ key: string; name: string; symbol: string; coinType: string; iconUrl: string | null; presaleId: string | null; launchId?: string; usdPrice: string | null; verifiedTeam?: boolean }>;

/** A listed coin with its price and R3-20's 24-hour move, each null when unknown (the row omits it). */
export type SearchCoin = Readonly<{ coinType?: string; key: string; name: string; symbol: string; iconUrl: string | null; presaleId: string | null; launchId?: string; price: number | null; changePct: number | null; verifiedTeam?: boolean }>;

/** Coins shown with nothing typed, and with a term (the gate's `slice(0, qq ? 5 : 3)`). */
export const SEARCH_COINS_SUGGESTED = 3;
export const SEARCH_COINS_LIMIT = 5;

/** SUI as the Coins group names it (the gate's `nameOf('sui')`). */
const SUI_LISTING: SearchCoinListing = { key: "sui", name: "Sui", symbol: "SUI", coinType: SUI_COIN_TYPE, iconUrl: null, presaleId: null, usdPrice: null };

/**
 * The coins listed for the term `raw` (as the read was made for it): SUI
 * first when its name or ticker contains the term, then the coins the coins
 * route answered for it (ecosystem coins, then sale coins), in its order; three with nothing typed, five
 * otherwise. Null sale coins (no read yet) list nothing.
 */
export function listedCoins(raw: string, saleCoins: readonly SocialTradeCoin[] | null): SearchCoinListing[] {
  if (saleCoins === null) return [];
  const term = normalizeSearchQuery(raw) ?? raw.trim();
  const sui = !term || "sui".includes(term) ? [SUI_LISTING] : [];
  // The route also answers SUI for a search that names it; the browser's SUI row stands for both.
  const sales = saleCoins.filter((coin) => !sui.length || coin.coin_type !== SUI_COIN_TYPE).map((coin): SearchCoinListing => ({
    key: coin.presale_id ?? (coin.coin_type === SUI_COIN_TYPE ? "sui" : coin.coin_type === USDC_COIN_TYPE ? "usdc" : coin.coin_type),
    name: coin.name,
    symbol: coin.symbol,
    coinType: coin.coin_type,
    iconUrl: coin.icon_url,
    presaleId: coin.presale_id,
    usdPrice: coin.usd_price,
    ...(coin.launch_id && { launchId: coin.launch_id }),
    ...(coin.verified_team === true && { verifiedTeam: true }),
  }));
  return [...sui, ...sales].slice(0, term ? SEARCH_COINS_LIMIT : SEARCH_COINS_SUGGESTED);
}

/** What a listed coin's price read is asked by: its sale, or SUI's coin type. */
export const coinPriceAsk = (coin: SearchCoinListing) =>
  coin.presaleId ? ({ kind: "presale", id: coin.presaleId } as const) : ({ kind: "coin", id: coin.coinType } as const);

const usdNumber = (value: string | null | undefined): number | null => {
  if (value === null || value === undefined) return null;
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
};

/**
 * The listed coins with their figures: the price is the coins route's (at
 * most 120 s old), else the prices read's; the move is R3-20's
 * `change_24h_bps`. `prices[i]` is `coins[i]`'s read (undefined while it
 * reads, null without one): nothing is drawn in.
 */
export function pricedCoins(coins: readonly SearchCoinListing[], prices: readonly (SocialPriceHistory | null | undefined)[]): SearchCoin[] {
  return coins.map((coin, index) => {
    const read = prices[index] ?? null;
    return {
      key: coin.key,
      coinType: coin.coinType,
      name: coin.name,
      symbol: coin.symbol,
      iconUrl: coin.iconUrl,
      presaleId: coin.presaleId,
      price: usdNumber(coin.usdPrice) ?? usdNumber(read?.price_usd),
      changePct: bpsToPct(read?.change_24h_bps ?? null),
      ...(coin.launchId && { launchId: coin.launchId }),
      ...(coin.verifiedTeam && { verifiedTeam: true }),
    };
  });
}

/** One row of the sheet, in order: what the keyboard highlight walks. */
export type SearchRow =
  | Readonly<{ kind: "recent"; key: string; term: string }>
  | Readonly<{ kind: "coin"; key: string; coin: SearchCoin; href: string | null }>
  | Readonly<{ kind: "presale"; key: string; presale: SocialSearchPresale; pick: string }>
  | Readonly<{ kind: "person"; key: string; person: SocialPresalePerson; pick: string }>;

export type SearchGroup = Readonly<{ id: "recent" | "coins" | "presales" | "people"; title: string; rows: readonly SearchRow[] }>;

/**
 * The sheet's groups for the typed text `raw` and the answer for it (null
 * while none has arrived): Recent only while nothing is typed, then Coins
 * (`pricedCoins`, OA-41), Presales and People (the viewer left out, at most
 * five each). A presale remembers its name, a person its callsign (the
 * prototype's `data-pick`); a coin is not remembered (the gate's `cview`).
 */
export function searchGroups(
  raw: string,
  answer: SocialSearchResponse | null,
  recents: readonly string[],
  viewerCallsign: string | null,
  coins: readonly SearchCoin[] = [],
): SearchGroup[] {
  const groups: SearchGroup[] = [];
  if (raw.trim() === "" && recents.length) {
    groups.push({ id: "recent", title: "Recent", rows: recents.map((term) => ({ kind: "recent", key: `recent:${term}`, term })) });
  }
  if (coins.length) {
    groups.push({ id: "coins", title: "Coins", rows: coins.map((coin) => ({ kind: "coin", key: `coin:${coin.key}`, coin, href: searchCoinHref(coin) })) });
  }
  if (!answer) return groups;
  // Coin results already link to their presale and can show its market figures.
  const coinPresaleIds = new Set(coins.map((coin) => coin.presaleId));
  const presales = answer.presales.filter((presale) => !coinPresaleIds.has(presale.presale_id));
  if (presales.length) {
    groups.push({
      id: "presales",
      title: "Presales",
      rows: presales.map((presale) => ({ kind: "presale", key: `presale:${presale.presale_id}`, presale, pick: presale.name })),
    });
  }
  const people = peopleForViewer(answer.people, viewerCallsign);
  if (people.length) {
    groups.push({
      id: "people",
      title: "People",
      rows: people.map((person) => ({ kind: "person", key: `person:${person.callsign}`, person, pick: person.callsign })),
    });
  }
  return groups;
}

/** Whether a typed term found nothing at all (the sheet's "No coins, presales or people match …"; never when a coin matched). */
export function noMatches(raw: string, answer: SocialSearchResponse | null, groups: readonly SearchGroup[]): boolean {
  return raw.trim() !== "" && answer !== null && !groups.some((group) => group.id !== "recent" && group.rows.length);
}

/**
 * Whether a typed term matched presales or people but no coin (WS-4): the
 * sheet then says so above the other groups, so an empty coin list is not
 * mistaken for a coin search that never ran. Only once the coins read is in.
 */
export function noCoinMatches(raw: string, coinsRead: boolean, groups: readonly SearchGroup[]): boolean {
  return raw.trim() !== "" && coinsRead
    && !groups.some((group) => group.id === "coins")
    && groups.some((group) => group.id !== "recent" && group.rows.length > 0);
}

/** The no-coin line, with the term printed as the no-match line prints it. */
export function noCoinMatchText(raw: string): string {
  return `No coins match “${raw.trim().toLowerCase()}”.`;
}

/** The no-match line, with the term as the prototype prints it (trimmed, lowercase). */
export function noMatchText(raw: string): string {
  return `No coins, presales or people match “${raw.trim().toLowerCase()}”.`;
}

export function searchEmptyTitle(raw: string, answer: SocialSearchResponse | null, groups: readonly SearchGroup[], coinOnly: boolean): string | null {
  if (coinOnly) return groups.length === 0 ? "No coin matches this type" : null;
  return noMatches(raw, answer, groups) ? noMatchText(raw) : null;
}

/** ArrowDown and ArrowUp move the highlight and wrap; with no rows there is none. */
export function moveHighlight(index: number, key: "ArrowDown" | "ArrowUp", count: number): number {
  if (count === 0) return 0;
  return (index + (key === "ArrowDown" ? 1 : -1) + count) % count;
}

/** Where a picked row goes. */
export function searchHref(row: Extract<SearchRow, { kind: "presale" | "person" }>): string {
  return row.kind === "presale" ? presalePath(row.presale.presale_id) : `/@${row.person.callsign}`;
}

function searchCoinHref(coin: SearchCoin): string | null {
  if (coin.presaleId) return presalePath(coin.presaleId);
  if (coin.coinType && indexedPoolCoin(coin.coinType)) return coinPagePath(coin.coinType);
  return coin.launchId ? coinPagePath(coin.coinType ?? coin.launchId) : null;
}
