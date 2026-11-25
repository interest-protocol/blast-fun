import { DISPLAY_PRICES } from "@blast/core/modules/social/prices/test-sui.ts";
import { verifiedTeamSql } from "@blast/server/modules/social/read-model/verified-team.ts";
import { socialParameter } from "@blast/server/modules/social/route-kit/validation.ts";
import { z } from "zod";
import { compareEventCursors } from "@blast/core/modules/launchpad-contract/cursor.ts";
import { assertChainReadThroughViews } from "@blast/core/modules/database/modules.ts";
import type { ReadableDatabase } from "@blast/core/modules/database/transaction.ts";
import { coinLabel } from "@blast/core/modules/social/contracts/financial-wire.ts";
import type { PresaleTermsReader } from "@blast/core/modules/presale/terms/index.ts";
import { blastV1Coin } from "@blast/core/modules/social/portfolio/core-coins.ts";
import { namedWalletsSql } from "@blast/core/modules/social/read-model/naming.ts";
import { SocialRouteError } from "@blast/core/modules/social/route-kit/errors.ts";

import {
  HOME_COINS_MAX_IDS,
  HOME_PREVIEW_ROWS,
  HOME_RECENT_BUY_MS,
  HOME_SPARK_POINTS,
  HOME_TOP_HOLDERS,
  HOME_WINDOW_MS,
  HOME_MAX_HOLDERS,
  type HomeActivity,
  type HomeTopHolders,
  type HomeCoin,
  type HomeCoinsByIds,
  type HomeCoinsPage,
  type HomeDexVolume,
  type HomeParticipant,
  type HomeQuery,
  type HomeRecentBuy,
  type HomeWindow,
} from "@blast/core/modules/social/contracts/home.ts";
import { tradesInApp } from "@blast/core/modules/social/contracts/trades.ts";
import { readAsOf } from "@blast/server/modules/social/items/as-of.ts";
import { changeBps } from "@blast/core/modules/social/prices/change.ts";
import { readPriceHistories } from "@blast/server/modules/social/prices/history.ts";
import { latestWindowPriceSql, rollingPriceAtSql } from "@blast/server/modules/social/prices/price-at.ts";
import { PRICE_TIER_SPAN_MS, type PricePoint } from "@blast/core/modules/social/contracts/prices.ts";
import type { readTrackedPoolMarket, TrackedPoolMarket } from "@blast/server/modules/launchpad-market/legacy-fdv.ts";
import { optionalSource } from "@blast/server/modules/social/optional-source.ts";
import type { CurveTargets } from "@blast/server/modules/social/home/curve-targets.ts";
import {
  activityOf,
  actorOf,
  countsOf,
  participantOf,
  previewOf,
  quoteAssetOf,
  shareBps,
  totalsOf,
  type IdentityRow,
  type WindowCountsRow,
} from "@blast/server/modules/social/home/aggregate.ts";
import { readDexVolumes } from "@blast/server/modules/social/home/dex-volume.ts";
import { fdvOf, outstandingSaleTokensSql, presaleTotalSupply, readSupplies, supplyOf } from "@blast/server/modules/social/home/fdv.ts";
import { decodeHomeCursor, HOME_DUST_USD, pageOf, passesFilters, rankInputs, relevanceScore, whyShown, type Rankable, type TradeCoverage } from "@blast/server/modules/social/home/rank.ts";
import {
  GROUPED_GROUP,
  GROUPED_SELECT,
  Params,
  SIDES_GROUP,
  sidesSelect,
  homeSpan,
  readHomeBounds,
  rowsWithSql,
  scopedHomeCoinsSql,
  selectHome,
  visibleKinds,
  whySalesSql,
  type ActorScope,
  type GroupedRow,
  type HomeBounds,
  type HomeSpan,
  type RowsRequest,
  type SaleScope,
  type SideRow,
} from "@blast/server/modules/social/home/sql.ts";
import { COIN_TYPE, SUI_OBJECT_ID_PATTERN } from "@blast/core/lib/sui/ids.ts";

type TrackedMarkets = Awaited<ReturnType<typeof readTrackedPoolMarket>>;

/**
 * The coin items of Home (contract in `contracts/home.ts`): Discover's page
 * over every trading coin, and the same items by id for the Watchlist.
 *
 * Statements, none growing with the number of accounts or with history:
 *
 * 1. the watermark's bounds and `as_of`;
 * 2. the candidates' facts: every shown trading coin, the price
 *    now and at the 24 h cutoff (indexed reads with a fallback for sparse history), the
 *    latest holder count (`coin_holder_history` by key) and its lifecycle
 *    times;
 * 3. the window's sums per (sale, identity, kind, quote asset) over the
 *    window's activity rows (`sql.ts`), from which the counts and the totals
 *    of every coin follow without a second scan;
 * 4. for the page's coins only: the newest participants per coin (the
 *    preview), the biggest holders now (`coin_balances`, an account's
 *    wallets as one, the sale's and pools' addresses left out), their
 *    identities and their follower counts, the active whys on each sale
 *    (`whySalesSql`), and the sales' terms for FDV and the holders' shares
 *    (the terms reader, cached).
 *
 * Ranking and paging happen in memory over the bounded candidate set
 * (`rank.ts`): candidate selection, filters, order and the keyset cursor all
 * see the whole universe, never one fetched page.
 */

export type FactsRow = Readonly<{
  presale_id: string | null;
  coin_type: string;
  symbol: string;
  name: string;
  icon_url: string | null;
  verified_team: boolean;
  tracked_pool_only: boolean;
  sale_decimals: number;
  lifecycle: string;
  venue: string;
  pool_id: string | null;
  quote_type: string;
  quote_symbol: string;
  quote_decimals: number;
  start_ms: string;
  end_ms: string;
  raise_target: string;
  raised: string;
  participants: string;
  opened_ms: string | null;
  /** When it started trading: a sale's migration, a curve coin's launch. */
  launched_ms: string | null;
  /** A curve coin's launch (its curve pool); null for a sale. */
  launch_id: string | null;
  /** A curve coin's live supply in atoms; a sale's comes from its terms. */
  supply: string | null;
  /** The indexed currency's total supply in atoms. */
  total_supply: string | null;
  price_usd: string | null;
  price_as_of_ms: string | null;
  price_checkpoint: string | null;
  price_24h_usd: string | null;
  open_24h_as_of_ms: string | null;
  change_24h_from_ms: string | null;
  holders: string | null;
  holders_as_of_ms: string | null;
  /** USD per whole quote coin now, to value a sale's raise or a curve's target. */
  quote_price_usd: string | null;
  /** A sale's tokens still held in vesting, in atoms; outside its market cap. */
  escrowed: string | null;
}>;

