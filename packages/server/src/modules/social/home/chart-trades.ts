import { z } from "zod";

import { assertChainReadThroughViews } from "@blast/core/modules/database/modules.ts";
import type { ReadableDatabase } from "@blast/core/modules/database/transaction.ts";
import {
  HOME_BIG_TRADE_USD,
  HOME_CHART_TRADES_MAX,
  HOME_CHART_TRADES_SPAN_MS,
  type HomeChartTrade,
  type HomeChartTradesPage,
} from "@blast/core/modules/social/contracts/coin-market.ts";
import { namedWalletsOfSql } from "@blast/core/modules/social/read-model/naming.ts";
import { SocialRouteError } from "@blast/core/modules/social/route-kit/errors.ts";
import { socialParameter } from "@blast/server/modules/social/route-kit/validation.ts";

import { actorOf } from "@blast/server/modules/social/home/aggregate.ts";
import { readPeople } from "@blast/server/modules/social/home/coins.ts";
import { parseMarketCoin } from "@blast/server/modules/social/home/market.ts";
import { HOME_COIN_SOURCES } from "@blast/server/modules/social/home/sources.ts";
import { readHomeBounds, visibleKinds } from "@blast/server/modules/social/home/sql.ts";
import { readAsOf } from "@blast/server/modules/social/items/as-of.ts";

/**
 * Redesign gap 7: the chart's trade overlays (`HomeChartTradesPage`,
 * `contracts/coin-market.ts`). "Big trades" are the coin's trades of at
 * least `min_usd` in the chart's span; "My swaps" are the viewer's own trades
 * of the coin from every wallet linked to the account. Both are one range of
 * blast-infra's `activity` indexes, bounded by the span (at most
 * `HOME_CHART_TRADES_SPAN_MS`), the market pipeline's checkpoint and the
 * chain clock, newest first, at most `HOME_CHART_TRADES_MAX`. Each actor is
 * named by the naming rule at its trade's time (`read-model/naming.ts`).
 */

const TRADE_KINDS = ["trade_buy", "trade_sell"] as const;
const MS = z.string().regex(/^(0|[1-9][0-9]{0,15})$/).transform(Number);

export type ChartTradesQuery = Readonly<{ coinType: string; fromMs: number; toMs: number; minUsd: number }>;

function single(params: URLSearchParams, name: string): string | null {
  const values = params.getAll(name);
  if (values.length > 1) throw new SocialRouteError("invalid_parameter", { extra: { parameter: name } });
  return values[0] ?? null;
}

/**
 * `coin`, `from_ms` and `to_ms` (the span, at most 30 days, `from_ms < to_ms`), and for big trades
 * `min_usd` (at least `HOME_BIG_TRADE_USD`); the viewer's own trades (`mine`) keep every trade and refuse it.
 */
export function parseChartTradesQuery(params: URLSearchParams, mine = false): ChartTradesQuery {
  const coinType = parseMarketCoin(params);
  const fromMs = socialParameter(MS, single(params, "from_ms"), "from_ms");
  const toMs = socialParameter(MS, single(params, "to_ms"), "to_ms");
  if (toMs <= fromMs || toMs - fromMs > HOME_CHART_TRADES_SPAN_MS) throw new SocialRouteError("invalid_parameter", { extra: { parameter: "from_ms" } });
  const rawMin = single(params, "min_usd");
  if (mine && rawMin !== null) throw new SocialRouteError("invalid_parameter", { extra: { parameter: "min_usd" } });
  const minUsd = rawMin === null ? HOME_BIG_TRADE_USD
    : socialParameter(z.string().regex(/^[1-9][0-9]{0,8}$/).transform(Number).pipe(z.number().min(HOME_BIG_TRADE_USD)), rawMin, "min_usd");
  return { coinType, fromMs, toMs, minUsd };
}

/**
 * $1 coin type, $2 from (exclusive), $3 to (inclusive), $4 the market
 * checkpoint, $5 the visible trade kinds, $6 the filter's value (the
 * smallest USD, or the wallets), $7 rows to read. One statement per filter,
 * so each plans for its own index: the coin's time range for big trades,
 * each wallet's for the viewer's own.
 */
