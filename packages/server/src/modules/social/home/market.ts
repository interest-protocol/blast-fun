import { tinyTradeSql } from "@blast/core/modules/social/read-model/trade-size.ts";
import { isValidStructTag, normalizeStructTag } from "@mysten/sui/utils";
import { z } from "zod";

import { assertChainReadThroughViews } from "@blast/core/modules/database/modules.ts";
import type { ReadableDatabase } from "@blast/core/modules/database/transaction.ts";
import type { PresaleTermsReader } from "@blast/core/modules/presale/terms/index.ts";
import {
  HOME_MARKET_WINDOWS,
  HOME_MARKET_WINDOW_MS,
  type HomeCoinMarket,
  type HomeMarketWindow,
  type HomeMarketWindowName,
} from "@blast/core/modules/social/contracts/coin-market.ts";
import { changeBps } from "@blast/core/modules/social/prices/change.ts";
import { displayPriceOf } from "@blast/core/modules/social/prices/test-sui.ts";
import { SocialRouteError } from "@blast/core/modules/social/route-kit/errors.ts";
import { socialParameter } from "@blast/server/modules/social/route-kit/validation.ts";

import { observedHomePrice } from "@blast/server/modules/social/home/coins.ts";
import { fdvOf, outstandingSaleTokensSql, presaleTotalSupply, supplyOf } from "@blast/server/modules/social/home/fdv.ts";
import { HOME_COIN_SOURCES } from "@blast/server/modules/social/home/sources.ts";
import { readHomeBounds, visibleKinds } from "@blast/server/modules/social/home/sql.ts";
import { readAsOf } from "@blast/server/modules/social/items/as-of.ts";
import { rollingPriceAtSql } from "@blast/server/modules/social/prices/price-at.ts";

/**
 * Redesign gaps 1, 2, 8 and 10: one coin's market (`HomeCoinMarket`,
 * `contracts/coin-market.ts`) in two statements on the replica, read at once.
 *
 * - **Pressure** (`MARKET_TRADES_SQL`). The coin's trades of the last 24
 *   hours, one range of blast-infra's `activity (coin_type, timestamp_ms
 *   DESC)` index bounded by the market pipeline's checkpoint, each placed in
 *   the band of the shortest window that holds it (`5m`, then the rest of
 *   `1h`, of `4h`, of `24h`). Grouped by side and band: counts, exact quote
 *   atoms and priced USD; and each wallet once per side, in the band of its
 *   latest trade. A window is the sum of its bands and the shorter ones, so a
 *   wallet counts in every window that holds one of its trades. At launch
 *   scale's hot coin (60,000 trades in its day) this replaced 40 `FILTER`
 *   aggregates, eight of them `count(DISTINCT …)`.
 * - **Moves** (`MARKET_COIN_SQL`). Every window opens at the last price at or
 *   before its start (the native baseline, with the 5-minute history as its
 *   fallback), as Home's coin list does.
 * - **Supply.** The sale's indexed currency supply (or its cached terms for
 *   fixed supply), less what its vesting schedules still hold: every
 *   `sale_token` schedule's `total − claimed`. What is left circulates. A
 *   curve coin (no sale) takes its total and live supply from `chain_read_v1.coins`.
 * - **Liquidity.** The coin's pool reserves (`chain_read_v1.pool_reserves`,
 *   one row per coin: the pool's latest, which blast-infra commits with the
 *   market watermark, so it is never past it and is not bounded by it, which
 *   would hide it rather than rewind it) at the coin's price and its quote's,
 *   both as Home shows prices (`observedHomePrice`).
 */

const DAY_MS = HOME_MARKET_WINDOW_MS["24h"];
const TRADE_KINDS = ["trade_buy", "trade_sell"] as const;

const coinSchema = z.string().max(512).refine(isValidStructTag).transform((value) => normalizeStructTag(value));

/** The `coin` parameter, once, as a canonical coin type, or `invalid_parameter`. */
export function parseMarketCoin(params: URLSearchParams): string {
  const values = params.getAll("coin");
  return socialParameter(coinSchema, values.length === 1 ? values[0] : null, "coin");
}

/** Each window opens at the last price at or before its start, however long the coin was quiet before it. */
function openJoin(index: number, ms: number): string {
  return `LEFT JOIN LATERAL (${rollingPriceAtSql("c.sale_token", `$2::bigint - ${ms}`)}) open_${index} ON TRUE`;
}

/**
 * $1 coin type, $2 the chain clock: the coin, its price and its quote's, each
 * window's opening price, what vesting holds and its pool's reserves.
 */
