import type { ReadableDatabase } from "@blast/core/modules/database/transaction.ts";
import { assertChainReadThroughViews } from "@blast/core/modules/database/modules.ts";
import { CREATE_TEST_SUI_QUOTE_TYPE } from "@blast/core/modules/social/contracts/create.ts";
import { Params } from "@blast/core/modules/social/presales/sql.ts";
import { SHOWN_PRESALES } from "@blast/core/modules/social/read-model/chain-presales.ts";
import { namedWalletsOfSql, namedWalletsSql } from "@blast/core/modules/social/read-model/naming.ts";
import { SocialRouteError } from "@blast/core/modules/social/route-kit/errors.ts";

import { HOME_ALMOST_CURVE_SOURCES, HOME_DISCOVER_COIN_SOURCES, HOME_LIST_COIN_SOURCES } from "@blast/server/modules/social/home/sources.ts";

import { HOME_KINDS, HOME_WINDOW_MS, type HomeWindow } from "@blast/core/modules/social/contracts/home.ts";

/**
 * The SQL every Home read is built from. One shape, three scopes:
 *
 * 1. `home_bounds`: the watermark's committed checkpoints and times, which bound
 *    every scan (trades by the market pipeline's checkpoint, presale kinds by
 *    the presale pipeline's) and set the chain clock the windows end at.
 * 2. `win`: the window's activity rows, a range of blast-infra's
 *    `(timestamp_ms DESC)` index, kept to the kinds asked for.
 * 3. `rows`: those rows attributed to a sale (`sale`): a row with a
 *    `presale_id` by it, a trade without one by its coin, through the shown coin sources so a hidden sale’s rows never count
 *    (T-043). Discover also includes standalone vault coin identities.
 * 4. `named` and `who`: the naming rule as a set
 *    (`read-model/naming.ts`), materialized once for the window's distinct
 *    wallets, so each row is one identity: the account that names it at the
 *    row's time, else its wallet.
 *
 * A scope narrows `rows` to one sale, to a set of sales, or to the wallets of
 * the accounts one viewer follows (the Following source, where the naming
 * rule still decides what is shown). Every statement names only
 * `chain_read_v1` views and the social tables, which
 * `assertChainReadThroughViews` guards.
 */

type BoundsRow = {
  market_checkpoint: string | null;
  market_timestamp_ms: string | null;
  presale_checkpoint: string | null;
  presale_timestamp_ms: string | null;
  has_dex_volume: boolean;
  has_tracked_dex_volume: boolean;
};

const BOUNDS_SQL = `SELECT market_checkpoint, market_timestamp_ms, presale_checkpoint, presale_timestamp_ms,
  to_regclass('chain_read_v1.dex_swap_volume') IS NOT NULL
    AND to_regclass('chain_read_v1.dex_swap_volume_coverage') IS NOT NULL AS has_dex_volume,
  to_regclass('chain_read_v1.dex_swap_volume_tracked_coverage') IS NOT NULL AS has_tracked_dex_volume
FROM chain_read_v1.watermark`;
assertChainReadThroughViews(BOUNDS_SQL);

export type HomeBounds = Readonly<{
  presaleCheckpoint: number;
  marketCheckpoint: number;
  /** The chain clock the windows end at: the later committed pipeline time, never past the server's clock. */
  clockMs: number;
  /** DEX volume ends at the market pipeline's time once its projection exists on the replica. */
  dexClockMs?: number;
  hasTrackedDexVolume?: boolean;
}>;

/** The watermark's bounds, or `service_unavailable` when a pipeline has committed nothing readable. */
export async function readHomeBounds(db: ReadableDatabase, nowMs: number): Promise<HomeBounds> {
  const row = (await db.read<BoundsRow>(BOUNDS_SQL)).rows[0];
  if (!row || row.presale_checkpoint === null || row.presale_timestamp_ms === null || row.market_checkpoint === null) {
    throw new SocialRouteError("service_unavailable");
  }
  const presaleMs = Number(row.presale_timestamp_ms);
  const marketMs = row.market_timestamp_ms === null ? presaleMs : Number(row.market_timestamp_ms);
  return {
    presaleCheckpoint: Number(row.presale_checkpoint),
    marketCheckpoint: Number(row.market_checkpoint),
    clockMs: Math.min(nowMs, Math.max(presaleMs, marketMs)),
    ...(row.has_dex_volume && row.market_timestamp_ms !== null ? {
      dexClockMs: Math.min(nowMs, marketMs),
      hasTrackedDexVolume: row.has_tracked_dex_volume,
    } : {}),
  };
}