type HomePriceOptions = Pick<HomeReadContext, "includeLiveInputs" | "includeRollingChange">;

/** $1 clock (the 24 h move's end), then the scope's own parameters. */
function factsSql(scope: SaleScope, params: Params, options: HomePriceOptions = {}): string {
  const clock = `${params.add(0)}::bigint`;
  const cutoff = `${clock} - ${HOME_WINDOW_MS["24h"]}`;
  const source = scopedHomeCoinsSql(scope, params);
  const shorter = options.includeRollingChange ? clock : undefined;
  const projectedAt = `CASE WHEN pr.usd_price IS NOT NULL AND pr.as_of_ms <= ${clock}
    THEN greatest(${cutoff}, pr.as_of_ms) ELSE ${cutoff} END`;
  const lastPrice = options.includeRollingChange ? `LEFT JOIN LATERAL (
    SELECT last.usd_price, last.as_of_ms
    FROM LATERAL (
      SELECT 1 WHERE p.lifecycle = 'migrated' AND (${projectedAt}) < ${clock}
      OFFSET 0
    ) needs_fallback
    CROSS JOIN LATERAL (${latestWindowPriceSql("p.sale_token", projectedAt, clock)}) last
  ) last_24h ON TRUE` : "";
  const price = options.includeRollingChange ? "coalesce(last_24h.usd_price, pr.usd_price)" : "pr.usd_price";
  const priceTime = options.includeRollingChange ? "coalesce(last_24h.as_of_ms, pr.as_of_ms)" : "pr.as_of_ms";
  return `SELECT p.presale_id, p.sale_token AS coin_type, p.sale_symbol AS symbol, p.sale_name AS name, p.sale_icon_url AS icon_url,
    ${verifiedTeamSql("p.presale_id", "p.sale_token")} AS verified_team, p.tracked_pool_only,
    p.sale_decimals::int AS sale_decimals, p.lifecycle, p.venue, p.pool_id, p.quote_type, p.quote_symbol, p.quote_decimals::int AS quote_decimals,
    p.start_ms::text AS start_ms, p.end_ms::text AS end_ms, p.raise_target::text AS raise_target, p.total_commitments::text AS raised,
    p.participants::text AS participants,
    lc.opened_ms::text AS opened_ms, coalesce(lc.migrated_ms, lp.created_at_ms)::text AS launched_ms,
    lp.pool_id AS launch_id, cs.supply::text AS supply, coalesce(cs.total_supply, ps.total_supply)::text AS total_supply,
    trim_scale(${price})::text AS price_usd, (${priceTime})::text AS price_as_of_ms,
    ${options.includeLiveInputs ? "(SELECT market_checkpoint::text FROM chain_read_v1.watermark)" : "NULL::text"} AS price_checkpoint,
    trim_scale(open_24h.usd_price)::text AS price_24h_usd, open_24h.as_of_ms::text AS open_24h_as_of_ms,
    CASE WHEN open_24h.as_of_ms > ${cutoff} THEN open_24h.as_of_ms::text END AS change_24h_from_ms,
    h.holders::text AS holders, h.timestamp_ms::text AS holders_as_of_ms,
    trim_scale(qp.usd_price)::text AS quote_price_usd,
    CASE WHEN p.presale_id IS NOT NULL THEN (${outstandingSaleTokensSql("p.presale_id")}) END AS escrowed
  FROM ${source} p
  LEFT JOIN LATERAL (
    SELECT max(l.timestamp_ms) FILTER (WHERE l.state = 'opened') AS opened_ms,
      max(l.timestamp_ms) FILTER (WHERE l.state = 'migrated') AS migrated_ms
    FROM chain_read_v1.presale_lifecycle l WHERE l.presale_id = p.presale_id
  ) lc ON TRUE
  LEFT JOIN chain_read_v1.pools lp ON p.presale_id IS NULL AND lp.coin_type = p.sale_token AND lp.venue = 'blast_curve'
  LEFT JOIN chain_read_v1.coins cs ON p.presale_id IS NULL AND cs.coin_type = p.sale_token
  LEFT JOIN chain_read_v1.presale_coin_supply ps ON p.presale_id IS NOT NULL AND ps.coin_type = p.sale_token
  LEFT JOIN ${DISPLAY_PRICES} pr ON pr.coin_type = p.sale_token
  LEFT JOIN ${DISPLAY_PRICES} qp ON qp.coin_type = p.quote_type
  LEFT JOIN LATERAL (${rollingPriceAtSql("p.sale_token", cutoff, shorter)}) open_24h ON TRUE
  ${lastPrice}
  LEFT JOIN LATERAL (
    SELECT ch.holders, ch.timestamp_ms FROM chain_read_v1.coin_holder_history ch
    WHERE ch.coin_type = p.sale_token ORDER BY ch.checkpoint DESC LIMIT 1
  ) h ON TRUE`;
}

assertChainReadThroughViews(factsSql({ kind: "discover" }, new Params(), {
  includeLiveInputs: true,
  includeRollingChange: true,
}));

/** The facts of every sale in `scope`, keyed by presale id. */
export async function readCoinFacts(db: ReadableDatabase, scope: SaleScope, clockMs: number, options: HomePriceOptions = {}): Promise<ReadonlyMap<string, FactsRow>> {
  if (scope.kind === "ids" && scope.presaleIds.length === 0) return new Map();
  const params = new Params();
  const text = factsSql(scope, params, options);
  params.values[0] = clockMs;
  const { rows } = await db.read<FactsRow>(text, params.values);
  return new Map(rows.map((row) => [row.presale_id ?? row.coin_type, row]));
}

