import type { ReadCache } from "@blast/server/modules/social/read-cache.ts";
import { socialParameter, socialSingle } from "@blast/server/modules/social/route-kit/validation.ts";
import { z } from "zod";
import { assertChainReadThroughViews } from "@blast/core/modules/database/modules.ts";
import type { ReadableDatabase } from "@blast/core/modules/database/transaction.ts";
import { coinLabel } from "@blast/core/modules/social/contracts/financial-wire.ts";
import { SHOWN_PRESALES } from "@blast/core/modules/social/read-model/chain-presales.ts";
import { SocialRouteError } from "@blast/core/modules/social/route-kit/errors.ts";

import { readWalletHoldingsBatch, walletHoldingValue, type WalletHoldings } from "@blast/server/modules/social/portfolio/wallet-holdings.ts";
import type { SocialPnl } from "@blast/core/modules/social/contracts/pnl.ts";

import { HOME_TRADERS_DEFAULT_QUERY, HOME_TRADER_COINS, isHomeWindow, HOME_DEFAULT_WINDOW, type HomeTradersQuery, type HomeKind, type HomeTrader, type HomeTraderCoin, type HomeTraderPortfolio, type HomeTraderHolding, hasPublicPnl, type HomeTradersPage, type HomeWindow } from "@blast/core/modules/social/contracts/home.ts";
import { readAsOf } from "@blast/server/modules/social/items/as-of.ts";
import type { SocialAccountWalletLister } from "@blast/server/modules/social/accounts/me-route.ts";
import { lifetimePnl, pnlAssetIds, readPnlAssets } from "@blast/server/modules/social/portfolio/pnl.ts";
import { participantOf, sideAcross, sideOf } from "@blast/server/modules/social/home/aggregate.ts";
import { readPeople, type HomeReadContext } from "@blast/server/modules/social/home/coins.ts";
import { Params, ROW_ORDER, SIDES_GROUP, sidesSelect, homeSpan, readHomeBounds, rowsWithSql, selectHome, visibleKinds, type GroupedRow, type SideRow } from "@blast/server/modules/social/home/sql.ts";
import { readPnlLedger } from "@blast/server/modules/social/portfolio/pnl-ledger.ts";

/** Global public PnL since launch; the activity window only scopes each visible row's details. */

/** The traders read's context: the page's, plus the profile's ledger (the primary) and wallet lister. */
export type HomeTradersContext = HomeReadContext & Readonly<{ portfolios: TraderLedger }>;

type TraderRow = GroupedRow & Readonly<{ coins_total: number }>;
/** The accounts that share a portfolio (opted in, not private). */
const PUBLIC_PORTFOLIOS_SQL = `SELECT a.account_id::text AS account_id FROM social_accounts a
  WHERE a.account_id = ANY($1::uuid[]) AND a.portfolio_public AND a.privacy <> 'private'`;

export type TraderPortfolioRead = HomeTraderPortfolio & Readonly<{ holdings?: readonly HomeTraderHolding[] }>;
const PRIVATE: TraderPortfolioRead = Object.freeze({ public: false, value_usd: null, pnl_usd: null });

/**
 * What the profile's PnL since launch reads, for the traders section: the
 * indexed history of Blast-launched coins across all venues for every
 * linked wallet. One rule on every surface.
 */
export type TraderLedger = Readonly<{ db: ReadableDatabase; wallets: SocialAccountWalletLister; cache?: ReadCache<ReadonlyMap<string, TraderPortfolioRead>> }>;

/** Signed displayed cents, kept exact for ordering and shares. */
function centsOf(value: string): bigint {
  const negative = value.startsWith("-");
  const [whole, fraction = ""] = (negative ? value.slice(1) : value).split(".");
  const cents = BigInt(whole!) * 100n + BigInt(fraction.padEnd(2, "0").slice(0, 2));
  return negative ? -cents : cents;
}

/**
 * Only complete public P&L participates in the homepage leaderboard, and only
 * for a trader who has traded: a $0 PnL with no coin held is left out.
 */
