import { coinPagePath } from "@blast/core/modules/launchpad-coin/page-key.ts";
import { coinDisplay } from "../coins/coin-display";
import { compactFigure } from "#web/lib/market-format.ts";
import { coreCoin, curatedIdentity } from "@blast/core/modules/social/portfolio/core-coins.ts";
import { atomsGrouped, cents, HIDDEN_AMOUNT, qty, signPct, usd, usd0 } from "@blast/core/web/format.ts";
import type { PortfolioCoinPage, SocialPortfolio } from "@blast/core/web/contracts/portfolio.ts";
import type { SocialPriceHistory } from "@blast/core/web/contracts/prices.ts";

import { SUI_COIN_TYPE, USDC_COIN_TYPE } from "@blast/core/lib/sui/coin-types.ts";
import { presalePath } from "@blast/core/modules/social/items/do-the-same.ts";

import { balanceCoins, goldFigures, moneyParts, type HoldingCoin } from "../profile/profile-model";

export const vestingFeedbackId = (scheduleId: string) => `vesting-feedback-${scheduleId}`;

/**
 * The Portfolio page's view model (R3-74; the gate is
 * `design/blast-trading-home-oa41.html`, sha256 `2a5ea032…`, `viewPortfolio`
 * and its helpers at 8847–8948): pure functions from the routes' answers to
 * the strings the page draws, so every format and every honest absence is
 * tested once.
 *
 * Inputs are the product's own reads and nothing else: the portfolio
 * (`GET /api/social/me/portfolio`), the viewer's presales (`GET
 * /api/social/me/presales`) and R3-20's prices (`GET /api/social/prices`).
 * A figure the reads cannot give is `—` (or, for today's move, no line at
 * all), never a guess.
 */

/** The gate's hidden total. */
export const HIDDEN_TOTAL = "$••••••";

/**
 * The hero's numbers in dollars, null when unknown: the total and the three
 * figures that say where it is — Coins (USDC, SUI and the sale coins held),
 * In presales (`commitments.committed_usd`) and To claim
 * (`commitments.claimable_usd`). The three add up to the total, as the gate's
 * do (`pfValue = committed + claimable + coins`), because the total is
 * `goldFigures`' own sum of the same parts.
 */
export type PortfolioFigures = Readonly<{ total: number | null; coins: number | null; committed: number | null; claimable: number | null }>;

/** The same readiness rule for the Portfolio page, header and Blast mode. */
export function valuationHoldingsReady(portfolio: SocialPortfolio | null): portfolio is SocialPortfolio & {
  balances: NonNullable<SocialPortfolio["balances"]>;
  coins: NonNullable<SocialPortfolio["coins"]>;
  commitments: NonNullable<SocialPortfolio["commitments"]>;
} {
  return Boolean(portfolio && portfolio.balances && portfolio.coins && portfolio.positions && portfolio.commitments &&
    (portfolio.wallet_sync === undefined || portfolio.wallet_sync.status === "ready") &&
    !portfolio.unavailable.some((part) => part === "balances" || part === "coins" || part === "positions"));
}

export function portfolioFigures(portfolio: SocialPortfolio | null): PortfolioFigures {
  const gold = goldFigures(portfolio);
  const tokens = gold.tokens;
  const coins = gold.usdc !== null && gold.sui !== null && tokens !== null ? gold.usdc + gold.sui + tokens : null;
  return { total: valuationHoldingsReady(portfolio) ? gold.total : null, coins, committed: gold.committed, claimable: gold.claimable };
}

/**
 * The hero's figures while the total is incomplete (every holding read, some
 * without a price): each figure's priced part, from the priced rows and the
 * server's known parts beside its null totals (`coin_summary.known_value_usd`,
 * `commitments.known_committed_usd` and `known_claimable_usd`); `total` is
 * their sum, the priced subtotal. Under "Priced subtotal" the tiles and the
 * allocation bar read these, so they add up to it. Null when the total is
 * complete or a holding is unread.
 */