/** The window's sums per (sale, identity, kind, quote asset). */
export async function readSides(db: ReadableDatabase, request: RowsRequest, recentBuyFromMs?: number): Promise<readonly SideRow[]> {
  if (request.sales.kind === "ids" && request.sales.presaleIds.length === 0) return [];
  const params = new Params();
  const rows = rowsWithSql(request, params);
  // Keep one event's fields together, ordered by timestamp and cursor, in the existing aggregate.
  const recentBuy = recentBuyFromMs === undefined ? "" : `,
    (max(ARRAY[w.timestamp_ms, w.checkpoint, w.tx_slot, w.event_slot, w.part, w.quote_amount]::numeric[])
      FILTER (WHERE w.kind = 'trade_buy' AND w.timestamp_ms > ${params.add(recentBuyFromMs)}::bigint
        AND w.quote_amount > 0))::text[] AS recent_buy`;
  const text = selectHome(rows, `${sidesSelect(recentBuy)} ${SIDES_GROUP}`);
  assertChainReadThroughViews(text);
  return (await db.read<SideRow>(text, params.values)).rows;
}

/** The newest `perSale` participants of each sale in the request's scope. */
export async function readTopParticipants(db: ReadableDatabase, request: RowsRequest, perSale: number): Promise<readonly GroupedRow[]> {
  if (request.sales.kind === "ids" && request.sales.presaleIds.length === 0) return [];
  const params = new Params();
  const limit = params.add(perSale);
  const text = selectHome(`${rowsWithSql(request, params)},
  home_grouped AS (${GROUPED_SELECT} ${GROUPED_GROUP})`, `SELECT ranked.sale, ranked.who, ranked.account_id, ranked.wallet, ranked.events_total, ranked.latest_ms, ranked.latest_kind
  FROM (SELECT g.*, row_number() OVER (PARTITION BY g.sale ORDER BY g.latest_ms::bigint DESC, g.who) AS rn FROM home_grouped g) ranked
  WHERE ranked.rn <= ${limit}::int`);
  assertChainReadThroughViews(text);
  return (await db.read<GroupedRow>(text, params.values)).rows;
}

const IDENTITIES_SQL = `SELECT account_id, callsign, display_name, avatar_url, x_handle, verified
  FROM social_account_identities WHERE account_id = ANY($1::uuid[])`;

/** Public followers only, the profile page's rule (`profiles/connections.ts`), so both show one number. */
const FOLLOWERS_SQL = `SELECT f.target_id AS account_id, count(*)::int AS followers
  FROM social_follows f JOIN social_accounts a ON a.account_id = f.follower_account_id AND a.privacy = 'public'
  WHERE f.target_kind = 'account' AND f.target_id = ANY($1::text[]) GROUP BY f.target_id`;

/** $1 sale ids: the active whys per sale (a why on an unstamped trade counts for the sale whose coin it names). */
const POSTS_SQL = `SELECT x.sale, count(*)::int AS posts
  FROM (${whySalesSql("(w.presale_id = ANY($1::text[]) OR w.presale_id IS NULL)")}) x
  WHERE x.sale = ANY($1::text[]) GROUP BY x.sale`;
assertChainReadThroughViews(POSTS_SQL);

/** The active whys of each sale, keyed by sale (absent means none). */
export async function readDiscussionCounts(db: ReadableDatabase, presaleIds: readonly string[]): Promise<ReadonlyMap<string, number>> {
  if (presaleIds.length === 0) return new Map();
  const { rows } = await db.read<{ sale: string; posts: number }>(POSTS_SQL, [[...new Set(presaleIds)]]);
  return new Map(rows.map((row) => [row.sale, row.posts]));
}

export type HolderRow = Readonly<{ coin_type: string; who: string; account_id: string | null; wallet: string; balance: string }>;

/**
 * The biggest holders of each coin now, from `chain_read_v1.coin_balances`:
 * an account's wallets summed into one holder (the naming rule as of now),
 * an unnamed wallet its own; the sale's own object, its pool and any pool
 * address left out (they hold the supply, not a position), and `0x0`, whose
 * burned balance the view lists but the live supply already subtracts. $1
 * coin types, $2 the addresses left out, $3 the clock, $4 holders per coin.
 */
const TOP_HOLDERS_SQL = `WITH home_named AS (${namedWalletsSql()}),
  home_holders AS (
    SELECT cb.coin_type,
      CASE WHEN n.account_id IS NULL THEN 'w:' || cb.owner ELSE 'a:' || n.account_id::text END AS who,
      n.account_id::text AS account_id, min(cb.owner) AS wallet, sum(cb.balance) AS balance
    FROM chain_read_v1.coin_balances cb
    LEFT JOIN home_named n ON n.address = cb.owner AND n.named_from_ms <= $3::bigint
    WHERE cb.coin_type = ANY($1::text[]) AND cb.balance > 0 AND NOT (cb.owner = ANY($2::text[]))
      AND cb.owner <> ('0x' || repeat('0', 64))
      AND NOT EXISTS (SELECT 1 FROM chain_read_v1.pools pl WHERE pl.pool_key = cb.owner)
    GROUP BY cb.coin_type, 2, n.account_id
  )
  SELECT ranked.coin_type, ranked.who, ranked.account_id, ranked.wallet, ranked.balance::text AS balance
  FROM (SELECT h.*, row_number() OVER (PARTITION BY h.coin_type ORDER BY h.balance DESC, h.who) AS rn FROM home_holders h) ranked
  WHERE ranked.rn <= $4::int
  ORDER BY ranked.coin_type, ranked.rn`;
assertChainReadThroughViews(TOP_HOLDERS_SQL);

/** The top holders of the trading coins in `facts`, keyed by coin type. */
export async function readTopHolders(db: ReadableDatabase, facts: readonly Pick<FactsRow, "presale_id" | "pool_id" | "launch_id" | "coin_type">[], clockMs: number, limit = HOME_TOP_HOLDERS): Promise<ReadonlyMap<string, readonly HolderRow[]>> {
  if (facts.length === 0) return new Map();
  const excluded = [...new Set(facts.flatMap((row) => [row.presale_id, row.pool_id, row.launch_id].filter((id): id is string => typeof id === "string")))];
  const { rows } = await db.read<HolderRow>(`SELECT home_result.* FROM (${TOP_HOLDERS_SQL}) AS home_result`, [facts.map((row) => row.coin_type), excluded, clockMs, limit]);
  const byCoin = new Map<string, HolderRow[]>();
  for (const row of rows) byCoin.set(row.coin_type, [...(byCoin.get(row.coin_type) ?? []), row]);
  return byCoin;
}