/** The window a read scans: `(fromMs, toMs]`. */
export type HomeSpan = Readonly<{ window: HomeWindow; fromMs: number; toMs: number }>;

export function homeSpan(window: HomeWindow, bounds: HomeBounds): HomeSpan {
  return { window, fromMs: bounds.clockMs - HOME_WINDOW_MS[window], toMs: bounds.clockMs };
}

/**
 * Which markets a read attributes: public Discover (`almost`: only its
 * Almost graduated curves, `HOME_ALMOST_CURVE_SOURCES`), all shown sales, or
 * specific markets. Discover's `presales` (Trending with `presales=1`) adds
 * the presales not trading yet, bounded at the chain clock (`presaleScopeSql`).
 */
export type SaleScope =
  | Readonly<{ kind: "discover"; almost?: boolean; presales?: Readonly<{ clockMs: number; fromMs: number }> }>
  | Readonly<{ kind: "all" }>
  | Readonly<{ kind: "ids"; presaleIds: readonly string[]; includeStandalone?: boolean }>;

/** Whose rows a read keeps: everyone, or the wallets the naming rule names for a set of accounts (a viewer's follows). */
export type ActorScope =
  | Readonly<{ kind: "everyone" }>
  | Readonly<{ kind: "followed"; viewerAccountId: string }>;

export type RowsRequest = Readonly<{
  span: HomeSpan;
  bounds: HomeBounds;
  kinds: readonly string[];
  sales: SaleScope;
  actors: ActorScope;
}>;

/** How far ahead a scheduled sale joins Trending: far enough not to miss one, near enough to bound spam. */
export const HOME_UPCOMING_SALE_MS = 30 * 86_400_000;

/** Savers per sale (migration 0168): counts only, accounts with a verified X link. */
export const PRESALE_SAVERS = "social_presale_savers";

/**
 * The presales not trading yet that Trending lists (never cancelled; the
 * caller keeps test-SUI quotes out): a scheduled sale opening within
 * `HOME_UPCOMING_SALE_MS`; a Pending (unscheduled) one only once someone
 * saved it, since creating a sale is free; a live one; and one that ended or
 * was funded inside the window, whose last commits are still traction.
 */
function presaleScopeSql(alias: string, presales: Readonly<{ clockMs: number; fromMs: number }>, params: Params): string {
  const now = `${params.add(presales.clockMs)}::bigint`;
  const from = `${params.add(presales.fromMs)}::bigint`;
  return `(${alias}.presale_id IS NOT NULL AND (
        (${alias}.lifecycle = 'open' AND ${alias}.start_ms > ${now} AND ${alias}.start_ms <= ${now} + ${HOME_UPCOMING_SALE_MS})
        OR (${alias}.lifecycle = 'pending' AND EXISTS (SELECT 1 FROM ${PRESALE_SAVERS} sv WHERE sv.presale_id = ${alias}.presale_id))
        OR (${alias}.lifecycle IN ('open', 'funded') AND ${alias}.start_ms <= ${now} AND ${alias}.end_ms > ${from})))`;
}

export function scopedHomeCoinsSql(scope: SaleScope, params: Params): string {
  if (scope.kind === "discover") {
    const listed = scope.presales ? `(p.lifecycle = 'migrated' OR ${presaleScopeSql("p", scope.presales, params)})` : "p.lifecycle = 'migrated'";
    return `(SELECT p.* FROM ${scope.almost ? HOME_ALMOST_CURVE_SOURCES : HOME_DISCOVER_COIN_SOURCES} p
      WHERE ${listed} AND p.quote_type IS DISTINCT FROM ${params.add(CREATE_TEST_SUI_QUOTE_TYPE)}::text)`;
  }
  const sales = `(SELECT p.presale_id AS source_id,p.*,FALSE AS tracked_pool_only FROM ${SHOWN_PRESALES} p)`;
  if (scope.kind === "all") {
    return sales;
  }
  const source = scope.includeStandalone ? HOME_LIST_COIN_SOURCES : sales;
  return `(SELECT p.* FROM ${source} p WHERE p.source_id = ANY(${params.add([...new Set(scope.presaleIds)])}::text[]))`;
}