export function pricedFigures(portfolio: SocialPortfolio | null): Readonly<{ total: number; coins: number; committed: number; claimable: number }> | null {
  if (!valuationHoldingsReady(portfolio) || portfolioFigures(portfolio).total !== null) return null;
  const amount = (value: string | number | null | undefined) => Number(value ?? 0);
  const balances = portfolio.balances;
  const sui = balances.sui.atoms === "0" ? 0 : amount(balances.sui.usd_subcent ?? balances.sui.usd);
  const summary = portfolio.coin_summary;
  const tokens = summary ? amount(summary.known_value_usd_exact ?? summary.known_value_usd) : portfolio.coins.reduce(
    (sum, coin) => coin.balance === "0" || coin.value_usd === null ? sum : sum + (Number(coin.value_usd) || amount(coin.value_usd_exact)), 0,
  );
  const coins = Number(balances.usdc.atoms) / 1e6 + sui + tokens;
  const committed = amount(portfolio.commitments.committed_usd_subcent ?? portfolio.commitments.known_committed_usd ?? portfolio.commitments.committed_usd);
  const claimable = amount(portfolio.commitments.claimable_usd_subcent ?? portfolio.commitments.known_claimable_usd ?? portfolio.commitments.claimable_usd);
  const total = coins + committed + claimable;
  const hasPricedCoins = summary?.has_priced_holdings ?? portfolio.coins.some(coin => coin.balance !== "0" && coin.value_usd !== null);
  const hasPricedSui = balances.sui.atoms !== "0" && balances.sui.usd !== null;
  const hasPrices = total > 0 || hasPricedCoins || hasPricedSui || portfolio.commitments.has_priced_holdings;
  return hasPrices ? { total, coins, committed, claimable } : null;
}

/** A priced subtotal is useful only after all holdings are read; it is never the complete total. */
export function portfolioCoverage(portfolio: SocialPortfolio | null): Readonly<{ knownUsd: number }> | null {
  const priced = pricedFigures(portfolio);
  return priced === null ? null : { knownUsd: priced.total };
}


/** A figure's text: whole dollars (to the cent with `precise`, the Portfolio board's), `••••` when hidden, empty when unknown (the gate's `hidden(usd0(v))`). */
export function figureText(value: number | null, hidden: boolean, precise = false): string {
  if (hidden) return HIDDEN_AMOUNT;
  return value === null ? "" : precise ? cents(value) : usd0(value);
}

/** The total as the gate's `money()` draws it: `$4,760` and `.34` at half size; `$••••••` hidden; null when unknown. */
export function totalParts(total: number | null, hidden: boolean): Readonly<{ whole: string; cents: string }> | null {
  if (hidden) return { whole: HIDDEN_TOTAL, cents: "" };
  if (total === null) return null;
  return total > 0 && total < 0.005 ? { whole: "<$0.01", cents: "" } : moneyParts(total);
}

export type PortfolioFigureKey = "coins" | "presales" | "claim";

/** The three categories show their priced value when a complete total is unavailable. */
export function heroFigures(figures: PortfolioFigures, hidden: boolean, precise = false, priced: PortfolioFigures | null = null): readonly Readonly<{ key: PortfolioFigureKey; label: string; value: string }>[] {
  const row = (key: PortfolioFigureKey, label: string, value: number | null, known: number | null | undefined) => {
    if (hidden || value !== null || known == null) return { key, label, value: figureText(value, hidden, precise) };
    return known > 0 ? { key, label, value: figureText(known, false, precise) } : { key, label, value: "No price" };
  };
  const rows = [
    row("coins", "Coins", figures.coins, priced?.coins),
    row("presales", "In presales", figures.committed, priced?.committed),
    row("claim", "To claim", figures.claimable, priced?.claimable),
  ];
  return rows.filter(row => row.value !== "");
}