/** The holders as the item carries them: named where the naming rule names them now, each with its share of the supply. */
export function topHoldersOf(rows: readonly HolderRow[], supply: string | null, identities: ReadonlyMap<string, IdentityRow>): HomeTopHolders {
  const holders = rows.map((row) => ({ actor: actorOf({ account_id: row.account_id, wallet: row.wallet }, identities), balance: row.balance, share_bps: shareBps(row.balance, supply) }));
  const balance = rows.reduce((sum, row) => sum + BigInt(row.balance), 0n);
  return { holders, share_bps: holders.length === 0 ? null : shareBps(balance.toString(), supply) };
}

export type People = Readonly<{ identities: ReadonlyMap<string, IdentityRow>; followers: ReadonlyMap<string, number> }>;

/** The identities and Blast follower counts of these accounts (two key lookups). */
export async function readPeople(db: ReadableDatabase, accountIds: readonly string[]): Promise<People> {
  const ids = [...new Set(accountIds)];
  if (ids.length === 0) return { identities: new Map(), followers: new Map() };
  const [identities, followers] = await Promise.all([
    db.read<IdentityRow>(IDENTITIES_SQL, [ids]),
    db.read<{ account_id: string; followers: number }>(FOLLOWERS_SQL, [ids]),
  ]);
  return {
    identities: new Map(identities.rows.map((row) => [row.account_id, row])),
    followers: new Map(followers.rows.map((row) => [row.account_id, row.followers])),
  };
}

/** Grouped rows and their sides as participants, per sale. */
export function participantsBySale(grouped: readonly GroupedRow[], sides: readonly SideRow[], people: People): ReadonlyMap<string, HomeParticipant[]> {
  const sidesOf = new Map<string, SideRow[]>();
  for (const row of sides) {
    const key = `${row.sale}\u0000${row.who}`;
    sidesOf.set(key, [...(sidesOf.get(key) ?? []), row]);
  }
  const result = new Map<string, HomeParticipant[]>();
  for (const row of grouped) {
    const participant = participantOf({ grouped: row, sides: sidesOf.get(`${row.sale}\u0000${row.who}`) ?? [], ...people });
    result.set(row.sale, [...(result.get(row.sale) ?? []), participant]);
  }
  return result;
}

/** Display the last observation with its timestamp. Pool prices are event-driven, not a heartbeat. */
export function observedHomePrice(price: string | null, asOfMs: string | null, nowMs: number): Readonly<{ price: string; asOfMs: number }> | null {
  if (price === null || asOfMs === null) return null;
  const at = Number(asOfMs);
  return Number.isFinite(at) && at > 0 && at <= nowMs && /^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/.test(price) ? { price, asOfMs: at } : null;
}

type MobileMarketInputs = Readonly<{
  presale_id: string | null;
  coin_type: string;
  open_usd: string | null;
  escrowed: string | null;
}>;

/** Read the opening price and outstanding vesting for the trading rows on this page. */
const MOBILE_MARKET_SQL = `SELECT coin.presale_id, coin.coin_type, opening.open_usd, vesting.escrowed
  FROM unnest($1::text[], $2::text[]) AS coin(coin_type, presale_id)
  LEFT JOIN LATERAL (
    SELECT trim_scale(ph.usd_price)::text AS open_usd
    FROM chain_read_v1.price_history ph
    WHERE ph.coin_type = coin.coin_type AND ph.resolution = '5m'
      AND ph.bucket_ms >= $3::bigint - ${2 * PRICE_TIER_SPAN_MS["5m"]}
      AND ph.bucket_ms <= $3::bigint AND ph.as_of_ms <= $3::bigint
    ORDER BY ph.bucket_ms DESC LIMIT 1
  ) opening ON TRUE
  LEFT JOIN LATERAL (
    ${outstandingSaleTokensSql("coin.presale_id")}
  ) vesting ON coin.presale_id IS NOT NULL`;
assertChainReadThroughViews(MOBILE_MARKET_SQL);

async function readMobileMarket(db: ReadableDatabase, trading: readonly FactsRow[], hourStart: number) {
  if (trading.length === 0) return new Map<string, MobileMarketInputs>();
  const { rows } = await db.read<MobileMarketInputs>(MOBILE_MARKET_SQL, [
    trading.map((coin) => coin.coin_type),
    trading.map((coin) => coin.presale_id),
    hourStart,
  ]);
  return new Map(rows.map((row) => [row.presale_id ?? row.coin_type, row]));
}

export type CoinInputs = Readonly<{
  facts: FactsRow;
  activity: HomeActivity;
  /** The Relevant score the read ranked it by (`rank.ts`). */
  score: number;
  nowMs: number;
  supply: string | null;
  totalSupply: string | null;
  posts: number;
  spark: readonly PricePoint[];
  top_holders: HomeTopHolders;
  mobileMarket?: MobileMarketInputs;
  includeLiveInputs?: boolean;
  rollingChangeClockMs?: number;
}>;

function isTradable(facts: FactsRow): boolean {
  return facts.lifecycle === "migrated" && tradesInApp(facts.venue) &&
    (facts.venue.toLowerCase() !== "aftermath" || facts.pool_id !== null);
}

function tradeCoverageOf(facts: FactsRow): TradeCoverage {
  if (facts.tracked_pool_only) return "indexed";
  return facts.presale_id === null ? "own_pool" : "every_venue";
}