export const MARKET_COIN_SQL = `SELECT c.presale_id, c.sale_token AS coin_type, c.sale_decimals::int AS sale_decimals,
    c.quote_type, c.quote_symbol, c.quote_decimals::int AS quote_decimals,
    trim_scale(pr.usd_price)::text AS price_usd, pr.as_of_ms::text AS price_as_of_ms,
    trim_scale(qp.usd_price)::text AS quote_price_usd, qp.as_of_ms::text AS quote_price_as_of_ms,
    reserves.pool_id, reserves.venue, reserves.coin_reserve, reserves.quote_reserve, reserves.reserves_as_of_ms,
    ${HOME_MARKET_WINDOWS.map((_, index) => `trim_scale(open_${index}.usd_price)::text AS open_usd_${index}, open_${index}.as_of_ms::text AS open_as_of_ms_${index}`).join(",\n    ")},
    escrow.escrowed, cs.supply::text AS supply, coalesce(cs.total_supply, ps.total_supply)::text AS total_supply
  FROM ${HOME_COIN_SOURCES} c
  LEFT JOIN chain_read_v1.coins cs ON c.presale_id IS NULL AND cs.coin_type = c.sale_token
  LEFT JOIN chain_read_v1.presale_coin_supply ps ON c.presale_id IS NOT NULL AND ps.coin_type = c.sale_token
  LEFT JOIN ${displayPriceOf("c.sale_token")} pr ON TRUE
  LEFT JOIN ${displayPriceOf("c.quote_type")} qp ON TRUE
  ${HOME_MARKET_WINDOWS.map((name, index) => openJoin(index, HOME_MARKET_WINDOW_MS[name])).join("\n  ")}
  LEFT JOIN LATERAL (
    ${outstandingSaleTokensSql("c.presale_id")}
  ) escrow ON c.presale_id IS NOT NULL
  LEFT JOIN LATERAL (
    SELECT r.pool_id, r.venue, r.coin_reserve::text AS coin_reserve, r.quote_reserve::text AS quote_reserve,
      r.timestamp_ms::text AS reserves_as_of_ms
    FROM chain_read_v1.pool_reserves r
    WHERE r.coin_type = c.sale_token AND r.quote_type = c.quote_type
    LIMIT 1
  ) reserves ON TRUE
  WHERE c.sale_token = $1
  LIMIT 1`;
assertChainReadThroughViews(MARKET_COIN_SQL);

/** A trade's band: the index of the shortest window that holds it. */
const BAND_SQL = `CASE ${HOME_MARKET_WINDOWS.slice(0, -1).map((name, index) => `WHEN a.timestamp_ms > $2::bigint - ${HOME_MARKET_WINDOW_MS[name]} THEN ${index}`).join(" ")} ELSE ${HOME_MARKET_WINDOWS.length - 1} END`;

/**
 * $1 coin type, $2 the chain clock, $3 the market pipeline's checkpoint, $4
 * the visible trade kinds: per side and band, the trades (`trades` rows) and
 * the wallets whose latest trade on that side falls in it (`wallets` rows).
 */
export const MARKET_TRADES_SQL = `SELECT t.* FROM (
  WITH market_day AS MATERIALIZED (
    SELECT a.actor, a.kind, a.quote_amount, a.usd_value, ${BAND_SQL} AS band, ${tinyTradeSql("a")} AS tiny
    FROM chain_read_v1.activity a
    WHERE a.coin_type = $1 AND a.timestamp_ms > $2::bigint - ${DAY_MS} AND a.timestamp_ms <= $2::bigint
      AND a.kind = ANY($4::text[]) AND a.checkpoint <= $3::bigint
  )
  SELECT 'trades' AS part, d.kind, d.band, count(*) FILTER (WHERE NOT d.tiny)::int AS n, coalesce(sum(d.quote_amount), 0)::text AS atoms,
    sum(d.usd_value)::text AS usd, count(*) FILTER (WHERE d.usd_value IS NULL AND NOT d.tiny)::int AS unpriced
  FROM market_day d GROUP BY d.kind, d.band
  UNION ALL
  SELECT 'wallets', w.kind, w.band, count(*)::int, '0', NULL, 0
  FROM (SELECT d.kind, d.actor, min(d.band) AS band FROM market_day d WHERE NOT d.tiny GROUP BY d.kind, d.actor) w
  GROUP BY w.kind, w.band
) t`;
assertChainReadThroughViews(MARKET_TRADES_SQL);

type CoinRow = Readonly<Record<string, string | number | null>> & Readonly<{
  presale_id: string | null;
  coin_type: string;
  sale_decimals: number;
  quote_type: string;
  quote_symbol: string;
  quote_decimals: number;
  price_usd: string | null;
  price_as_of_ms: string | null;
  quote_price_usd: string | null;
  quote_price_as_of_ms: string | null;
  pool_id: string | null;
  venue: string | null;
  coin_reserve: string | null;
  quote_reserve: string | null;
  reserves_as_of_ms: string | null;
  escrowed: string | null;
  supply: string | null;
  total_supply: string | null;
}>;