function chartTradesSql(filter: string): string {
  return `SELECT t.* FROM (
  WITH chart_trades AS MATERIALIZED (
    SELECT a.checkpoint, a.tx_slot, a.event_slot, a.part, a.digest, a.timestamp_ms, a.kind, a.actor,
      a.coin_amount, a.quote_amount, a.usd_value
    FROM chain_read_v1.activity a
    WHERE a.coin_type = $1 AND a.timestamp_ms > $2::bigint AND a.timestamp_ms <= $3::bigint
      AND a.kind = ANY($5::text[]) AND a.checkpoint <= $4::bigint
      AND ${filter}
    ORDER BY a.timestamp_ms DESC, a.checkpoint DESC, a.tx_slot DESC, a.event_slot DESC, a.part DESC
    LIMIT $7::int
  ), chart_named AS MATERIALIZED (
    ${namedWalletsOfSql("ARRAY(SELECT DISTINCT c.actor FROM chart_trades c)")}
  )
  SELECT c.checkpoint::text AS checkpoint, c.tx_slot::text AS tx_slot, c.event_slot::text AS event_slot, c.part::text AS part,
    c.digest, c.timestamp_ms::text AS timestamp_ms, c.kind, c.actor, c.coin_amount::text AS coin_amount,
    c.quote_amount::text AS quote_amount, round(c.usd_value, 2)::text AS usd,
    (SELECT n.account_id::text FROM chart_named n WHERE n.address = c.actor AND n.named_from_ms <= c.timestamp_ms LIMIT 1) AS account_id
  FROM chart_trades c
) t
ORDER BY t.timestamp_ms::bigint DESC, t.checkpoint::bigint DESC, t.tx_slot::bigint DESC, t.event_slot::bigint DESC, t.part::bigint DESC`;
}

export const BIG_TRADES_SQL = chartTradesSql("a.usd_value >= $6::numeric");
export const MY_TRADES_SQL = chartTradesSql("a.actor = ANY($6::text[])");
assertChainReadThroughViews(BIG_TRADES_SQL);
assertChainReadThroughViews(MY_TRADES_SQL);

const KNOWN_COIN_SQL = `SELECT 1 FROM ${HOME_COIN_SOURCES} c WHERE c.sale_token = $1 LIMIT 1`;
assertChainReadThroughViews(KNOWN_COIN_SQL);

type ChartRow = Readonly<{
  checkpoint: string;
  tx_slot: string;
  event_slot: string;
  part: string;
  digest: string;
  timestamp_ms: string;
  kind: string;
  actor: string;
  coin_amount: string | null;
  quote_amount: string | null;
  usd: string | null;
  account_id: string | null;
}>;

export type ChartTradesContext = Readonly<{ nowMs: number; hiddenKinds: readonly string[] }>;

/**
 * The span's trades of the coin: big trades when `wallets` is null (at least
 * `minUsd`), else every trade of those wallets (the viewer's own). `not_found`
 * when no shown sale or standalone vault trades the coin.
 */
export async function readChartTrades(
  db: ReadableDatabase,
  query: ChartTradesQuery,
  wallets: readonly string[] | null,
  context: ChartTradesContext,
): Promise<HomeChartTradesPage> {
  const [bounds, asOf, known] = await Promise.all([readHomeBounds(db, context.nowMs), readAsOf(db), db.read(KNOWN_COIN_SQL, [query.coinType])]);
  if (!asOf) throw new SocialRouteError("service_unavailable");
  if (known.rows.length === 0) throw new SocialRouteError("not_found");
  const toMs = Math.min(query.toMs, bounds.clockMs);
  const kinds = visibleKinds(context.hiddenKinds).filter((kind) => (TRADE_KINDS as readonly string[]).includes(kind));
  const mine = wallets !== null;
  const empty = (truncated = false): HomeChartTradesPage => ({ coin_type: query.coinType, from_ms: query.fromMs, to_ms: toMs, min_usd: mine ? null : query.minUsd, trades: [], truncated, as_of: asOf });
  if (toMs <= query.fromMs || kinds.length === 0 || (mine && wallets.length === 0)) return empty();
  const { rows } = await db.read<ChartRow>(mine ? MY_TRADES_SQL : BIG_TRADES_SQL, [
    query.coinType, query.fromMs, toMs, bounds.marketCheckpoint, kinds,
    mine ? [...new Set(wallets)] : String(query.minUsd), HOME_CHART_TRADES_MAX + 1,
  ]);
  const kept = rows.slice(0, HOME_CHART_TRADES_MAX);
  const people = await readPeople(db, kept.flatMap((row) => (row.account_id === null ? [] : [row.account_id])));
  const trades = kept.map((row): HomeChartTrade => ({
    entry_id: `a:${row.checkpoint}:${row.tx_slot}:${row.event_slot}:${row.part}`,
    digest: row.digest,
    timestamp_ms: Number(row.timestamp_ms),
    side: row.kind === "trade_buy" ? "buy" : "sell",
    coin_atoms: row.coin_amount ?? "0",
    quote_atoms: row.quote_amount ?? "0",
    usd: row.usd,
    actor: actorOf({ account_id: row.account_id, wallet: row.actor }, people.identities),
  }));
  return { ...empty(rows.length > HOME_CHART_TRADES_MAX), trades };
}