/**
 * The hero's allocation bar: each figure's share of the total, in the tiles'
 * order, without the empty ones. Nothing unless the three parts are known and
 * add up to a positive total, so a partial valuation never draws a whole;
 * under a priced subtotal the page passes `pricedFigures`, the known split.
 */
export function allocationShares(figures: PortfolioFigures): readonly Readonly<{ key: PortfolioFigureKey; share: number }>[] {
  const { total, coins, committed, claimable } = figures;
  if (total === null || coins === null || committed === null || claimable === null || total <= 0) return [];
  const parts = [{ key: "coins" as const, value: coins }, { key: "presales" as const, value: committed }, { key: "claim" as const, value: claimable }];
  const sum = parts.reduce((all, part) => all + Math.max(0, part.value), 0);
  if (sum <= 0) return [];
  return parts.filter(part => part.value > 0).map(part => ({ key: part.key, share: part.value / sum }));
}

/**
 * "+$224.84 (+4.96%) today" (the gate's `pfChgLine`): the move from the
 * shared today model (`dockToday`, the dock's and the rail's), dollars to the
 * cent with a true minus, then the percentage. Hidden, the gate reads
 * "Hidden today". Null when the move is unknown: the line is omitted.
 */
export function todayChange(
  move: Readonly<{ usd: number; pct: number }> | null,
  hidden: boolean,
  bare = false,
): Readonly<{ text: string; tone: "up" | "down" | null }> | null {
  if (move === null) return null;
  if (hidden) return { text: "Hidden", tone: null };
  const up = move.usd >= 0;
  // `bare`: the sign is the dollars' and the percentage reads without one, as the Portfolio board writes "+$312.40 (2.57%)".
  const pct = bare ? signPct(Math.abs(move.pct)).slice(1) : signPct(move.pct);
  return { text: `${up ? "+" : "−"}${usd(Math.abs(move.usd), 2)} (${pct})`, tone: up ? "up" : "down" };
}

/** A coin row of the holdings card (the gate's `pfCoinRow`). */
export type PortfolioCoinRow = Readonly<{
  coin: HoldingCoin;
  name: string;
  amount: string;
  /** The USD value, or null without a price (then nothing is drawn: the design system omits an unavailable figure, never a dash). */
  value: string | null;
  /** The 24 h move (R3-20), "Cash" for USDC, or null without a 24 h price (then nothing is drawn). */
  change: Readonly<{ text: string; tone: "up" | "down" }> | "cash" | null;
  label: string;
}>;

/** What a coin row asks R3-20's prices for: a sale coin by its sale, SUI by its type; USDC is cash and asks nothing. */
export function priceAskOf(coin: HoldingCoin, suiCoinType: string): Readonly<{ presaleId?: string; coin?: string }> | null {
  if (coin.key === "usdc") return null;
  if (coin.key === "sui") return { coin: suiCoinType };
  return coin.presaleId ? { presaleId: coin.presaleId } : null;
}

/**
 * One coin row: the name (SUI reads "Sui", as the gate's row names it), the
 * amount with its ticker (`860 USDC`, `412.38 SUI`, `600,000 KSTL`), the
 * value in whole dollars and the 24 h move. Hidden, the amount and the value
 * mask and the move stays, as the gate's row does.
 */
export function coinRow(coin: HoldingCoin, price: SocialPriceHistory | null | undefined, hidden: boolean): PortfolioCoinRow {
  const name = coin.key === "sui" ? "Sui" : coin.name;
  const amount = hidden ? HIDDEN_AMOUNT : coinAmount(coin);
  const value = hidden ? HIDDEN_AMOUNT : coin.usd === null ? null : cents(coin.usd);
  const bps = price?.change_24h_bps ?? null;
  const change = coin.key === "usdc" ? ("cash" as const) : bps === null ? null : { text: signPct(bps / 100), tone: bps >= 0 ? ("up" as const) : ("down" as const) };
  const today = change !== null && change !== "cash" ? `, ${change.text} today` : "";
  return { coin, name, amount, value, change, label: `${[name, amount, value ?? "USD value unavailable"].join(", ")}${today}` };
}