type BandRow = Readonly<{ part: "trades" | "wallets"; kind: string; band: number; n: number; atoms: string; usd: string | null; unpriced: number }>;

const DECIMAL = /^(-?)(\d+)(?:\.(\d+))?$/;

/** `a − b` of two decimal strings, exact, trailing zeros dropped (`"-0.0137"`); null for anything malformed. */
export function decimalDifference(a: string | null, b: string | null): string | null {
  if (a === null || b === null) return null;
  const left = DECIMAL.exec(a);
  const right = DECIMAL.exec(b);
  if (!left || !right) return null;
  const scale = Math.max((left[3] ?? "").length, (right[3] ?? "").length);
  const scaled = (match: RegExpExecArray) => {
    const digits = BigInt(match[2]! + (match[3] ?? "").padEnd(scale, "0"));
    return match[1] === "-" ? -digits : digits;
  };
  const difference = scaled(left) - scaled(right);
  const magnitude = (difference < 0n ? -difference : difference).toString().padStart(scale + 1, "0");
  const whole = magnitude.slice(0, magnitude.length - scale);
  const fraction = magnitude.slice(magnitude.length - scale).replace(/0+$/, "");
  const sign = difference < 0n ? "-" : "";
  return `${sign}${whole}${fraction ? `.${fraction}` : ""}`;
}

const USD_PLACES = 18;
const UNSIGNED = /^(\d+)(?:\.(\d+))?$/;

/** A non-negative decimal as an integer of 10⁻¹⁸ dollars (blast-infra's `usd_value` precision); 0 for null. */
function usdUnits(value: string | null): bigint {
  const match = value === null ? null : UNSIGNED.exec(value);
  if (!match) return 0n;
  const fraction = match[2] ?? "";
  const kept = BigInt(match[1]! + fraction.slice(0, USD_PLACES).padEnd(USD_PLACES, "0"));
  return (fraction[USD_PLACES] ?? "0") >= "5" ? kept + 1n : kept;
}

/** 10⁻¹⁸ dollars as two places, half up (as `round(…, 2)` rounds a positive amount). */
function centsText(units: bigint): string {
  const cent = 10n ** BigInt(USD_PLACES - 2);
  const text = ((units + cent / 2n) / cent).toString().padStart(3, "0");
  return `${text.slice(0, -2)}.${text.slice(-2)}`;
}

/** One side of a window from the bands it covers (`band <= index`). */
function sideOf(rows: readonly BandRow[], kind: string, index: number) {
  let trades = 0, unpriced = 0, wallets = 0, atoms = 0n, usd = 0n, priced = false;
  for (const row of rows) {
    if (row.kind !== kind || row.band > index) continue;
    if (row.part === "wallets") {
      wallets += row.n;
      continue;
    }
    trades += row.n;
    unpriced += row.unpriced;
    atoms += BigInt(row.atoms);
    usd += usdUnits(row.usd);
    if (row.usd !== null) priced = true;
  }
  // `trades` skips tiny trades and the sums keep them, so a priced amount is known by its rows, not by the count.
  return { trades, unpriced, wallets, atoms: atoms.toString(), usd: priced ? centsText(usd) : null };
}

function windowOf(row: CoinRow, bands: readonly BandRow[], index: number, name: HomeMarketWindowName, clockMs: number): HomeMarketWindow {
  const open = (row[`open_usd_${index}`] ?? null) as string | null;
  const openAsOf = (row[`open_as_of_ms_${index}`] ?? null) as string | null;
  const buys = sideOf(bands, "trade_buy", index);
  const sells = sideOf(bands, "trade_sell", index);
  return {
    from_ms: clockMs - HOME_MARKET_WINDOW_MS[name],
    to_ms: clockMs,
    open_usd: open,
    open_as_of_ms: openAsOf === null ? null : Number(openAsOf),
    change_bps: changeBps(row.price_usd, open),
    change_usd: decimalDifference(row.price_usd, open),
    buys: buys.trades,
    sells: sells.trades,
    bought_atoms: buys.atoms,
    sold_atoms: sells.atoms,
    bought_usd: buys.usd,
    sold_usd: sells.usd,
    unpriced_buys: buys.unpriced,
    unpriced_sells: sells.unpriced,
    buyers: buys.wallets,
    sellers: sells.wallets,
  };
}

const ATOMS = /^(0|[1-9][0-9]*)$/;

const PRICE = /^(0|[1-9][0-9]*)(?:\.([0-9]+))?$/;

/**
 * The USD value of each `[atoms, price, decimals]` side, summed exactly, to
 * two places, half up: `Σ atoms × price ÷ 10^decimals`. Null when a side is
 * unpriced or malformed.
 */