function dayChangeOf(facts: FactsRow, price: ReturnType<typeof observedHomePrice>, clockMs: number | undefined) {
  // A dated current mark can be the only observable price, including a just-opened pool.
  const singlePrice = facts.price_24h_usd === null && clockMs !== undefined && facts.lifecycle === "migrated" &&
    price && price.asOfMs > clockMs - HOME_WINDOW_MS["24h"] && price.asOfMs <= clockMs
    ? price
    : null;
  const openUsd = facts.price_24h_usd ?? singlePrice?.price ?? null;
  const from = facts.change_24h_from_ms == null ? singlePrice?.asOfMs : Number(facts.change_24h_from_ms);
  const lastPrice = price && (clockMs === undefined || price.asOfMs >= Number(facts.open_24h_as_of_ms))
    ? price.price
    : null;
  const change = changeBps(lastPrice, openUsd);
  const minute = 60_000;
  const baselineUntil = clockMs === undefined ? undefined : Math.min(
    (Math.floor(clockMs / minute) + 1) * minute,
    from === undefined ? Infinity : from + HOME_WINDOW_MS["24h"],
  );
  return {
    baselineUntil,
    openUsd,
    change_24h_bps: change,
    ...(from !== undefined && change !== null && { change_24h_from_ms: from }),
  };
}

/** One coin item from its facts, its window and its supply. */
export function coinOf(input: CoinInputs): HomeCoin {
  const { facts, activity, nowMs, supply, totalSupply, mobileMarket } = input;
  const hourStart = nowMs - HOME_WINDOW_MS["1h"];
  const price = observedHomePrice(facts.price_usd, facts.price_as_of_ms, nowMs);
  const { baselineUntil, openUsd, ...dayChange } = dayChangeOf(facts, price, input.rollingChangeClockMs);
  const circulating = mobileMarket ? supplyOf(supply, mobileMarket.escrowed)?.circulating ?? null : null;
  const hourEligible = facts.launched_ms === null || Number(facts.launched_ms) <= hourStart;
  const verifiedTeam = facts.verified_team || blastV1Coin(facts.coin_type)?.verifiedTeam;
  return {
    presale_id: facts.presale_id,
    coin_type: facts.coin_type,
    ...coinLabel({ coinType: facts.coin_type, symbol: facts.symbol, name: facts.name }),
    icon_url: facts.icon_url || null,
    ...(verifiedTeam ? { verified_team: true } : {}),
    decimals: facts.sale_decimals,
    lifecycle: facts.lifecycle,
    venue: facts.venue,
    tradable: isTradable(facts),
    opened_ms: facts.opened_ms === null ? null : Number(facts.opened_ms),
    launched_ms: facts.launched_ms === null ? null : Number(facts.launched_ms),
    launch_id: facts.launch_id,
    quote: { type: facts.quote_type, symbol: facts.quote_symbol, decimals: facts.quote_decimals },
    sale: facts.presale_id === null ? null : { start_ms: Number(facts.start_ms), end_ms: Number(facts.end_ms), raise_target: facts.raise_target, raised: facts.raised, participants: Number(facts.participants) },
    price_usd: price?.price ?? null,
    price_as_of_ms: price?.asOfMs ?? null,
    ...dayChange,
    holders: facts.holders === null ? null : Number(facts.holders),
    holders_as_of_ms: facts.holders_as_of_ms === null ? null : Number(facts.holders_as_of_ms),
    fdv_usd: fdvOf(price?.price ?? null, totalSupply, facts.sale_decimals),
    ...(input.includeLiveInputs && mobileMarket && {
      live_inputs: {
        ...(price && facts.price_checkpoint != null && { price_checkpoint: Number(facts.price_checkpoint) }),
        total_supply: totalSupply,
        circulating_supply: circulating,
        open_1h_usd: hourEligible ? mobileMarket.open_usd : null,
        open_24h_usd: openUsd,
        ...(baselineUntil !== undefined && { open_24h_until_ms: baselineUntil }),
        baselines_until_ms: (Math.floor(nowMs / PRICE_TIER_SPAN_MS["5m"]) + 1) * PRICE_TIER_SPAN_MS["5m"],
      },
    }),
    ...(mobileMarket && {
      mobile_market: {
        market_cap_usd: fdvOf(price?.price ?? null, circulating, facts.sale_decimals),
        change_1h_bps: price && price.asOfMs > hourStart && hourEligible
          ? changeBps(price.price, mobileMarket.open_usd)
          : null,
      },
    }),
    spark: input.spark,
    activity,
    discussion: { posts: input.posts },
    top_holders: input.top_holders,
    rank: { score: input.score, why: whyShown(activity, tradeCoverageOf(facts)) },
  };
}

type Candidate = Rankable & Readonly<{ facts: FactsRow; counts: WindowCountsRow | undefined; marketCapUsd: number | null }>;

/** The coin's FDV now in USD from its indexed price and supply, as a number for ordering; null without either. */
function fdvNumber(price: string | null, totalSupply: string | null, decimals: number): number | null {
  const fdv = fdvOf(price, totalSupply, decimals);
  return fdv === null ? null : Number(fdv);
}

type RaiseFacts = Pick<FactsRow, "presale_id" | "raised" | "quote_decimals" | "quote_price_usd">;

/**
 * A Blast coin's raise in USD at the quote's price now: what a sale raised,
 * or the target (quote atoms) its curve had to reach to graduate. Null
 * without a price or a target.
 */
export function raiseUsdOf(facts: RaiseFacts, graduationTarget: string | null): number | null {
  const atoms = facts.presale_id === null ? graduationTarget : facts.raised;
  if (facts.quote_price_usd === null || atoms === null || !/^(0|[1-9][0-9]*)$/.test(atoms)) return null;
  return Number(atoms) / 10 ** facts.quote_decimals * Number(facts.quote_price_usd);
}

/**
 * Blast dust: a coin whose raise (a sale's, or a curve's graduation target)
 * or market cap is under `HOME_DUST_USD`. Catalog coins are never dust, and
 * a value we cannot compute does not count: unknown is not small.
 */
export function isBlastDust(
  facts: RaiseFacts & Pick<FactsRow, "tracked_pool_only">,
  values: Readonly<{ marketCapUsd: number | null; graduationTarget: string | null }>,
): boolean {
  if (facts.tracked_pool_only) return false;
  return [raiseUsdOf(facts, values.graduationTarget), values.marketCapUsd].some((value) => value !== null && value < HOME_DUST_USD);
}

