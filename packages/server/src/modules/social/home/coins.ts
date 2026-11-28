import { displayPriceOf } from "@blast/core/modules/social/prices/test-sui.ts";
import { verifiedTeamSql } from "@blast/server/modules/social/read-model/verified-team.ts";
import { socialParameter } from "@blast/server/modules/social/route-kit/validation.ts";
import { z } from "zod";
import { compareEventCursors } from "@blast/core/modules/launchpad-contract/cursor.ts";
import { assertChainReadThroughViews } from "@blast/core/modules/database/modules.ts";
import type { ReadableDatabase } from "@blast/core/modules/database/transaction.ts";
import { coinLabel } from "@blast/core/modules/social/contracts/financial-wire.ts";
import type { PresaleTermsReader } from "@blast/core/modules/presale/terms/index.ts";
import { blastV1Coin } from "@blast/core/modules/social/portfolio/core-coins.ts";
import { namedWalletsOfSql } from "@blast/core/modules/social/read-model/naming.ts";
import { addressesOfAccountsSql } from "@blast/core/modules/social/presales/sql.ts";
import { SocialRouteError } from "@blast/core/modules/social/route-kit/errors.ts";

import {
  HOME_COINS_MAX_IDS,
  HOME_PREVIEW_ROWS,
  HOME_RECENT_BUY_MIN_USD,
  HOME_RECENT_BUY_MS,
  HOME_SPARK_POINTS,
  HOME_TOP_HOLDERS,
  HOME_WINDOW_MS,
  HOME_MAX_HOLDERS,
  HOME_NEW_SPAN_MS,
  type HomeActivity,
  type HomeTopHolders,
  type HomeCoin,
  type HomeCoinsByIds,
  type HomeCoinsPage,
  type HomeCurve,
  type HomeDexVolume,
  type HomeParticipant,
  type HomeQuery,
  type HomeStage,
  type HomeRecentBuy,
  type HomeWindow,
} from "@blast/core/modules/social/contracts/home.ts";
import { tradesInApp } from "@blast/core/modules/social/contracts/trades.ts";
import { readAsOf } from "@blast/server/modules/social/items/as-of.ts";
import { changeBps } from "@blast/core/modules/social/prices/change.ts";
import { readPriceHistories } from "@blast/server/modules/social/prices/history.ts";
import { latestWindowPriceSql, rollingPriceAtSql } from "@blast/server/modules/social/prices/price-at.ts";
import { PRICE_TIER_SPAN_MS, type PricePoint } from "@blast/core/modules/social/contracts/prices.ts";
import type { readTrackedPoolLaunches, readTrackedPoolMarket, TrackedPoolMarket } from "@blast/server/modules/launchpad-market/legacy-fdv.ts";
import { optionalSource } from "@blast/server/modules/social/optional-source.ts";
import { readStep, readSteps, type ReadSteps } from "@blast/server/modules/social/read-steps.ts";
import { curveProgressBps } from "@blast/core/modules/launchpad-contract/discovery.ts";
import { LAUNCH_LIFECYCLES, quoteRemaining, type LaunchLifecycle } from "@blast/core/modules/launchpad-contract/discovery-views.ts";
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
import {
  decodeHomeCursor,
  HOME_DUST_USD,
  pageOf,
  passesFilters,
  rankInputs,
  relevanceScore,
  saleIsIdle,
  saleSlots,
  scoreOfSlots,
  upcomingSaleWhy,
  whyShown,
  type Rankable,
  type SaleTraction,
  type TradeCoverage,
} from "@blast/server/modules/social/home/rank.ts";
import {
  GROUPED_GROUP,
  GROUPED_SELECT,
  PRESALE_SAVERS,
  Params,
  SIDES_GROUP,
  sidesSelect,
  homeSpan,
  idsScope,
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
 *    latest holder count and the count at the window's start
 *    (`coin_holder_history` by key, the second scanning back through the
 *    window's changes) and its lifecycle times;
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
  /** The holder count at the window's start: the last change at or before it; null when none is indexed by then. */
  holders_at_start: string | null;
  /** USD per whole quote coin now, to value a sale's raise or a curve's target. */
  quote_price_usd: string | null;
  /** A sale's tokens still held in vesting, in atoms; outside its market cap. */
  escrowed: string | null;
  /** A Blast curve coin's curve lifecycle (`LAUNCH_LIFECYCLES`); null for any other coin. */
  curve_lifecycle: string | null;
  /** A curve's quote reserve and graduation target in quote atoms; null for any other coin, or while unindexed. */
  quote_reserve: string | null;
  graduation_target: string | null;
  /** When a migrated curve's first DEX pool was created; null otherwise. */
  graduated_ms: string | null;
  /** A presale not trading yet, on a Trending read with presales (`social_presale_savers`): savers now and gained in the last hour and day; absent otherwise. */
  savers?: number | null;
  savers_1h?: number | null;
  savers_24h?: number | null;
  /** A Closest to graduating curve with a buy or sell in the last 24 hours (`homeClosestCurveSources`); absent on every other read. */
  recently_traded?: boolean;
}>;

type HomePriceOptions = Pick<HomeReadContext, "includeLiveInputs" | "includeRollingChange" | "trackedPoolLaunches">;

/** $1 clock (the 24 h move's end), $2 the window's start (new holders' baseline), then the scope's own parameters. */
function factsSql(scope: SaleScope, params: Params, options: HomePriceOptions = {}): string {
  const clock = `${params.add(0)}::bigint`;
  const windowFrom = `${params.add(0)}::bigint`;
  const cutoff = `${clock} - ${HOME_WINDOW_MS["24h"]}`;
  const source = scopedHomeCoinsSql(scope, params);
  const shorter = options.includeRollingChange ? clock : undefined;
  // Only Trending's presales carry savers. `OFFSET 0` keeps the lateral a subquery, so the view's
  // grouping runs per sale on its index instead of over every watchlist row.
  const savers = scope.kind === "discover" && scope.presales ? {
    columns: ", sv.savers, sv.gained_1h AS savers_1h, sv.gained_24h AS savers_24h",
    join: `LEFT JOIN LATERAL (
    SELECT s.savers, s.gained_1h, s.gained_24h FROM ${PRESALE_SAVERS} s WHERE p.presale_id IS NOT NULL AND p.lifecycle <> 'migrated' AND s.presale_id = p.presale_id OFFSET 0
  ) sv ON TRUE`,
  } : { columns: "", join: "" };
  const recentlyTraded = scope.kind === "discover" && scope.almost ? ", p.recently_traded" : "";
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
    h.holders::text AS holders, h.timestamp_ms::text AS holders_as_of_ms, h0.holders::text AS holders_at_start,
    trim_scale(qp.usd_price)::text AS quote_price_usd,
    CASE WHEN p.presale_id IS NOT NULL THEN (${outstandingSaleTokensSql("p.presale_id")}) END AS escrowed,
    lp.lifecycle AS curve_lifecycle, trunc(lp.quote_reserve)::text AS quote_reserve, trunc(lp.graduation_target)::text AS graduation_target,
    CASE WHEN lp.lifecycle = 'migrated' THEN (
      SELECT min(gp.created_at_ms) FROM chain_read_v1.pools gp WHERE gp.coin_type = p.sale_token AND gp.venue <> 'blast_curve'
    )::text END AS graduated_ms${savers.columns}${recentlyTraded}
  FROM ${source} p
  LEFT JOIN LATERAL (
    SELECT max(l.timestamp_ms) FILTER (WHERE l.state = 'opened') AS opened_ms,
      max(l.timestamp_ms) FILTER (WHERE l.state = 'migrated') AS migrated_ms
    FROM chain_read_v1.presale_lifecycle l WHERE l.presale_id = p.presale_id
  ) lc ON TRUE
  LEFT JOIN chain_read_v1.pools lp ON p.presale_id IS NULL AND lp.coin_type = p.sale_token AND lp.venue = 'blast_curve'
  LEFT JOIN chain_read_v1.coins cs ON p.presale_id IS NULL AND cs.coin_type = p.sale_token
  LEFT JOIN chain_read_v1.presale_coin_supply ps ON p.presale_id IS NOT NULL AND ps.coin_type = p.sale_token
  LEFT JOIN ${displayPriceOf("p.sale_token")} pr ON TRUE
  LEFT JOIN ${displayPriceOf("p.quote_type")} qp ON TRUE
  LEFT JOIN LATERAL (${rollingPriceAtSql("p.sale_token", cutoff, shorter)}) open_24h ON TRUE
  ${lastPrice}
  LEFT JOIN LATERAL (
    SELECT ch.holders, ch.timestamp_ms FROM chain_read_v1.coin_holder_history ch
    WHERE ch.coin_type = p.sale_token ORDER BY ch.checkpoint DESC LIMIT 1
  ) h ON TRUE
  LEFT JOIN LATERAL (
    SELECT ch.holders FROM chain_read_v1.coin_holder_history ch
    WHERE ch.coin_type = p.sale_token AND ch.timestamp_ms <= ${windowFrom} ORDER BY ch.checkpoint DESC LIMIT 1
  ) h0 ON TRUE
  ${savers.join}`;
}

assertChainReadThroughViews(factsSql({ kind: "discover", presales: { clockMs: 0, fromMs: 0 }, curves: { fromMs: 0, toMs: 0, marketCheckpoint: 0, kinds: [] } }, new Params(), {
  includeLiveInputs: true,
  includeRollingChange: true,
}));

/** The facts of every sale in `scope`, keyed by presale id; `span` dates the price clock and the new holders' baseline. */
export async function readCoinFacts(db: ReadableDatabase, scope: SaleScope, span: Pick<HomeSpan, "fromMs" | "toMs">, options: HomePriceOptions = {}): Promise<ReadonlyMap<string, FactsRow>> {
  if (scope.kind === "ids" && scope.presaleIds.length === 0) return new Map();
  const params = new Params();
  const text = factsSql(scope, params, options);
  params.values[0] = span.toMs;
  params.values[1] = span.fromMs;
  const { rows } = await db.read<FactsRow>(text, params.values);
  const launches = await trackedLaunchesOf(rows, options.trackedPoolLaunches);
  return new Map(rows.map((row) => {
    const launchedMs = launches.get(row.coin_type);
    return [row.presale_id ?? row.coin_type, launchedMs === undefined ? row : { ...row, launched_ms: String(launchedMs) }];
  }));
}

/**
 * A tracked pool coin has no Blast launch, so its Age is when its package was
 * published (never when tracking began); every other coin keeps its launch.
 */
async function trackedLaunchesOf(rows: readonly FactsRow[], read: HomeReadContext["trackedPoolLaunches"]): Promise<ReadonlyMap<string, number>> {
  const coinTypes = rows.flatMap((row) => (row.tracked_pool_only && row.launched_ms === null ? [row.coin_type] : []));
  if (coinTypes.length === 0 || !read) return new Map();
  return optionalSource("tracked_pool_launches", () => read(coinTypes), new Map());
}

/** The window's sums per (sale, identity, kind, quote asset). */
export async function readSides(db: ReadableDatabase, request: RowsRequest, recentBuyFromMs?: number): Promise<readonly SideRow[]> {
  if (request.sales.kind === "ids" && request.sales.presaleIds.length === 0) return [];
  const params = new Params();
  // Tiny trades stay for the volume sums; the counts skip them (`sidesSelect`).
  const rows = rowsWithSql({ ...request, keepTiny: true }, params);
  // Keep one event's fields together, ordered by timestamp and cursor, in the existing aggregate.
  // A priced buy under the floor is skipped here, so dust never hides the real buy before it.
  const recentBuy = recentBuyFromMs === undefined ? "" : `,
    (max(ARRAY[w.timestamp_ms, w.checkpoint, w.tx_slot, w.event_slot, w.part, w.quote_amount, trim_scale(w.usd_value)]::numeric[])
      FILTER (WHERE w.kind = 'trade_buy' AND NOT w.tiny AND w.timestamp_ms > ${params.add(recentBuyFromMs)}::bigint
        AND w.quote_amount > 0 AND (w.usd_value IS NULL OR w.usd_value >= ${params.add(HOME_RECENT_BUY_MIN_USD)}::numeric)))::text[] AS recent_buy`;
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
 * Balances read per coin beyond the holders asked for, so an account whose
 * wallets all sit just below the holders shown can still be found.
 */
const HOLDER_HEADROOM = 50;

/**
 * Balances read when one coin is asked for (its holders page, or one coin by
 * id): the 1,000 largest, the same cut `chain_read_v1.coin_balances` keeps
 * for a tracked coin.
 */
const ONE_COIN_HOLDER_ROWS = 1000;

/** A holder balance from `chain_read_v1.coin_balances`, where the view's own rows are not a position. */
const HOLDER_BALANCE_SQL = `cb.balance > 0 AND NOT (cb.owner = ANY($2::text[]))
        AND cb.owner <> ('0x' || repeat('0', 64))
        AND NOT EXISTS (SELECT 1 FROM chain_read_v1.pools pl WHERE pl.pool_key = cb.owner)`;

/**
 * The biggest holders of each coin now, from `chain_read_v1.coin_balances`:
 * an account's wallets summed into one holder (the naming rule as of now),
 * an unnamed wallet its own; the sale's own object, its pool and any pool
 * address left out (they hold the supply, not a position), and `0x0`, whose
 * burned balance the view lists but the live supply already subtracts. $1
 * coin types, $2 the addresses left out, $3 the clock, $4 holders per coin,
 * $5 balances read per coin.
 *
 * Each step after the first reads by index and is bounded by the rows
 * before it, so no row estimate for the view can make it slow (joining every
 * holder to every named wallet let one pick a nested loop over all of them,
 * past Home's 2 s statement timeout):
 *
 * 1. `home_top`: each coin's `$5` largest balances (a tracked coin's view
 *    rows are its 1,000 largest; a launch or sale coin sorts all its holders).
 * 2. `home_named`: the owners of those wallets, by address.
 * 3. `home_account_wallets`: every wallet of those owners, by account.
 * 4. `home_account_balances`: those wallets' balances of the coin (by
 *    `(coin_type, owner)`, or among a tracked coin's 1,000 view rows), so
 *    each account sums all its wallets.
 *
 * An account none of whose wallets is among a coin's `$5` largest balances
 * is not listed for it, and one account holding most of those balances can
 * leave fewer than `$4` holders listed.
 */
const TOP_HOLDERS_SQL = `WITH home_top AS MATERIALIZED (
    SELECT home_coin.coin_type, top.owner, top.balance
    FROM (SELECT DISTINCT unnest($1::text[]) AS coin_type) home_coin
    CROSS JOIN LATERAL (
      SELECT cb.owner, cb.balance FROM chain_read_v1.coin_balances cb
      WHERE cb.coin_type = home_coin.coin_type AND ${HOLDER_BALANCE_SQL}
      ORDER BY cb.balance DESC, cb.owner
      LIMIT $5::int) top
  ),
  home_named AS MATERIALIZED (
    SELECT n.* FROM (${namedWalletsOfSql("ARRAY(SELECT DISTINCT t.owner FROM home_top t)")}) n WHERE n.named_from_ms <= $3::bigint
  ),
  home_account_wallets AS MATERIALIZED (
    SELECT n.* FROM (${namedWalletsOfSql(`ARRAY(SELECT mine.address FROM (${addressesOfAccountsSql("ARRAY(SELECT DISTINCT hn.account_id FROM home_named hn)")}) mine)`)}) n
    WHERE n.named_from_ms <= $3::bigint AND n.account_id IN (SELECT hn.account_id FROM home_named hn)
  ),
  home_account_balances AS MATERIALIZED (
    SELECT home_coin.coin_type, held.owner, held.balance
    FROM (
      SELECT t.coin_type, array_agg(DISTINCT w.address) AS addresses
      FROM home_top t
      JOIN home_named hn ON hn.address = t.owner
      JOIN home_account_wallets w ON w.account_id = hn.account_id
      GROUP BY t.coin_type
    ) home_coin
    CROSS JOIN LATERAL (
      SELECT cb.owner, cb.balance FROM chain_read_v1.coin_balances cb
      WHERE cb.coin_type = home_coin.coin_type AND cb.owner = ANY(home_coin.addresses) AND ${HOLDER_BALANCE_SQL}
    ) held
  ),
  home_holders AS (
    SELECT b.coin_type,
      CASE WHEN w.account_id IS NULL THEN 'w:' || b.owner ELSE 'a:' || w.account_id::text END AS who,
      w.account_id::text AS account_id, min(b.owner) AS wallet, sum(b.balance) AS balance
    FROM (SELECT t.coin_type, t.owner, t.balance FROM home_top t UNION SELECT h.coin_type, h.owner, h.balance FROM home_account_balances h) b
    LEFT JOIN (SELECT hn.address, hn.account_id FROM home_named hn UNION SELECT aw.address, aw.account_id FROM home_account_wallets aw) w ON w.address = b.owner
    GROUP BY b.coin_type, 2, w.account_id
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
  const perCoin = facts.length === 1 ? ONE_COIN_HOLDER_ROWS : limit + HOLDER_HEADROOM;
  const { rows } = await db.read<HolderRow>(`SELECT home_result.* FROM (${TOP_HOLDERS_SQL}) AS home_result`, [facts.map((row) => row.coin_type), excluded, clockMs, limit, perCoin]);
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

/**
 * Read the opening price and outstanding vesting for the trading rows on this page. The hour opens at the last price
 * at or before its start, however long the coin was quiet before it, as the day does.
 */
const MOBILE_MARKET_SQL = `SELECT coin.presale_id, coin.coin_type, trim_scale(opening.usd_price)::text AS open_usd, vesting.escrowed
  FROM unnest($1::text[], $2::text[]) AS coin(coin_type, presale_id)
  LEFT JOIN LATERAL (${rollingPriceAtSql("coin.coin_type", "$3::bigint")}) opening ON TRUE
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
  includeCurve?: boolean;
  rollingChangeClockMs?: number;
  /** A presale not trading yet on Trending with presales: adds `sale.savers`, and an upcoming sale's why. */
  sale?: CandidateSale;
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

const ATOMS = /^(0|[1-9][0-9]*)$/;
const atomsOf = (value: string | null) => (value !== null && ATOMS.test(value) ? BigInt(value) : null);
const isLaunchLifecycle = (value: string | null): value is LaunchLifecycle => LAUNCH_LIFECYCLES.some((lifecycle) => lifecycle === value);

/**
 * A curve coin's curve (`HomeCoin.curve`): progress over the view's reserve
 * and target through the SDK, so a SUI curve and a USDC curve compare by
 * percent, never by atoms. Ready to migrate or migrated is 10,000 with
 * nothing left. Null for a coin without a curve.
 */
export function curveOf(facts: Pick<FactsRow, "curve_lifecycle" | "quote_reserve" | "graduation_target">): HomeCurve | null {
  const lifecycle = facts.curve_lifecycle;
  if (!isLaunchLifecycle(lifecycle)) return null;
  if (lifecycle === "migration_ready" || lifecycle === "migrated") return { lifecycle, progress_bps: 10_000, quote_remaining: "0" };
  const reserve = atomsOf(facts.quote_reserve);
  const target = atomsOf(facts.graduation_target);
  if (reserve === null || target === null || target === 0n) return { lifecycle, progress_bps: null, quote_remaining: null };
  return {
    lifecycle,
    progress_bps: Number(curveProgressBps(lifecycle, reserve, target)),
    quote_remaining: quoteRemaining(reserve, target).toString(),
  };
}

/** A curve still filling (`live`, `migration_ready`): not yet on a DEX. */
export const isFillingCurve = (facts: Pick<FactsRow, "curve_lifecycle">) =>
  facts.curve_lifecycle === "live" || facts.curve_lifecycle === "migration_ready";

// A curve still filling trades on its curve, not a DEX: its volume stays its curve trades, never a DEX figure.
const onDex = <T extends Pick<FactsRow, "curve_lifecycle">>(rows: readonly T[]) => rows.filter((row) => !isFillingCurve(row));
/** A coin that trades on a DEX: a migrated sale or curve, a V1 or catalog coin; never a sale or a curve still filling. */
const isListed = (facts: Pick<FactsRow, "lifecycle" | "curve_lifecycle">) => facts.lifecycle === "migrated" && !isFillingCurve(facts);

/** The opt-in curve fields (`curve=1`): the curve's progress and when the coin graduated. */
const curveFieldsOf = (facts: FactsRow) => ({
  curve: curveOf(facts),
  graduated_ms: facts.graduated_ms === null ? null : Number(facts.graduated_ms),
});

/** A presale's terms; `savers` only on Trending's presales. */
const saleFieldsOf = (facts: FactsRow, savers: number | undefined) => facts.presale_id === null ? null : {
  start_ms: Number(facts.start_ms), end_ms: Number(facts.end_ms), raise_target: facts.raise_target, raised: facts.raised, participants: Number(facts.participants),
  ...(savers !== undefined && { savers }),
};

/** Whether the coin carries the Known deployer badge: a verified team, or a Blast v1 coin marked as one. Discover's `known_deployer` filter reads the same value. */
const isKnownDeployer = (facts: Pick<FactsRow, "verified_team" | "coin_type">) => facts.verified_team || blastV1Coin(facts.coin_type)?.verifiedTeam === true;

/** One coin item from its facts, its window and its supply. */
export function coinOf(input: CoinInputs): HomeCoin {
  const { facts, activity, nowMs, supply, totalSupply, mobileMarket } = input;
  const hourStart = nowMs - HOME_WINDOW_MS["1h"];
  const price = observedHomePrice(facts.price_usd, facts.price_as_of_ms, nowMs);
  const { baselineUntil, openUsd, ...dayChange } = dayChangeOf(facts, price, input.rollingChangeClockMs);
  const circulating = mobileMarket ? supplyOf(supply, mobileMarket.escrowed)?.circulating ?? null : null;
  const hourEligible = facts.launched_ms === null || Number(facts.launched_ms) <= hourStart;
  const verifiedTeam = isKnownDeployer(facts);
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
    ...(input.includeCurve && curveFieldsOf(facts)),
    quote: { type: facts.quote_type, symbol: facts.quote_symbol, decimals: facts.quote_decimals },
    sale: saleFieldsOf(facts, input.sale?.savers),
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
    rank: { score: input.score, why: input.sale?.upcoming ? upcomingSaleWhy(input.sale.savers, input.sale.startMs, nowMs) : whyShown(activity, tradeCoverageOf(facts)) },
  };
}

type Candidate = Rankable & Readonly<{
  facts: FactsRow; counts: WindowCountsRow | undefined; marketCapUsd: number | null; netInflow: number; newHolders: number;
  /** A presale not trading yet on Trending with presales: its savers and schedule, for the item. */
  sale?: CandidateSale;
}>;

type CandidateSale = Readonly<{ savers: number; startMs: number | null; upcoming: boolean }>;

/**
 * Holders gained in the window: the count now less the count at its start,
 * 0 when negative. A coin launched inside the window started from none; any
 * other coin without both counts gains 0, never a guess.
 */
export function newHoldersOf(facts: Pick<FactsRow, "holders" | "holders_at_start" | "launched_ms">, span: Pick<HomeSpan, "fromMs">): number {
  if (facts.holders === null) return 0;
  const launchedInWindow = facts.launched_ms !== null && Number(facts.launched_ms) > span.fromMs;
  const start = facts.holders_at_start ?? (launchedInWindow ? "0" : null);
  return start === null ? 0 : Math.max(0, Number(facts.holders) - Number(start));
}

/** The coin's FDV now in USD from its indexed price and supply, as a number for ordering; null without either. */
function fdvNumber(price: string | null, totalSupply: string | null, decimals: number): number | null {
  const fdv = fdvOf(price, totalSupply, decimals);
  return fdv === null ? null : Number(fdv);
}

type RaiseFacts = Pick<FactsRow, "presale_id" | "lifecycle" | "raised" | "raise_target" | "graduation_target" | "quote_decimals" | "quote_price_usd">;

/** A presale not trading yet: upcoming, live, ended or funded (Discover lists one only on Trending with `presales=1`). */
export const isPresaleNotTrading = (facts: Pick<FactsRow, "presale_id" | "lifecycle">) => facts.presale_id !== null && facts.lifecycle !== "migrated";

/**
 * A Blast coin's raise in USD at the quote's price now: what a trading sale
 * raised, a sale not trading yet's target (a just-opened sale has raised
 * nothing yet; a target of 0 is no target), or the target (quote atoms) a
 * curve had to reach to graduate. Null without a price or a target.
 */
export function raiseUsdOf(facts: RaiseFacts): number | null {
  const target = facts.raise_target === "0" ? null : facts.raise_target;
  const atoms = facts.presale_id === null ? facts.graduation_target : isPresaleNotTrading(facts) ? target : facts.raised;
  return atoms === null ? null : quoteUsd(atoms, facts);
}

/**
 * Blast dust: a coin whose raise (a sale's, or a curve's graduation target)
 * or market cap is under `HOME_DUST_USD`. Catalog coins are never dust, and
 * a value we cannot compute does not count: unknown is not small.
 */
export function isBlastDust(facts: RaiseFacts & Pick<FactsRow, "tracked_pool_only">, marketCapUsd: number | null): boolean {
  if (facts.tracked_pool_only) return false;
  return [raiseUsdOf(facts), marketCapUsd].some((value) => value !== null && value < HOME_DUST_USD);
}

/** A quote amount (atoms) in USD at the quote's price now; null without a price. */
function quoteUsd(atoms: string, facts: Pick<FactsRow, "quote_decimals" | "quote_price_usd">): number | null {
  if (facts.quote_price_usd === null || !/^(0|[1-9][0-9]*)$/.test(atoms)) return null;
  return Number(atoms) / 10 ** facts.quote_decimals * Number(facts.quote_price_usd);
}

/** A sale's traction (`rank.ts`): its commits in the window (never its claims), its schedule and its savers. */
function saleTractionOf(facts: FactsRow, commits: WindowCountsRow | undefined, window: HomeWindow): SaleTraction {
  const start = Number(facts.start_ms);
  return {
    // A start of 0 is no schedule (the view reads 0 until the sale opens).
    startMs: facts.lifecycle === "pending" || !(start > 0) ? null : start,
    committers: Number(commits?.participants ?? 0),
    committedUsd: Math.max(0, Number(commits?.volume_usd ?? 0)) || 0,
    latestCommitMs: commits?.latest_ms == null ? null : Number(commits.latest_ms),
    allCommitters: Number(facts.participants) || 0,
    savers: facts.savers ?? 0,
    saversGained: (window === "1h" ? facts.savers_1h : facts.savers_24h) ?? 0,
  };
}

/**
 * A presale not trading yet as a Trending candidate: its score from its
 * traction (`saleSlots`), its inputs from its commits alone, and, when
 * idle, what it raised in the FDV slot (a low estimate of value, so a quiet
 * sale never beats a real coin; an upcoming sale has raised nothing and
 * goes last).
 */
function saleCandidateOf(facts: FactsRow, counts: WindowCountsRow | undefined, commits: WindowCountsRow | undefined, span: HomeSpan): Candidate {
  const sale = saleTractionOf(facts, commits, span.window);
  const slots = saleSlots(sale, span.window, span.toMs);
  const inputs = rankInputs({ participants: sale.committers, events: Number(commits?.events ?? 0), latest_ms: sale.latestCommitMs, window: span.window, to_ms: span.toMs, volume_usd: sale.committedUsd });
  const raised = quoteUsd(facts.raised, facts);
  return {
    facts,
    counts,
    coinType: facts.coin_type,
    score: scoreOfSlots(slots),
    idle: saleIsIdle(slots),
    netInflow: sale.committedUsd,
    newHolders: sale.committers,
    inputs,
    latestMs: sale.latestCommitMs,
    launchedMs: null,
    holders: null,
    fdvUsd: raised === null || raised === 0 ? null : raised,
    marketCapUsd: null,
    progressBps: null,
    lastTradeMs: null,
    sale: { savers: sale.savers, startMs: sale.startMs, upcoming: sale.startMs === null || sale.startMs > span.toMs },
  };
}

function candidateOf(facts: FactsRow, counts: WindowCountsRow | undefined, span: HomeSpan): Candidate {
  const latestMs = counts?.latest_ms === null || counts?.latest_ms === undefined ? null : Number(counts.latest_ms);
  const inputs = rankInputs({ participants: Number(counts?.participants ?? 0), events: Number(counts?.events ?? 0), latest_ms: latestMs, window: span.window, to_ms: span.toMs, volume_usd: counts?.volume_usd ?? null });
  const holders = facts.holders === null ? null : Number(facts.holders);
  const netInflow = Math.max(0, Number(counts?.net_inflow_usd ?? 0)) || 0;
  const newHolders = newHoldersOf(facts, span);
  const price = observedHomePrice(facts.price_usd, facts.price_as_of_ms, span.toMs)?.price ?? null;
  const lastTradeMs = counts?.last_trade_ms === null || counts?.last_trade_ms === undefined ? null : Number(counts.last_trade_ms);
  return {
    facts,
    counts,
    coinType: facts.coin_type,
    score: relevanceScore({ inputs, latestMs, holders, netInflow, newHolders }, span.window, span.toMs),
    netInflow,
    newHolders,
    inputs,
    latestMs,
    launchedMs: facts.launched_ms === null ? null : Number(facts.launched_ms),
    holders,
    fdvUsd: fdvNumber(price, facts.total_supply, facts.sale_decimals),
    // As the item's market cap: a curve coin's live supply, a sale's supply less its vesting.
    marketCapUsd: fdvNumber(price, supplyOf(facts.supply ?? facts.total_supply, facts.escrowed)?.circulating ?? null, facts.sale_decimals),
    // Only a curve still filling has a place in the progress order.
    progressBps: isFillingCurve(facts) ? curveOf(facts)?.progress_bps ?? null : null,
    lastTradeMs,
    ...(facts.recently_traded ? { recentlyTraded: true } : {}),
  };
}

export type HomeReadContext = Readonly<{
  nowMs: number;
  /** Activity kinds left out (the trade kinds while trading is hidden, OA-7). */
  hiddenKinds: readonly string[];
  /** The sales' terms, for FDV; null when the projection is not configured. */
  terms: PresaleTermsReader | null;
  trackedPoolMarket?: typeof readTrackedPoolMarket;
  /** Each tracked pool coin's package publish time, its Age. */
  trackedPoolLaunches?: typeof readTrackedPoolLaunches;
  signal?: AbortSignal;
  holderLimit?: number;
  includeMobileMarket?: boolean;
  includeLiveInputs?: boolean;
  includeRollingChange?: boolean;
  includeDexVolume?: boolean;
  /** Carry `HomeCoin.curve` and `graduated_ms` (`HOME_CURVE_PARAM`). */
  includeCurve?: boolean;
  includeRecentBuys?: boolean;
  includeRecentBuyUsd?: boolean;
  /** Trending lists presales not trading yet and live curves traded in the window (`HOME_PRESALES_PARAM`, `sort=relevant` only). */
  includePresales?: boolean;
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
    /** The answer these coins go into, for its step timings (`readStep`). */
    read: "home_discover" | "home_coins" | "home_following";
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
  const step = readSteps(input.read, { window: span.window });
  const { terms: termsReader, trackedPoolMarket } = context;
  const trackedMarketRead = input.trackedMarkets ?? (needsTrackedMarket && trackedPoolMarket
    ? optionalSource("tracked_pool_market", () => step("tracked_market", trackedPoolMarket), {})
    : null);
  const [grouped, holders, dexVolumes] = await Promise.all([
    // The window's activity again, for each coin's newest traders (the first scan is `readSides`).
    step("participants", () => readTopParticipants(db, { span, bounds, kinds, sales: { kind: "ids", presaleIds: ids, includeStandalone: candidates.some(({ facts }) => facts.presale_id === null) }, actors }, HOME_PREVIEW_ROWS * 2)),
    step("holders", () => readTopHolders(db, trading, bounds.clockMs, context.holderLimit)),
    input.dexVolumes ?? (context.includeDexVolume
      ? step("dex_volumes", () => readDexVolumes(db, onDex(trading), span.window, bounds, kinds))
      : null),
  ]);
  const holderAccounts = [...holders.values()].flat().flatMap((row) => (row.account_id === null ? [] : [row.account_id]));
  const [people, supplies, posts, sparks, mobileMarket, trackedMarkets] = await Promise.all([
    step("people", () => readPeople(db, [...grouped.flatMap((row) => (row.account_id === null ? [] : [row.account_id])), ...holderAccounts])),
    termsReader ? step("supplies", () => readSupplies(termsReader, missingSupply, context.signal)) : null,
    step("posts", () => readDiscussionCounts(db, presaleIds)),
    step("sparks", () => readSparks(db, trading, context.nowMs)),
    context.includeMobileMarket ? step("mobile_market", () => readMobileMarket(db, trading, context.nowMs - HOME_WINDOW_MS["1h"])) : null,
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
    const trackedMarket = candidate.facts.tracked_pool_only ? trackedMarkets?.[candidate.coinType] : undefined;
    const indexed = coinOf({
      facts: candidate.facts, activity, score: candidate.score, nowMs: context.nowMs, supply, totalSupply, posts: posts.get(id) ?? 0, spark: sparks.get(id) ?? [],
      // A tracked pool coin's live supply is the node's, as for its market cap.
      top_holders: topHoldersOf(holders.get(candidate.facts.coin_type) ?? [], supply ?? trackedMarket?.circulatingSupplyAtoms ?? null, people.identities),
      mobileMarket: mobileMarket?.get(id),
      includeLiveInputs: context.includeLiveInputs,
      includeCurve: context.includeCurve,
      rollingChangeClockMs: context.includeRollingChange ? bounds.clockMs : undefined,
      sale: candidate.sale,
    });
    const coin = candidate.facts.tracked_pool_only
      ? withTrackedPoolMarket(indexed, trackedMarket, totalSupply, candidate.facts.supply)
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

/** One confirmed amount per returned coin, with its actual quote asset and its dollar value when priced. */
function recentPageBuys(sides: readonly SideRow[], coins: readonly HomeCoin[], withUsd: boolean): HomeRecentBuy[] {
  const page = new Set(coins.map(coin => coin.presale_id ?? coin.coin_type));
  const buys = new Map<string, HomeRecentBuy>();
  for (const row of sides) {
    if (!row.recent_buy || !page.has(row.sale)) continue;
    const [timestamp, checkpoint, tx, event, part, atoms, usd] = row.recent_buy;
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
      // Digits only: a NaN or Infinity value would fail the page's strict schema.
      ...(withUsd && usd !== null && /^(0|[1-9][0-9]*)(\.[0-9]+)?$/.test(usd) && { usd }),
    });
  }
  return [...buys.values()];
}

/**
 * Idle coins order by FDV and Graduated by market cap (`rank.ts`); a catalog
 * coin's supply lives outside the chain views, so those orders read the
 * shared tracked pool snapshot (one process-cached read for every catalog
 * coin), with the same fallbacks as the item (`withTrackedPoolMarket`).
 */
async function withTrackedMarket(candidates: readonly Candidate[], context: HomeReadContext, step: ReadSteps): Promise<{ candidates: readonly Candidate[]; markets?: TrackedMarkets }> {
  const lacks = (candidate: Candidate) => candidate.facts.tracked_pool_only && (candidate.fdvUsd === null || candidate.marketCapUsd === null);
  if (!candidates.some(lacks) || !context.trackedPoolMarket) return { candidates };
  const trackedPoolMarket = context.trackedPoolMarket;
  const markets = await optionalSource("tracked_pool_market", () => step("base_tracked_market", trackedPoolMarket), {});
  return { markets, candidates: candidates.map((candidate) => {
    const market = lacks(candidate) ? markets[candidate.coinType] : undefined;
    if (!market) return candidate;
    const { facts } = candidate;
    const price = observedHomePrice(facts.price_usd, facts.price_as_of_ms, context.nowMs)?.price ?? market.price?.priceUsd ?? null;
    return {
      ...candidate,
      fdvUsd: candidate.fdvUsd ?? fdvNumber(price, facts.total_supply ?? market.totalSupplyAtoms ?? null, facts.sale_decimals),
      marketCapUsd: candidate.marketCapUsd ?? fdvNumber(price, facts.supply ?? market.circulatingSupplyAtoms ?? null, facts.sale_decimals),
    };
  }) };
}

/**
 * Everything a Discover page needs that does not depend on its sort, filters
 * or page: the window's facts, sides, counts and every non-dust candidate,
 * already scored (DEX volume and tracked FDV folded in). Switching between
 * Trending, Volume, New and Held reuses one of these per window instead of
 * reading the window again, so a switch costs one in-memory sort plus the
 * page's own details.
 */
export type HomeDiscoverBase = Readonly<{
  asOf: NonNullable<Awaited<ReturnType<typeof readAsOf>>>;
  bounds: HomeBounds;
  span: HomeSpan;
  kinds: readonly string[];
  sides: readonly SideRow[];
  candidates: readonly Candidate[];
  dexVolumes?: ReadonlyMap<string, HomeDexVolume>;
  trackedMarkets?: TrackedMarkets;
}>;

/**
 * Which coins a {@link HomeDiscoverBase} holds: Closest to graduating reads its
 * bounded curves alone (`homeClosestCurveSources`), New its newest launches
 * (`homeNewCoinSources`); every other stage, the whole list.
 */
const baseSetOf = (stage: HomeStage) => (stage === "almost" || stage === "new" ? stage : "all");
/** Presales, and live curves traded in the window, join the whole list only: the Closest to graduating curves never hold one. */
const basePresales = (stage: HomeStage, context: HomeReadContext) => baseSetOf(stage) === "all" && Boolean(context.includePresales);

/** The key a {@link HomeDiscoverBase} is shared under: only what changes its contents. */
export function homeDiscoverBaseKey(window: HomeWindow, stage: HomeStage, context: HomeReadContext): string {
  return JSON.stringify([window, baseSetOf(stage), context.hiddenKinds, Boolean(context.includeDexVolume), Boolean(context.includeRecentBuys),
    // The facts read's prices change with these (`factsSql`).
    Boolean(context.includeLiveInputs), Boolean(context.includeRollingChange), basePresales(stage, context)]);
}

/** The window's bounds and the watermark; a missing watermark fails inside the timed step, so it logs as a failure. */
async function readBoundsAndAsOf(db: ReadableDatabase, nowMs: number): Promise<readonly [HomeBounds, NonNullable<Awaited<ReturnType<typeof readAsOf>>>]> {
  const [bounds, asOf] = await Promise.all([readHomeBounds(db, nowMs), readAsOf(db)]);
  if (!asOf) throw new SocialRouteError("service_unavailable");
  return [bounds, asOf];
}

export async function readHomeDiscoverBase(db: ReadableDatabase, window: HomeWindow, stage: HomeStage, context: HomeReadContext): Promise<HomeDiscoverBase> {
  const labels = { window, set: baseSetOf(stage), presales: basePresales(stage, context) };
  const step = readSteps("home_discover", labels);
  const [bounds, asOf] = await step("bounds", () => readBoundsAndAsOf(db, context.nowMs));
  const span = homeSpan(window, bounds);
  const kinds = visibleKinds(context.hiddenKinds);
  const tradeKinds = kinds.filter((kind) => kind === "trade_buy" || kind === "trade_sell");
  const scope: SaleScope = {
    kind: "discover",
    // Closest to graduating ranks the curves traded in the last 24 hours first, whatever the window.
    ...(baseSetOf(stage) === "almost" ? { almost: { fromMs: bounds.clockMs - HOME_WINDOW_MS["24h"], toMs: bounds.clockMs, marketCheckpoint: bounds.marketCheckpoint, kinds: tradeKinds } } : {}),
    // New's widest age: the age filter then narrows the same base (`passesFilters`).
    ...(baseSetOf(stage) === "new" ? { launched: { fromMs: bounds.clockMs - HOME_NEW_SPAN_MS } } : {}),
    ...(basePresales(stage, context) ? {
      presales: { clockMs: bounds.clockMs, fromMs: span.fromMs },
      // Live curves join Trending only once traded in the window, so the per-coin reads stay off the idle thousand (#71).
      ...(tradeKinds.length > 0 ? { curves: { fromMs: span.fromMs, toMs: span.toMs, marketCheckpoint: bounds.marketCheckpoint, kinds: tradeKinds } } : {}),
    } : {}),
  };
  const [facts, sides] = await Promise.all([
    step("facts", () => readCoinFacts(db, scope, span, context)),
    // The first scan of the window's activity (`assembleCoins` scans it again for the page's traders).
    step("sides", () => readSides(db, { span, bounds, kinds, sales: scope, actors: { kind: "everyone" } }, context.includeRecentBuys ? context.nowMs - HOME_RECENT_BUY_MS : undefined)),
  ]);
  const counts = countsOf(sides);
  // A sale not trading yet scores its commits only: a claim is a refund or a payout, never traction.
  const commits = context.includePresales ? countsOf(sides.filter((row) => row.kind === "presale_commit")) : null;
  const live = [...facts.values()]
    .map((row) => {
      const id = row.presale_id ?? row.coin_type;
      return commits && isPresaleNotTrading(row) ? saleCandidateOf(row, counts.get(id), commits.get(id), span) : candidateOf(row, counts.get(id), span);
    })
    // A fresh curve starts under the dust line, so New keeps its live curves; a sale or a graduated coin still needs the line.
    .filter((candidate) => (baseSetOf(stage) === "new" && ["live", "migration_ready"].includes(candidate.facts.curve_lifecycle ?? "")) || !isBlastDust(candidate.facts, candidate.marketCapUsd));
  const [{ candidates, markets: trackedMarkets }, dexVolumes] = await Promise.all([
    withTrackedMarket(live, context, step),
    context.includeDexVolume ? step("base_dex_volumes", () => readDexVolumes(db, onDex(live.map(({ facts }) => facts).filter((row) => !isPresaleNotTrading(row))), span.window, bounds, kinds)) : undefined,
  ]);
  // Volume (and Relevant, which weighs it) ranks by the same aggregate the cell shows.
  const scored = candidates.map((candidate) => {
    const volume = dexVolumes?.get(candidate.coinType);
    // A sale not trading yet keeps its sale score, even if its coin type has DEX volume.
    if (!volume || candidate.sale) return candidate;
    const inputs = { ...candidate.inputs, volume: Number(volume.usd ?? 0) };
    return { ...candidate, inputs, score: relevanceScore({ ...candidate, inputs }, span.window, span.toMs) };
  });
  return { asOf, bounds, span, kinds, sides, candidates: scored, dexVolumes, trackedMarkets };
}

/**
 * One Discover page (contract in `contracts/home.ts`), from a shared window
 * read when one is given. A bad cursor fails before any read starts.
 */
export async function readHomeDiscover(db: ReadableDatabase, query: HomeQuery, context: HomeReadContext, base?: () => Promise<HomeDiscoverBase>): Promise<HomeCoinsPage> {
  const cursor = query.cursor === null ? null : decodeHomeCursor(query.cursor, query.sort);
  const { asOf, bounds, span, kinds, sides, candidates, dexVolumes, trackedMarkets } = await (base ? base() : readHomeDiscoverBase(db, query.window, query.stage, context));
  const eligible = candidates.filter((candidate) => passesFilters(query, {
    participants: candidate.inputs.breadth,
    launchedMs: candidate.launchedMs,
    // A sale not trading yet has its venue already, but nothing to trade there.
    tradable: isTradable(candidate.facts),
    knownDeployer: isKnownDeployer(candidate.facts),
    listed: isListed(candidate.facts),
    progressBps: candidate.progressBps ?? null,
    nowMs: bounds.clockMs,
  }));
  const { page, nextCursor, pageNumber, pages, total, ranked } = pageOf(eligible, query.sort, cursor, query.limit, query.page);
  const coins = await readStep("home_discover", "assemble", () => assembleCoins(db, { read: "home_discover", candidates: page, sides, span, bounds, kinds, actors: { kind: "everyone" }, scope: "pool", context, dexVolumes, trackedMarkets }), { window: query.window });
  const recentBuys = context.includeRecentBuys ? recentPageBuys(sides, coins, context.includeRecentBuyUsd === true) : [];
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
  const step = readSteps("home_coins", { window });
  const [bounds, asOf] = await step("bounds", () => readBoundsAndAsOf(db, context.nowMs));
  const span = homeSpan(window, bounds);
  const kinds = visibleKinds(context.hiddenKinds);
  const scope = idsScope(presaleIds);
  const actors: ActorScope = { kind: "everyone" };
  const [facts, sides] = await Promise.all([
    step("facts", () => readCoinFacts(db, scope, span, context)),
    step("sides", () => readSides(db, { span, bounds, kinds, sales: scope, actors })),
  ]);
  const counts = countsOf(sides);
  const found = presaleIds.flatMap((id) => {
    const row = facts.get(id);
    return row ? [candidateOf(row, counts.get(id), span)] : [];
  });
  const coins = await step("assemble", () => assembleCoins(db, { read: "home_coins", candidates: found, sides, span, bounds, kinds, actors, scope: "pool", context }));
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