export function usdOfSides(sides: readonly (readonly [string | null, string | null, number])[]): string | null {
  const terms: { numerator: bigint; scale: number }[] = [];
  for (const [atoms, price, decimals] of sides) {
    if (atoms === null || !ATOMS.test(atoms) || price === null || !Number.isInteger(decimals) || decimals < 0) return null;
    const match = PRICE.exec(price);
    if (!match) return null;
    const fraction = match[2] ?? "";
    terms.push({ numerator: BigInt(match[1]! + fraction) * BigInt(atoms), scale: fraction.length + decimals });
  }
  const scale = Math.max(0, ...terms.map((term) => term.scale));
  const numerator = terms.reduce((sum, term) => sum + term.numerator * 10n ** BigInt(scale - term.scale), 0n) * 100n;
  const divisor = 10n ** BigInt(scale);
  const text = ((2n * numerator + divisor) / (2n * divisor)).toString().padStart(3, "0");
  return `${text.slice(0, -2)}.${text.slice(-2)}`;
}

/** The pool's reserves from the coin's row; null until blast-infra has read the pool. */
function poolOf(row: CoinRow): HomeCoinMarket["pool"] {
  const { pool_id: id, venue, coin_reserve: coin, quote_reserve: quote, reserves_as_of_ms: asOf } = row;
  if (id === null || venue === null || coin === null || quote === null || asOf === null) return null;
  if (!ATOMS.test(coin) || !ATOMS.test(quote)) return null;
  return { id, venue, coin_atoms: coin, quote_atoms: quote, as_of_ms: Number(asOf) };
}

export type MarketReadContext = Readonly<{
  nowMs: number;
  hiddenKinds: readonly string[];
  terms: PresaleTermsReader | null;
}>;

/** The coin's market, or `not_found` when no shown sale or standalone vault trades it. */
export async function readHomeMarket(db: ReadableDatabase, coinType: string, context: MarketReadContext): Promise<HomeCoinMarket> {
  const [bounds, asOf] = await Promise.all([readHomeBounds(db, context.nowMs), readAsOf(db)]);
  if (!asOf) throw new SocialRouteError("service_unavailable");
  const kinds = visibleKinds(context.hiddenKinds).filter((kind) => (TRADE_KINDS as readonly string[]).includes(kind));
  const [coins, bands] = await Promise.all([
    db.read<CoinRow>(MARKET_COIN_SQL, [coinType, bounds.clockMs]),
    kinds.length === 0 ? null : db.read<BandRow>(MARKET_TRADES_SQL, [coinType, bounds.clockMs, bounds.marketCheckpoint, kinds]),
  ]);
  const found = coins.rows[0];
  if (!found) throw new SocialRouteError("not_found");
  // The price as Home shows it (`observedHomePrice`): one observed no later than now, else none, so every move agrees with `HomeCoin`.
  const observed = observedHomePrice(found.price_usd, found.price_as_of_ms, context.nowMs);
  const row: CoinRow = { ...found, price_usd: observed?.price ?? null, price_as_of_ms: observed === null ? null : String(observed.asOfMs) };
  const terms = row.presale_id !== null && row.total_supply === null && context.terms
    ? await context.terms(row.presale_id).catch(() => null)
    : null;
  const supply = row.presale_id === null
    ? row.total_supply === null || row.supply === null
      ? null
      : { total: row.total_supply, escrowed: "0", circulating: row.supply }
    : supplyOf(presaleTotalSupply(row.total_supply, terms), row.escrowed);
  const quotePrice = observedHomePrice(row.quote_price_usd, row.quote_price_as_of_ms, context.nowMs)?.price ?? null;
  const pool = poolOf(row);
  const windows = Object.fromEntries(HOME_MARKET_WINDOWS.map((name, index) => [name, windowOf(row, bands?.rows ?? [], index, name, bounds.clockMs)])) as Record<HomeMarketWindowName, HomeMarketWindow>;
  return {
    coin_type: row.coin_type,
    presale_id: row.presale_id,
    decimals: row.sale_decimals,
    quote: { type: row.quote_type, symbol: row.quote_symbol, decimals: row.quote_decimals },
    clock_ms: bounds.clockMs,
    price_usd: row.price_usd,
    price_as_of_ms: row.price_as_of_ms === null ? null : Number(row.price_as_of_ms),
    windows,
    supply,
    fdv_usd: fdvOf(row.price_usd, supply?.total ?? null, row.sale_decimals),
    market_cap_usd: fdvOf(row.price_usd, supply?.circulating ?? null, row.sale_decimals),
    pool,
    liquidity_usd: pool && usdOfSides([
      [pool.coin_atoms, row.price_usd, row.sale_decimals],
      [pool.quote_atoms, quotePrice, row.quote_decimals],
    ]),
    as_of: asOf,
  };
}