export function rankTraders(traders: readonly HomeTrader[]): readonly HomeTrader[] {
  const traded = (trader: HomeTrader) => centsOf(trader.portfolio.pnl_usd!) !== 0n || Boolean(trader.holdings?.length);
  const ranked = traders.filter((trader) => hasPublicPnl(trader) && traded(trader)).sort((a, b) => {
    const delta = centsOf(b.portfolio.pnl_usd!) - centsOf(a.portfolio.pnl_usd!);
    return delta < 0n ? -1 : delta > 0n ? 1 : a.key.localeCompare(b.key);
  });
  let rank = 1;
  return ranked.map((trader, index) => {
    if (index > 0 && centsOf(trader.portfolio.pnl_usd!) !== centsOf(ranked[index - 1]!.portfolio.pnl_usd!)) rank = index + 1;
    return { ...trader, rank };
  });
}

/** Wallet balances and asset P&L come from the same reads used by profiles. */
export function traderHoldingsOf(wallet: WalletHoldings, pnl: SocialPnl, nowMs: number): readonly HomeTraderHolding[] | undefined {
  const holdings = wallet.holdings.filter((holding) => (holding.presale_id !== null || holding.launch_id !== undefined) && BigInt(holding.balance) > 0n);
  if (wallet.sync.status !== "ready" || holdings.some((holding) => holding.decimals === null)) return undefined;
  const total = sumUsd(holdings.map((holding) => walletHoldingValue(holding, nowMs)));
  const pnlByCoin = new Map(pnl.assets.map((asset) => [asset.coin_type, asset.unrealized_usd]));
  return holdings.map((holding) => {
    const value = walletHoldingValue(holding, nowMs);
    return { coin_type: holding.coin_type, presale_id: holding.presale_id, ...(holding.launch_id ? { launch_id: holding.launch_id } : {}), symbol: holding.symbol, icon_url: holding.icon_url, ...(holding.verified_team === true ? { verified_team: true } : {}), decimals: holding.decimals!,
      balance: holding.balance, value_usd: value,
      share_bps: value !== null && total !== null && centsOf(total) > 0n ? Number(centsOf(value) * 10_000n / centsOf(total)) : null,
      pnl_usd: pnlByCoin.get(holding.coin_type) ?? null };
  }).sort((a, b) => {
    if (a.value_usd === null || b.value_usd === null) return a.value_usd === b.value_usd ? (a.launch_id ?? a.presale_id!).localeCompare(b.launch_id ?? b.presale_id!) : a.value_usd === null ? 1 : -1;
    const delta = centsOf(b.value_usd) - centsOf(a.value_usd);
    return delta < 0n ? -1 : delta > 0n ? 1 : (a.launch_id ?? a.presale_id!).localeCompare(b.launch_id ?? b.presale_id!);
  });
}

/** Added displayed cents, exact; null once any part is unknown. */
function sumUsd(values: readonly (string | null)[]): string | null {
  let cents = 0n;
  for (const value of values) {
    if (value === null) return null;
    const negative = value.startsWith("-");
    const [whole, fraction = ""] = (negative ? value.slice(1) : value).split(".");
    const part = BigInt(whole!) * 100n + BigInt(fraction.padEnd(2, "0").slice(0, 2));
    cents += negative ? -part : part;
  }
  const magnitude = cents < 0n ? -cents : cents;
  return `${cents < 0n ? "-" : ""}${magnitude / 100n}.${(magnitude % 100n).toString().padStart(2, "0")}`;
}

/**
 * One account's portfolio: the value of its sale coins held now at fresh
 * prices (null where any is stale or unpriced), and the profile's PnL since launch
 * total, realised plus unrealised by the one cost-basis rule, null
 * where the profile says unknown.
 */
export function traderPortfolioOf(wallet: WalletHoldings, pnl: SocialPnl, nowMs: number): HomeTraderPortfolio {
  const value = sumUsd(wallet.holdings.filter((holding) => (holding.presale_id !== null || holding.launch_id !== undefined)).map((holding) => walletHoldingValue(holding, nowMs)));
  return { public: true, value_usd: value, pnl_usd: pnl.totals.total_usd };
}