/**
 * The `WITH` prefix every statement starts from: `home_sales`, `home_window`,
 * `home_rows`, `home_named`, `home_who` (prefixed: the chain-view guard
 * refuses a relation named like a blast-infra table, `coins` or `trades`).
 * Columns of `home_who`: the activity row's, plus `sale` (the
 * presale id or standalone coin type), `account_id` (null when unnamed) and `who` (`a:<account id>`
 * or `w:<wallet>`), with the sale's quote and decimals beside it.
 */
export function rowsWithSql(request: RowsRequest, params: Params): string {
  const { span, bounds, kinds, sales, actors } = request;
  const from = params.add(span.fromMs);
  const to = params.add(span.toMs);
  const kindList = params.add([...kinds]);
  const presaleCp = params.add(bounds.presaleCheckpoint);
  const marketCp = params.add(bounds.marketCheckpoint);
  const followed = actors.kind === "followed"
    ? `home_followed AS (SELECT f.target_id::uuid AS account_id FROM social_follows f
      WHERE f.follower_account_id = ${params.add(actors.viewerAccountId)}::uuid AND f.target_kind = 'account'),
    home_named AS MATERIALIZED (${namedWalletsSql("named_account.account_id IN (SELECT fw.account_id FROM home_followed fw)")}),`
    : "";
  const winJoin = actors.kind === "followed"
    ? `JOIN home_named nw ON nw.address = a.actor AND nw.named_from_ms <= a.timestamp_ms`
    : "";
  const namedAfter = actors.kind === "everyone"
    ? `home_named AS MATERIALIZED (${namedWalletsOfSql("ARRAY(SELECT DISTINCT r.actor FROM home_rows r)")}),`
    : "";
  const source = scopedHomeCoinsSql(sales, params);
  // A few curves, all without a sale: their own rows through the coin index, not the whole window.
  const fewCoins = sales.kind === "discover" && sales.almost ? "AND a.coin_type IN (SELECT hs.coin_type FROM home_sales hs)" : "";
  return `WITH home_sales AS (
    SELECT p.source_id, p.presale_id, p.sale_token AS coin_type, p.quote_type, p.quote_symbol, p.quote_decimals, p.sale_decimals
    FROM ${source} p
  ),
  ${followed}
  home_window AS (
    SELECT a.activity_id, a.checkpoint, a.tx_slot, a.event_slot, a.part, a.kind, a.timestamp_ms, a.digest, a.actor,
      a.presale_id, a.coin_type, a.quote_type, a.quote_amount, a.coin_amount, a.quote_refund, a.usd_value, a.market_cap_usd
    FROM chain_read_v1.activity a
    ${winJoin}
    WHERE a.timestamp_ms > ${from}::bigint AND a.timestamp_ms <= ${to}::bigint
      AND a.kind = ANY(${kindList}::text[])
      AND a.checkpoint <= CASE WHEN a.kind IN ('presale_commit', 'presale_claim') THEN ${presaleCp}::bigint ELSE ${marketCp}::bigint END
      ${fewCoins}
  ),
  home_rows AS (
    SELECT c.source_id AS sale, c.coin_type AS sale_coin, c.quote_type AS sale_quote, c.quote_symbol AS sale_quote_symbol,
      c.quote_decimals AS sale_quote_decimals, c.sale_decimals, w.*
    FROM home_window w JOIN home_sales c ON c.presale_id = w.presale_id
    UNION ALL
    SELECT c.source_id, c.coin_type, c.quote_type, c.quote_symbol, c.quote_decimals, c.sale_decimals, w.*
    FROM home_window w JOIN home_sales c ON c.coin_type = w.coin_type WHERE w.presale_id IS NULL
  ),
  ${namedAfter}
  home_who AS (
    SELECT r.*, n.account_id,
      CASE WHEN n.account_id IS NULL THEN 'w:' || r.actor ELSE 'a:' || n.account_id::text END AS who
    FROM home_rows r
    LEFT JOIN home_named n ON n.address = r.actor AND n.named_from_ms <= r.timestamp_ms
  )`;
}

/**
 * A statement over the prefix as the read-only database accepts it: it
 * admits `SELECT` statements only, so the `WITH` chain is wrapped as a
 * derived table (as the feed's backers read is).
 */
export function selectHome(withPrefix: string, body: string): string {
  return `SELECT home_result.* FROM (${withPrefix}
  ${body}) AS home_result`;
}

/** The keyset order of activity rows, newest first. */
export const ROW_ORDER = (alias: string) =>
  `${alias}.timestamp_ms DESC, ${alias}.checkpoint DESC, ${alias}.tx_slot DESC, ${alias}.event_slot DESC, ${alias}.part DESC`;