function coinAmount(coin: HoldingCoin): string {
  if (coin.quantityText !== undefined) return `${coin.quantityText} ${coin.symbol}`;
  return coin.quantity === null ? "—" : `${qty(coin.quantity)} ${coin.symbol}`;
}

/** Wallet amounts remain exact, including high-precision coins and missing metadata. */
export function walletAmount(atoms: string, decimals: number | null | undefined): string {
  return decimals == null ? `${atomsGrouped(atoms, 0)}\u00a0base units` : atomsGrouped(atoms, decimals);
}

/** Every wallet coin comes from the portfolio; presale information only enriches known tokens. */
export function walletCoins(portfolio: SocialPortfolio | null): HoldingCoin[] {
  if (!portfolio) return [];
  const cash = balanceCoins(goldFigures(portfolio)).filter((coin) => coin.quantity !== 0);
  return [...cash, ...(portfolio.coins ?? []).filter((coin) => coin.balance !== "0").map((coin) => ({
    coinType: coin.coin_type, compactQuantityText: compactFigure(coin.balance, coin.decimals ?? null) ?? undefined,
    key: coin.presale_id ?? coin.coin_type, presaleId: coin.presale_id ?? null,
    ...curatedDisplay(coin), icon: coin.icon_url ?? "", round: !coin.presale_id,
    usd: coin.value_usd === null ? null : Number(coin.value_usd), quantity: null,
    quantityText: walletAmount(coin.balance, coin.decimals), verifiedTeam: coin.verified_team === true,
  }))];
}

function curatedDisplay(coin: Readonly<{ coin_type: string; symbol: string; name?: string | null }>) {
  const { symbol, name } = curatedIdentity(coin.coin_type, coin.symbol, coin.name ?? coin.symbol);
  return coinDisplay(coin.coin_type, symbol, name);
}

/**
 * Where a Coins-tab row goes: a presale token to its presale page, a Blast launch coin
 * (any lifecycle) to its coin page, SUI, USDC and any other tradeable coin to the coin
 * sheet (opened by the row's key, as Search keys it), and an unpriced coin that is not curated (spam) nowhere.
 */
export type CoinRowTarget = Readonly<{ kind: "page"; href: string }> | Readonly<{ kind: "sheet" }> | null;

export function coinRowTarget(coin: HoldingCoin): CoinRowTarget {
  if (coin.presaleId) return { kind: "page", href: presalePath(coin.presaleId) };
  if (coin.launchId) return { kind: "page", href: coinPagePath(coin.coinType ?? coin.launchId) };
  if (coin.key === "sui" || coin.key === "usdc" || coin.usd !== null || coin.category !== undefined) return { kind: "sheet" };
  return null;
}

/** The page already includes cash and has the server's global USD order. */
export function pageCoins(page: PortfolioCoinPage | undefined): HoldingCoin[] {
  return (page?.coins ?? []).map((coin) => {
    const key = coin.coin_type === SUI_COIN_TYPE ? "sui" : coin.coin_type === USDC_COIN_TYPE ? "usdc" : coin.presale_id ?? coin.coin_type;
    return {
      coinType: coin.coin_type, compactQuantityText: compactFigure(coin.balance, coin.decimals ?? null) ?? undefined,
      key, category: coreCoin(coin.coin_type)?.category, presaleId: coin.presale_id ?? null, launchId: coin.launch_id ?? null, ...curatedDisplay(coin),
      icon: coin.icon_url ?? (key === "sui" || key === "usdc" ? `/blast-ui/coins/${key}.svg` : ""), round: !coin.presale_id,
      usd: coin.value_usd === null ? null : Number(coin.value_usd), quantity: null, quantityText: walletAmount(coin.balance, coin.decimals),
      verifiedTeam: coin.verified_team === true,
    };
  });
}