function candidateOf(facts: FactsRow, counts: WindowCountsRow | undefined, span: HomeSpan): Candidate {
  const latestMs = counts?.latest_ms === null || counts?.latest_ms === undefined ? null : Number(counts.latest_ms);
  const inputs = rankInputs({ participants: Number(counts?.participants ?? 0), events: Number(counts?.events ?? 0), latest_ms: latestMs, window: span.window, to_ms: span.toMs, volume_usd: counts?.volume_usd ?? null });
  const holders = facts.holders === null ? null : Number(facts.holders);
  const price = observedHomePrice(facts.price_usd, facts.price_as_of_ms, span.toMs)?.price ?? null;
  return {
    facts,
    counts,
    coinType: facts.coin_type,
    score: relevanceScore({ inputs, latestMs, holders }, span.window, span.toMs),
    inputs,
    latestMs,
    launchedMs: facts.launched_ms === null ? null : Number(facts.launched_ms),
    holders,
    fdvUsd: fdvNumber(price, facts.total_supply, facts.sale_decimals),
    // As the item's market cap: a curve coin's live supply, a sale's supply less its vesting.
    marketCapUsd: fdvNumber(price, supplyOf(facts.supply ?? facts.total_supply, facts.escrowed)?.circulating ?? null, facts.sale_decimals),
  };
}

export type HomeReadContext = Readonly<{
  nowMs: number;
  /** Activity kinds left out (the trade kinds while trading is hidden, OA-7). */
  hiddenKinds: readonly string[];
  /** The sales' terms, for FDV; null when the projection is not configured. */
  terms: PresaleTermsReader | null;
  trackedPoolMarket?: typeof readTrackedPoolMarket;
  /** Graduated curves' raise targets, for the dust rule (`curve-targets.ts`). */
  curveTargets?: CurveTargets;
  signal?: AbortSignal;
  holderLimit?: number;
  includeMobileMarket?: boolean;
  includeLiveInputs?: boolean;
  includeRollingChange?: boolean;
  includeDexVolume?: boolean;
  includeRecentBuys?: boolean;
}>;

function withTrackedPoolMarket(
  coin: HomeCoin,
  market: TrackedPoolMarket | undefined,
  indexedTotal: string | null,
  indexedCirculating: string | null,
): HomeCoin {
  const priceUsd = coin.price_usd ?? market?.price?.priceUsd ?? null;
  const total = indexedTotal ?? market?.totalSupplyAtoms ?? null;
  const circulating = indexedCirculating ?? market?.circulatingSupplyAtoms ?? null;
  return {
    ...coin,
    price_usd: priceUsd,
    price_as_of_ms: coin.price_as_of_ms ?? market?.price?.asOfMs ?? null,
    fdv_usd: fdvOf(priceUsd, total, coin.decimals),
    ...(coin.mobile_market && {
      mobile_market: {
        ...coin.mobile_market,
        market_cap_usd: fdvOf(priceUsd, circulating, coin.decimals),
      },
    }),
    ...(coin.live_inputs && {
      live_inputs: { ...coin.live_inputs, total_supply: total, circulating_supply: circulating },
    }),
  };
}

/**
 * The page's coins: their previews (the newest participants, a seller kept),
 * their people, their supplies, and each coin assembled. `actors` scopes the
 * previews (everyone, or a viewer's follows).
 */
export async function assembleCoins(
  db: ReadableDatabase,
  input: Readonly<{
    candidates: readonly Candidate[];
    sides: readonly SideRow[];
    span: HomeSpan;
    bounds: HomeBounds;
    kinds: readonly string[];
    actors: ActorScope;
    scope: HomeActivity["scope"];
    context: HomeReadContext;
    dexVolumes?: ReadonlyMap<string, HomeDexVolume>;
    /** The tracked pool snapshot this request already read, if any. */
    trackedMarkets?: TrackedMarkets;
  }>,
): Promise<HomeCoin[]> {
  const { candidates, span, bounds, kinds, actors, context } = input;
  const ids = candidates.map(({ facts }) => facts.presale_id ?? facts.coin_type);
  const presaleIds = candidates.flatMap(({ facts }) => facts.presale_id === null ? [] : [facts.presale_id]);
  const missingSupply = candidates.flatMap(({ facts }) => facts.presale_id !== null && facts.total_supply === null ? [facts.presale_id] : []);
  const trading = candidates.map((candidate) => candidate.facts).filter((facts) => facts.lifecycle === "migrated");
  const needsTrackedMarket = trading.some((facts) => facts.tracked_pool_only && (
    facts.total_supply === null ||
    (context.includeMobileMarket && facts.supply === null) ||
    !observedHomePrice(facts.price_usd, facts.price_as_of_ms, context.nowMs)
  ));
  const trackedMarketRead = input.trackedMarkets ?? (needsTrackedMarket && context.trackedPoolMarket
    ? optionalSource("tracked_pool_market", context.trackedPoolMarket, {})
    : null);
  const [grouped, holders, dexVolumes] = await Promise.all([
    readTopParticipants(db, { span, bounds, kinds, sales: { kind: "ids", presaleIds: ids, includeStandalone: candidates.some(({ facts }) => facts.presale_id === null) }, actors }, HOME_PREVIEW_ROWS * 2),
    readTopHolders(db, trading, bounds.clockMs, context.holderLimit),
    input.dexVolumes ?? (context.includeDexVolume
      ? readDexVolumes(db, trading, span.window, bounds, kinds)
      : null),
  ]);
  const holderAccounts = [...holders.values()].flat().flatMap((row) => (row.account_id === null ? [] : [row.account_id]));
  const [people, supplies, posts, sparks, mobileMarket, trackedMarkets] = await Promise.all([
    readPeople(db, [...grouped.flatMap((row) => (row.account_id === null ? [] : [row.account_id])), ...holderAccounts]),
    context.terms ? readSupplies(context.terms, missingSupply, context.signal) : null,
    readDiscussionCounts(db, presaleIds),
    readSparks(db, trading, context.nowMs),
    context.includeMobileMarket ? readMobileMarket(db, trading, context.nowMs - HOME_WINDOW_MS["1h"]) : null,
    trackedMarketRead,
  ]);
  const candidateIds = new Set(ids);
  const sides = input.sides.filter((row) => candidateIds.has(row.sale));
  const perSale = participantsBySale(grouped, sides, people);
  return candidates.map((candidate) => {
    const id = candidate.facts.presale_id ?? candidate.facts.coin_type;
    const activity = activityOf({
      scope: input.scope,
      window: span.window,
      fromMs: span.fromMs,
      toMs: span.toMs,
      counts: candidate.counts,
      sides: sides.filter((row) => row.sale === id),
      preview: previewOf(perSale.get(id) ?? []).map((participant) =>
        actors.kind === "followed" && participant.actor.type === "account" ? { ...participant, relation: "followed" as const } : participant),
    });
    const terms = supplies?.get(id);
    const totalSupply = candidate.facts.presale_id === null
      ? candidate.facts.total_supply
      : presaleTotalSupply(candidate.facts.total_supply, terms);
    const supply = candidate.facts.supply ?? totalSupply ?? terms?.supply.total ?? null;
    const indexed = coinOf({
      facts: candidate.facts, activity, score: candidate.score, nowMs: context.nowMs, supply, totalSupply, posts: posts.get(id) ?? 0, spark: sparks.get(id) ?? [],
      top_holders: topHoldersOf(holders.get(candidate.facts.coin_type) ?? [], supply, people.identities),
      mobileMarket: mobileMarket?.get(id),
      includeLiveInputs: context.includeLiveInputs,
      rollingChangeClockMs: context.includeRollingChange ? bounds.clockMs : undefined,
    });
    const coin = candidate.facts.tracked_pool_only
      ? withTrackedPoolMarket(indexed, trackedMarkets?.[candidate.coinType], totalSupply, candidate.facts.supply)
      : indexed;
    const dexVolume = dexVolumes?.get(candidate.coinType);
    return dexVolume ? { ...coin, dex_volume: dexVolume } : coin;
  });
}