/** One (sale, who, kind, quote asset) sum, as `sidesSql` yields it. */
export type SideRow = Readonly<{
  sale: string;
  who: string;
  kind: string;
  quote_type: string;
  sale_quote: string;
  sale_quote_symbol: string;
  sale_quote_decimals: number;
  n: string;
  atoms: string;
  usd: string | null;
  unpriced: string;
  tokens: string | null;
  latest_ms: string;
  recent_buy?: readonly [string, string, string, string, string, string, string | null] | null;
}>;

/** Per (sale, who, kind, quote asset): count, exact atoms, priced USD, unpriced rows, tokens and the latest time. */
export const sidesSelect = (extraColumns = "") => `SELECT w.sale, w.who, w.kind, w.quote_type, w.sale_quote, w.sale_quote_symbol, w.sale_quote_decimals,
      count(*)::text AS n, coalesce(sum(w.quote_amount), 0)::text AS atoms, sum(w.usd_value)::text AS usd,
      count(*) FILTER (WHERE w.usd_value IS NULL)::text AS unpriced,
      sum(w.coin_amount)::text AS tokens, max(w.timestamp_ms)::text AS latest_ms${extraColumns}
    FROM home_who w`;

/** The grouping of the sides read. */
export const SIDES_GROUP = `GROUP BY w.sale, w.who, w.kind, w.quote_type, w.sale_quote, w.sale_quote_symbol, w.sale_quote_decimals`;

/** One grouped participant, as `groupedSql` yields it. */
export type GroupedRow = Readonly<{
  sale: string;
  who: string;
  account_id: string | null;
  wallet: string;
  events_total: string;
  latest_ms: string;
  latest_kind: string;
}>;

/** Per (sale, who): the wallet, the event count, the latest time and the kind of the latest row. */
export const GROUPED_SELECT = `SELECT w.sale, w.who, w.account_id, min(w.actor) AS wallet, count(*)::text AS events_total,
      max(w.timestamp_ms)::text AS latest_ms,
      (array_agg(w.kind ORDER BY ${ROW_ORDER("w")}))[1] AS latest_kind
    FROM home_who w`;

/** The `GROUP BY` of `GROUPED_SELECT`. */
export const GROUPED_GROUP = `GROUP BY w.sale, w.who, w.account_id`;

const WHY_KEY = (n: number) => `CASE WHEN w.entry_id ~ '^a:[0-9]{1,18}:[0-9]{1,10}:[0-9]{1,10}:[0-9]{1,10}$' THEN split_part(w.entry_id, ':', ${n}) END`;

/**
 * Every active why with the sale it is about: the why's own `presale_id`
 * (the trigger copies the activity row's), or, for a why on a trade whose
 * row carries no sale (before T-038 stamped them), the shown sale whose coin
 * the trade's row names (one key lookup of the activity row, only for those
 * whys). Columns: `why_id`, `author_account_id`, `created_at`, `entry_id`,
 * `sale`. Filter with `${WHY_SALE_FILTER}` conditions on `w` before the
 * outer `sale` condition, so the index on `(presale_id, entry_id)` serves the
 * stamped whys.
 */
export function whySalesSql(whereOnWhys: string): string {
  return `SELECT w.why_id, w.author_account_id, w.created_at, w.entry_id, coalesce(w.presale_id, s.presale_id) AS sale
    FROM social_whys w
    LEFT JOIN LATERAL (
      SELECT a.coin_type FROM chain_read_v1.activity a
      WHERE w.presale_id IS NULL
        AND a.checkpoint = (${WHY_KEY(2)})::bigint AND a.tx_slot = (${WHY_KEY(3)})::bigint
        AND a.event_slot = (${WHY_KEY(4)})::bigint AND a.part = (${WHY_KEY(5)})::bigint
    ) a ON TRUE
    LEFT JOIN ${SHOWN_PRESALES} s ON w.presale_id IS NULL AND s.sale_token = a.coin_type
    WHERE w.state = 'active' AND ${whereOnWhys}`;
}

/** The kinds a read scans by default: all four. */
export const ALL_KINDS: readonly string[] = HOME_KINDS;

/** The kinds left after hiding some (the trade kinds while trading is hidden, OA-7). */
export function visibleKinds(hiddenKinds: readonly string[]): readonly string[] {
  const hidden = new Set(hiddenKinds);
  return ALL_KINDS.filter((kind) => !hidden.has(kind));
}

export { Params };