/**
 * The portfolios of the accounts that share them (the others read private):
 * each account's wallets by kind, its indexed ledger and its holdings (the
 * profile's own reads), the named sales' identities in one statement, and
 * the profile's accounting (`lifetimePnl`) per account.
 */
export async function readTraderPortfolios(db: ReadableDatabase, ledger: TraderLedger, accountIds: readonly string[], nowMs: number): Promise<ReadonlyMap<string, TraderPortfolioRead>> {
  const answer = new Map<string, TraderPortfolioRead>(accountIds.map((id) => [id, PRIVATE]));
  if (accountIds.length === 0) return answer;
  const shared = (await ledger.db.read<{ account_id: string }>(PUBLIC_PORTFOLIOS_SQL, [[...new Set(accountIds)]])).rows.map((row) => row.account_id);
  if (shared.length === 0) return answer;
  const load = () => calculateTraderPortfolios(db, ledger, shared, nowMs);
  // Visibility is checked on the primary on EVERY request, before cache reuse.
  // Only financial calculations are reused; identities/ranks are read afresh.
  const values = ledger.cache ? await ledger.cache.read(JSON.stringify([...shared].sort()), load) : await load();
  for (const id of shared) answer.set(id, values.get(id)!);
  return answer;
}

async function calculateTraderPortfolios(db: ReadableDatabase, ledger: TraderLedger, shared: readonly string[], nowMs: number): Promise<ReadonlyMap<string, TraderPortfolioRead>> {
  const answer = new Map<string, TraderPortfolioRead>();
  // Release each batch's historical rows before reading the next. The old path
  // retained all 100 ledgers, even though only the computed figures are returned.
  for (let offset = 0; offset < shared.length; offset += 4) {
    const batch = shared.slice(offset, offset + 4);
    const walletsByAccount = ledger.wallets.walletsForAccounts ? await ledger.wallets.walletsForAccounts(batch) : null;
    const wallets = new Map(await Promise.all(batch.map(async (id) =>
      [id, walletsByAccount?.get(id) ?? await ledger.wallets.wallets(id)] as const)));
    const [ledgers, holdings] = await Promise.all([
      Promise.all(batch.map(async (id) => ({ id, rows: await readPnlLedger(ledger.db, wallets.get(id)!.map((wallet) => wallet.address)) }))),
      readWalletHoldingsBatch(db, new Map([...wallets].map(([id, items]) => [id, items.map((wallet) => wallet.address)]))),
    ]);
    const assets = await readPnlAssets(db, [...new Set(ledgers.flatMap((read) => pnlAssetIds(read.rows)))]);
    const assetsByLaunch = new Map(assets.map((asset) => [asset.launch_id ?? asset.presale_id, asset]));
    for (const read of ledgers) {
      const ownAssets = pnlAssetIds(read.rows).flatMap((id) => {
        const asset = assetsByLaunch.get(id);
        return asset ? [asset] : [];
      });
      const wallet = holdings.get(read.id)!;
      const pnl = lifetimePnl(read.rows, wallet, ownAssets, nowMs);
      answer.set(read.id, { ...traderPortfolioOf(wallet, pnl, nowMs), holdings: traderHoldingsOf(wallet, pnl, nowMs) });
    }
  }
  return answer;
}

type CoinRow = Readonly<{ presale_id: string; coin_type: string; symbol: string; icon_url: string | null; decimals: number }>;

const KINDS: readonly HomeKind[] = ["trade_buy", "trade_sell", "presale_commit", "presale_claim"];

/** The trader's coins from its side rows: one per sale, the directions kept apart, newest first. */
export function traderCoinsOf(sides: readonly SideRow[], facts: ReadonlyMap<string, CoinRow>): readonly HomeTraderCoin[] {
  const bySale = new Map<string, SideRow[]>();
  for (const row of sides) bySale.set(row.sale, [...(bySale.get(row.sale) ?? []), row]);
  return [...bySale]
    .flatMap(([sale, rows]) => {
      const coin = facts.get(sale);
      if (!coin) return [];
      const kind = (name: HomeKind) => sideOf(rows.filter((row) => row.kind === name));
      return [{
        presale_id: sale,
        symbol: coinLabel({ coinType: coin.coin_type, symbol: coin.symbol, name: null }).symbol,
        icon_url: coin.icon_url || null,
        decimals: coin.decimals,
        buys: kind("trade_buy"),
        sells: kind("trade_sell"),
        commits: kind("presale_commit"),
        claims: kind("presale_claim"),
        latest_ms: Math.max(...rows.map((row) => Number(row.latest_ms))),
      }];
    })
    .sort((a, b) => b.latest_ms - a.latest_ms || (a.presale_id < b.presale_id ? -1 : 1));
}