/**
 * Each trading coin's 24 h USD price line, keyed by sale: the prices
 * module's bounded reads (two statements for any number of coins), the
 * line empty for a coin without two points. A presale has no line.
 */
async function readSparks(db: ReadableDatabase, facts: readonly FactsRow[], clockMs: number): Promise<ReadonlyMap<string, readonly PricePoint[]>> {
  if (facts.length === 0) return new Map();
  const keys = facts.map((row) => ({ presaleId: row.presale_id, coinType: row.coin_type, launchedMs: row.launched_ms === null ? null : Number(row.launched_ms) }));
  const histories = await readPriceHistories(db, keys, { window: "24h", clockMs, points: HOME_SPARK_POINTS });
  return new Map(histories.flatMap((history) => ([[history.presale_id ?? history.coin_type, history.points] as const])));
}

/** One confirmed amount per returned coin, with its actual quote asset. */
function recentPageBuys(sides: readonly SideRow[], coins: readonly HomeCoin[]): HomeRecentBuy[] {
  const page = new Set(coins.map(coin => coin.presale_id ?? coin.coin_type));
  const buys = new Map<string, HomeRecentBuy>();
  for (const row of sides) {
    if (!row.recent_buy || !page.has(row.sale)) continue;
    const [timestamp, checkpoint, tx, event, part, atoms] = row.recent_buy;
    const asset = quoteAssetOf(row.quote_type, row);
    if (!asset.symbol || asset.decimals === null || !/^[1-9][0-9]{0,19}$/.test(atoms)) continue;
    const id = `${checkpoint}:${tx}:${event}:${part}`;
    const occurred = Number(timestamp);
    const previous = buys.get(row.sale);
    if (previous && (previous.occurred_at_ms > occurred ||
      (previous.occurred_at_ms === occurred && compareEventCursors(id, previous.activity_id) <= 0))) continue;
    buys.set(row.sale, {
      coin_key: row.sale,
      activity_id: id,
      occurred_at_ms: occurred,
      quote_atoms: atoms,
      quote_symbol: asset.symbol,
      quote_decimals: asset.decimals,
    });
  }
  return [...buys.values()];
}

/**
 * Idle coins order by FDV (`rank.ts`); a catalog coin's supply lives outside
 * the chain views, so those orders read the shared tracked pool snapshot
 * (one process-cached read for every catalog coin).
 */
async function withTrackedFdv(candidates: readonly Candidate[], query: HomeQuery, context: HomeReadContext): Promise<{ candidates: readonly Candidate[]; markets?: TrackedMarkets }> {
  const missing = candidates.some((candidate) => candidate.facts.tracked_pool_only && candidate.fdvUsd === null);
  if (!missing || !context.trackedPoolMarket || (query.sort !== "relevant" && query.sort !== "trending")) return { candidates };
  const markets = await optionalSource("tracked_pool_market", context.trackedPoolMarket, {});
  return { markets, candidates: candidates.map((candidate) => {
    const market = candidate.facts.tracked_pool_only && candidate.fdvUsd === null ? markets[candidate.coinType] : undefined;
    if (!market) return candidate;
    const price = observedHomePrice(candidate.facts.price_usd, candidate.facts.price_as_of_ms, context.nowMs)?.price ?? market.price?.priceUsd ?? null;
    return { ...candidate, fdvUsd: fdvNumber(price, candidate.facts.total_supply ?? market.totalSupplyAtoms ?? null, candidate.facts.sale_decimals) };
  }) };
}