/** Validated server pagination and literal, case-insensitive identity/wallet search. */
export function parseTradersQuery(params: URLSearchParams): HomeTradersQuery & { window: HomeWindow } {
  for (const key of ["window", "search", "page", "limit"]) {
    socialSingle(params, key);
  }
  const window = params.get("window") ?? HOME_DEFAULT_WINDOW;
  const search = (params.get("search") ?? "").trim();
  const page = params.get("page") ?? "1";
  const limit = params.get("limit") ?? String(HOME_TRADERS_DEFAULT_QUERY.limit);
  if (!isHomeWindow(window)) throw new SocialRouteError("invalid_parameter", { extra: { parameter: "window" } });
  socialParameter(z.string().max(128), search, "search");
  socialParameter(z.string().regex(/^[1-9][0-9]*$/).transform(Number).pipe(z.number().int()), page, "page");
  socialParameter(z.string().regex(/^[1-9][0-9]*$/).transform(Number).pipe(z.number().max(50)), limit, "limit");
  return { window, search, page: Number(page), limit: Number(limit) };
}

export async function readHomeTraders(db: ReadableDatabase, window: HomeWindow, context: HomeTradersContext, query: HomeTradersQuery = HOME_TRADERS_DEFAULT_QUERY): Promise<HomeTradersPage> {
  const [bounds, asOf, accounts] = await Promise.all([
    readHomeBounds(db, context.nowMs),
    readAsOf(db),
    context.portfolios.db.read<{ account_id: string }>(`SELECT a.account_id::text AS account_id
      FROM social_accounts a JOIN social_account_identities i USING (account_id)
      WHERE a.portfolio_public AND a.privacy = 'public' AND a.sharing_since IS NOT NULL AND i.callsign IS NOT NULL
      ORDER BY a.account_id`),
  ]);
  if (!asOf) throw new SocialRouteError("service_unavailable");
  const accountIds = accounts.rows.map((row) => row.account_id);
  const [people, portfolios] = await Promise.all([
    readPeople(context.portfolios.db, accountIds),
    readTraderPortfolios(db, context.portfolios, accountIds, context.nowMs),
  ]);
  const accountByKey = new Map<string, string>();
  const candidates: HomeTrader[] = accountIds.flatMap((id) => {
    const base = participantOf({ grouped: { sale: "", who: `c:${id}`, account_id: id, wallet: "", events_total: "0", latest_ms: "0", latest_kind: "trade_buy" }, sides: [], ...people });
    if (base.actor.type !== "account") return [];
    accountByKey.set(base.key, id);
    const portfolio = portfolios.get(id) ?? PRIVATE;
    return [{ ...base, holdings_public: portfolio.public, performance_public: portfolio.public,
      holdings: portfolio.public ? portfolio.holdings?.slice(0, 10) : undefined,
      holdings_total: portfolio.public ? portfolio.holdings?.length : undefined,
      portfolio: { public: portfolio.public, value_usd: portfolio.value_usd, pnl_usd: portfolio.pnl_usd }, coins: [], coins_total: 0 }];
  });
  const ranked = rankTraders(candidates);
  let matches = ranked;
  if (query.search) {
    const term = query.search.toLowerCase();
    const handle = term.replace(/^@/, "");
    const wallets = await context.portfolios.db.read<{ account_id: string }>(`SELECT DISTINCT account_id::text AS account_id
      FROM social_wallet_owners WHERE account_id = ANY($1::uuid[]) AND strpos(lower(address), $2) > 0`, [accountIds, term]);
    const walletMatches = new Set(wallets.rows.map((row) => row.account_id));
    matches = ranked.filter((trader) => trader.actor.type === "account" && (
      trader.actor.display_name?.toLowerCase().includes(term) || trader.actor.callsign.toLowerCase().includes(handle) ||
      trader.actor.x_handle?.toLowerCase().includes(handle) || walletMatches.has(accountByKey.get(trader.key)!)
    ));
  }
  const total = matches.length;
  const page = Math.min(query.page, Math.max(1, Math.ceil(total / query.limit)));
  const metadata = { ...query, page, total, global_total: ranked.length, window, clock_ms: bounds.clockMs, as_of: asOf };
  const selected = matches.slice((page - 1) * query.limit, page * query.limit);
  if (selected.length === 0) return { ...metadata, traders: [] };

  const span = homeSpan(window, bounds);
  const request = { span, bounds, kinds: visibleKinds(context.hiddenKinds), sales: { kind: "all" } as const, actors: { kind: "everyone" } as const };
  const grouped = new Params();
  const selectedIds = grouped.add(selected.map((trader) => accountByKey.get(trader.key)!));
  const groupedText = selectHome(rowsWithSql(request, grouped), `SELECT '' AS sale, w.who, w.account_id::text AS account_id, min(w.actor) AS wallet, count(*)::text AS events_total,
      max(w.timestamp_ms)::text AS latest_ms, (array_agg(w.kind ORDER BY ${ROW_ORDER("w")}))[1] AS latest_kind,
      count(DISTINCT w.sale)::int AS coins_total
    FROM home_who w WHERE w.account_id = ANY(${selectedIds}::uuid[])
    GROUP BY w.who, w.account_id`);
  assertChainReadThroughViews(groupedText);
  const activity = (await db.read<TraderRow>(groupedText, grouped.values)).rows;
  const activityByAccount = new Map(activity.map((row) => [row.account_id, row]));
  const whoByKey = new Map(selected.map((trader) => [trader.key, activityByAccount.get(accountByKey.get(trader.key)!)?.who ?? `c:${accountByKey.get(trader.key)!}`]));
  const sides = new Params();
  const whos = sides.add(selected.map((trader) => whoByKey.get(trader.key)!));
  const sidesText = selectHome(rowsWithSql(request, sides), `${sidesSelect()} WHERE w.who = ANY(${whos}::text[]) ${SIDES_GROUP}`);
  assertChainReadThroughViews(sidesText);
  const sideRows = (await db.read<SideRow>(sidesText, sides.values)).rows;
  const sidesByWho = new Map<string, SideRow[]>();
  for (const side of sideRows) {
    const rows = sidesByWho.get(side.who);
    if (rows) rows.push(side);
    else sidesByWho.set(side.who, [side]);
  }
  const saleIds = [...new Set(sideRows.map((row) => row.sale))];
  const coins = saleIds.length === 0 ? [] : (await db.read<CoinRow>(
    `SELECT p.presale_id, p.sale_token AS coin_type, p.sale_symbol AS symbol, p.sale_icon_url AS icon_url, p.sale_decimals::int AS decimals FROM ${SHOWN_PRESALES} p WHERE p.presale_id = ANY($1::text[])`,
    [saleIds],
  )).rows;
  const facts = new Map(coins.map((row) => [row.presale_id, row]));
  const list = selected.map((trader) => {
    const grouped = activityByAccount.get(accountByKey.get(trader.key)!);
    const mine = sidesByWho.get(whoByKey.get(trader.key)!) ?? [];
    const across = (kind: HomeKind) => sideAcross(mine.filter((side) => side.kind === kind));
    const [buys, sells, commits, claims] = KINDS.map(across);
    return { ...trader, ...(grouped ? { latest_ms: Number(grouped.latest_ms), latest_kind: grouped.latest_kind as HomeKind, events_total: Number(grouped.events_total), coins_total: grouped.coins_total } : {}), buys: buys!, sells: sells!, commits: commits!, claims: claims!,
      coins: traderCoinsOf(mine, facts).slice(0, HOME_TRADER_COINS) };
  });
  return { ...metadata, traders: list };
}