/** One Discover page (contract in `contracts/home.ts`). */
export async function readHomeDiscover(db: ReadableDatabase, query: HomeQuery, context: HomeReadContext): Promise<HomeCoinsPage> {
  const cursor = query.cursor === null ? null : decodeHomeCursor(query.cursor, query.sort);
  const [bounds, asOf] = await Promise.all([readHomeBounds(db, context.nowMs), readAsOf(db)]);
  if (!asOf) throw new SocialRouteError("service_unavailable");
  const span = homeSpan(query.window, bounds);
  const kinds = visibleKinds(context.hiddenKinds);
  const scope: SaleScope = { kind: "discover" };
  const actors: ActorScope = { kind: "everyone" };
  const [facts, sides] = await Promise.all([
    readCoinFacts(db, scope, bounds.clockMs, context),
    readSides(db, { span, bounds, kinds, sales: scope, actors }, context.includeRecentBuys ? context.nowMs - HOME_RECENT_BUY_MS : undefined),
  ]);
  const counts = countsOf(sides);
  const launchIds = [...facts.values()].flatMap((row) => row.presale_id === null && row.launch_id !== null ? [row.launch_id] : []);
  const targets = launchIds.length > 0 && context.curveTargets ? await context.curveTargets(launchIds) : new Map<string, string>();
  const eligible = [...facts.values()]
    .map((row) => candidateOf(row, counts.get(row.presale_id ?? row.coin_type), span))
    .filter((candidate) => !isBlastDust(candidate.facts, {
      marketCapUsd: candidate.marketCapUsd,
      graduationTarget: candidate.facts.launch_id === null ? null : targets.get(candidate.facts.launch_id) ?? null,
    }) && passesFilters(query, {
      participants: candidate.inputs.breadth,
      launchedMs: candidate.launchedMs,
      tradable: tradesInApp(candidate.facts.venue) && (candidate.facts.venue.toLowerCase() !== "aftermath" || candidate.facts.pool_id !== null),
      nowMs: bounds.clockMs,
    }));
  const { candidates, markets: trackedMarkets } = await withTrackedFdv(eligible, query, context);
  // Volume-based sorts (Relevant weighs volume too) need the same aggregate as the cell for all eligible candidates.
  const dexVolumes = context.includeDexVolume && query.sort !== "newest"
    ? await readDexVolumes(db, candidates.map(({ facts }) => facts), span.window, bounds, kinds)
    : undefined;
  const rankedCandidates = candidates.map(candidate => {
    const volume = dexVolumes?.get(candidate.coinType);
    if (!volume) return candidate;
    const inputs = { ...candidate.inputs, volume: Number(volume.usd ?? 0) };
    return { ...candidate, inputs, score: relevanceScore({ ...candidate, inputs }, span.window, span.toMs) };
  });
  const { page, nextCursor, pageNumber, pages, total, ranked } = pageOf(rankedCandidates, query.sort, cursor, query.limit, query.page);
  const coins = await assembleCoins(db, { candidates: page, sides, span, bounds, kinds, actors, scope: "pool", context, dexVolumes, trackedMarkets });
  const recentBuys = context.includeRecentBuys ? recentPageBuys(sides, coins) : [];
  return { coins, page: pageNumber, pages, total, ...(query.ranked ? { ranked } : {}), next_cursor: nextCursor, window: query.window, clock_ms: bounds.clockMs, as_of: asOf,
    ...(recentBuys.length > 0 && { recent_buys: recentBuys }) };
}

/**
 * `presale` values, repeatable: each a presale id or a standalone coin's
 * type, at most `HOME_COINS_MAX_IDS` distinct; else `invalid_parameter`
 * (`presale`).
 */
export function parsePresaleIds(params: URLSearchParams): readonly string[] {
  const ids = [...new Set(params.getAll("presale"))];
  return socialParameter(z.array(z.union([z.string().regex(SUI_OBJECT_ID_PATTERN), z.string().regex(COIN_TYPE)])).min(1).max(HOME_COINS_MAX_IDS), ids, "presale");
}

/** The items of these sales and standalone coins in the order asked (any lifecycle), with their market volumes. */
export async function readHomeCoinsByIds(
  db: ReadableDatabase,
  presaleIds: readonly string[],
  window: HomeWindow,
  context: HomeReadContext,
): Promise<HomeCoinsByIds> {
  const [bounds, asOf] = await Promise.all([readHomeBounds(db, context.nowMs), readAsOf(db)]);
  if (!asOf) throw new SocialRouteError("service_unavailable");
  const span = homeSpan(window, bounds);
  const kinds = visibleKinds(context.hiddenKinds);
  const scope: SaleScope = { kind: "ids", presaleIds, includeStandalone: presaleIds.some((id) => id.includes("::")) };
  const actors: ActorScope = { kind: "everyone" };
  const [facts, sides] = await Promise.all([
    readCoinFacts(db, scope, bounds.clockMs, context),
    readSides(db, { span, bounds, kinds, sales: scope, actors }),
  ]);
  const counts = countsOf(sides);
  const found = presaleIds.flatMap((id) => {
    const row = facts.get(id);
    return row ? [candidateOf(row, counts.get(id), span)] : [];
  });
  const coins = await assembleCoins(db, { candidates: found, sides, span, bounds, kinds, actors, scope: "pool", context });
  const tradesVisible = kinds.includes("trade_buy") && kinds.includes("trade_sell");
  const poolVolumes = Object.fromEntries(coins.map((coin) => {
    const sourceId = coin.presale_id ?? coin.coin_type;
    if (!tradesVisible || facts.get(sourceId)?.tracked_pool_only) return [coin.coin_type, null];
    const amounts = totalsOf(sides.filter((side) => side.sale === sourceId && (side.kind === "trade_buy" || side.kind === "trade_sell")));
    return [coin.coin_type, amounts.length > 0 ? amounts : [{
      quote_type: coin.quote.type, quote_symbol: coin.quote.symbol, quote_decimals: coin.quote.decimals,
      atoms: "0", usd: null, usd_complete: false,
    }]];
  }));
  return { coins, missing: presaleIds.filter((id) => !facts.has(id)), window, clock_ms: bounds.clockMs, as_of: asOf, pool_volumes: poolVolumes };
}

export type { Candidate };
export { candidateOf };

/** A larger holder preview is bounded to one coin so one request never fans out to 5,000 rows. */
export function parseHolderLimit(params: URLSearchParams, coinCount: number): number {
  const values = params.getAll("holder_limit");
  if (values.length === 0) return HOME_TOP_HOLDERS;
  const [limit] = socialParameter(z.tuple([
    z.string().regex(/^[1-9][0-9]{0,2}$/).transform(Number).pipe(z.number().min(1).max(HOME_MAX_HOLDERS))
      .refine((value) => value <= HOME_TOP_HOLDERS || coinCount === 1),
  ]), values, "holder_limit");
  return limit;
}
