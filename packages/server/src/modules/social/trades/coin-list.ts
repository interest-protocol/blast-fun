import { TEST_SUI_COIN_TYPES } from "@blast/core/modules/social/contracts/create.ts";
import { DISPLAY_PRICES } from "@blast/core/modules/social/prices/test-sui.ts";
import { socialParameter, socialSingle } from "@blast/server/modules/social/route-kit/validation.ts";
import { z } from "zod";
import { isValidStructTag } from "@mysten/sui/utils";
import { readCoinMetadata } from "@blast/server/modules/social/portfolio/coin-metadata.ts";
import { coinTypeName, wireIconUrl, wireText } from "@blast/core/modules/social/contracts/financial-wire.ts";
import { CORE_COINS, coreCoin } from "@blast/core/modules/social/portfolio/core-coins.ts";
import { readTradeCoins, TRADE_PRICES_SQL } from "./coins.ts";
import { BLAST_LAUNCH_COINS, TEST_SUI_COIN_TYPES_SQL, TEST_SUI_LAUNCH_TYPES } from "@blast/server/modules/social/read-model/blast-launch-coins.ts";
import { verifiedTeamSql } from "@blast/server/modules/social/read-model/verified-team.ts";
import { USDC_COIN_TYPE } from "@blast/core/lib/sui/coin-types.ts";

import type { ReadableDatabase } from "@blast/core/modules/database/transaction.ts";
import { PORTFOLIO_PRICE_MAX_AGE_MS } from "@blast/core/modules/social/contracts/portfolio.ts";
import {
  normalizeTradeCoinQuery,
  socialTradeCoinSchema,
  SOCIAL_TRADE_COINS_MAX_LIMIT,
  SOCIAL_TRADE_COINS_MAX_QUERY,
  type SocialTradeCoin,
  type SocialTradeCoinPage,
} from "@blast/core/modules/social/contracts/trades.ts";
import { SHOWN_PRESALES, liveSaleSql } from "@blast/core/modules/social/read-model/chain-presales.ts";
import { SocialRouteError } from "@blast/core/modules/social/route-kit/errors.ts";
import { SUI_OBJECT_ID_PATTERN } from "@blast/core/lib/sui/ids.ts";

/**
 * The coins a trade can name (social feed R3-33): the coin of every
 * open or migrated Blast sale as `SHOWN_PRESALES` shows it, on a venue the app trades
 * (`SOCIAL_TRADE_VENUES`: Cetus, Bluefin, an Aftermath DAO-fee pool), with R3-20's latest price
 * when it is fresh; a search's first page also leads with the curated ecosystem
 * coins (`CORE_COINS`) it names. The coins sheet's picker lists them under "More coins".
 *
 * Sales are read with one statement on the replica per page: the shown sales (blast-infra's
 * view; about two thousand rows at launch scale) joined to `prices` by its
 * key, ordered by `(sale_symbol's first 32 code points, presale_id)` in the C collation and paged by
 * keyset. A search's first page adds one price read for the ecosystem coins it
 * names. Global Search also looks up curve launches by name and ticker. Exact canonical
 * lookups also accept the quote reader's indexed wallet coins.
 * Nothing personal: the answer is the same for every caller.
 */

export type TradeCoinListQuery = Readonly<{
  /** Case-insensitive search text, with complete tags normalized by the SDK, or null. */
  q: string | null;
  cursor: TradeCoinCursor | null;
  limit: number;
  includeLaunch?: boolean;
}>;

export type TradeCoinCursor = Readonly<{ symbol: string; presaleId: string }>;

/** `%` and `_` (and the escape itself) match themselves in the search. */
export function likePattern(q: string): string {
  return `%${q.replace(/[\\%_]/g, (match) => `\\${match}`)}%`;
}

/**
 * Sales page by their symbol's first code points, then presale id: a symbol is
 * whatever its publisher wrote (empty, or any length), and the key must fit the
 * cursor however it reads.
 */
const CURSOR_SYMBOL_LENGTH = 32;

/** The keyset's symbol: `left(coalesce(sale_symbol, ''), 32)`, as the SQL orders it. */
const cursorSymbol = (symbol: string | null) => [...(symbol ?? "")].slice(0, CURSOR_SYMBOL_LENGTH).join("");

export const TRADE_COIN_LIST_SQL = `
  SELECT ${liveSaleSql("p", "$5::bigint")} AS in_presale, p.presale_id, p.sale_token, p.sale_symbol, p.sale_name, p.sale_icon_url, p.sale_decimals, p.quote_symbol, p.quote_type,
    pr.usd_price::text AS usd_price, pr.as_of_ms::text AS as_of_ms, coalesce(trust.verified_team, false) AS verified_team
  FROM ${SHOWN_PRESALES} p
  LEFT JOIN ${DISPLAY_PRICES} pr ON pr.coin_type = p.sale_token
  LEFT JOIN social_sale_trust trust ON trust.presale_id = p.presale_id
  WHERE (CASE WHEN $7::text IS NOT NULL THEN p.sale_token = $7
    ELSE ((p.lifecycle = 'migrated' AND p.venue IN ('cetus', 'bluefin', 'aftermath')
      AND (p.venue <> 'aftermath' OR p.pool_id IS NOT NULL))
      OR ${liveSaleSql("p", "$5::bigint")})
      AND ($1::text IS NULL OR p.sale_symbol ILIKE $1 ESCAPE '\\' OR p.sale_name ILIKE $1 ESCAPE '\\'
        OR ($6::boolean AND (p.sale_token ILIKE $1 ESCAPE '\\'
          OR regexp_replace(p.sale_token, '0x0+([0-9a-f])', '0x\\1', 'gi') ILIKE $1 ESCAPE '\\')))
    END)
    AND p.sale_token NOT IN (${TEST_SUI_COIN_TYPES_SQL})
    AND coalesce(p.quote_type NOT IN (${TEST_SUI_COIN_TYPES_SQL}), true)
    AND ($2::text IS NULL OR (left(coalesce(p.sale_symbol, ''), ${CURSOR_SYMBOL_LENGTH}) COLLATE "C", p.presale_id COLLATE "C") > ($2::text COLLATE "C", $3::text COLLATE "C"))
  ORDER BY left(coalesce(p.sale_symbol, ''), ${CURSOR_SYMBOL_LENGTH}) COLLATE "C", p.presale_id COLLATE "C"
  LIMIT $4`;

type CoinRow = Readonly<{
  in_presale: boolean;
  presale_id: string;
  sale_token: string;
  sale_symbol: string | null;
  sale_name: string | null;
  sale_icon_url: string | null;
  sale_decimals: number;
  quote_symbol: string;
  quote_type: string;
  usd_price: string | null;
  as_of_ms: string | null;
  verified_team: boolean;
}>;

/** Public curve matches, ordered by exact match, team verification and prefix. */
const TRADE_LAUNCH_SEARCH_SQL = `
  SELECT c.coin_type, c.launch_id, c.name, c.symbol, c.icon_url, c.decimals, trust.coin_type IS NOT NULL AS verified_team
  FROM ${BLAST_LAUNCH_COINS} c
  LEFT JOIN social_coin_trust trust ON trust.coin_type = c.coin_type
  WHERE c.launch_id IS NOT NULL
    AND c.coin_type NOT IN (${TEST_SUI_COIN_TYPES_SQL})
    AND coalesce(c.quote_type NOT IN (${TEST_SUI_COIN_TYPES_SQL}), true)
    AND (c.symbol ILIKE $2 ESCAPE '\\' OR c.name ILIKE $2 ESCAPE '\\'
      OR ($5::boolean AND (c.coin_type ILIKE $2 ESCAPE '\\'
        OR regexp_replace(c.coin_type, '0x0+([0-9a-f])', '0x\\1', 'gi') ILIKE $2 ESCAPE '\\')))
  ORDER BY (lower(c.symbol) = $1 OR lower(coalesce(c.name, '')) = $1) DESC,
    verified_team DESC,
    (c.symbol ILIKE $3 ESCAPE '\\' OR coalesce(c.name, '') ILIKE $3 ESCAPE '\\') DESC,
    c.launch_id
  LIMIT $4`;

type LaunchCoinRow = Readonly<{
  coin_type: string;
  launch_id: string;
  name: string | null;
  symbol: string;
  icon_url: string | null;
  decimals: number;
  verified_team: boolean;
}>;

export function encodeTradeCoinCursor(cursor: TradeCoinCursor): string {
  return Buffer.from(JSON.stringify([cursor.symbol, cursor.presaleId])).toString("base64url");
}

/** A cursor from `encodeTradeCoinCursor`, or `invalid_parameter` (`cursor`). */
const tradeCoinCursorSchema = z.tuple([z.string().refine((symbol) => symbol === cursorSymbol(symbol)), z.string().regex(SUI_OBJECT_ID_PATTERN)]);

export function decodeTradeCoinCursor(raw: string): TradeCoinCursor {
  let parsed: unknown = null;
  try {
    if (raw.length <= 400) parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
  } catch {
    parsed = null;
  }
  const decoded = tradeCoinCursorSchema.safeParse(parsed);
  if (!decoded.success) throw new SocialRouteError("invalid_parameter", { extra: { parameter: "cursor" } });
  return { symbol: decoded.data[0], presaleId: decoded.data[1] };
}

function single(url: URL, name: string): string | null {
  return socialSingle(url.searchParams, name);
}

/** The list query from a URL: `q`, `cursor`, `limit` and `include_launch`, each at most once. */
export function parseTradeCoinListQuery(url: URL): TradeCoinListQuery {
  const rawQ = single(url, "q");
  let q: string | null = null;
  if (rawQ !== null) {
    const trimmed = rawQ.trim().replace(/^\$/, "").trim();
    socialParameter(z.string().min(1).max(SOCIAL_TRADE_COINS_MAX_QUERY).refine((value) => !/[\u0000-\u001f]/.test(value)), trimmed, "q");
    q = normalizeTradeCoinQuery(trimmed);
  }
  const rawLimit = single(url, "limit");
  const limit = socialParameter(z.string().regex(/^[1-9][0-9]?$/).transform(Number).pipe(z.number().max(SOCIAL_TRADE_COINS_MAX_LIMIT)).nullable().transform((value) => value ?? SOCIAL_TRADE_COINS_MAX_LIMIT), rawLimit, "limit");
  const rawCursor = single(url, "cursor");
  const includeLaunch = socialParameter(z.literal("1").nullable(), single(url, "include_launch"), "include_launch") !== null;
  return { q, cursor: rawCursor === null ? null : decodeTradeCoinCursor(rawCursor), limit, ...(includeLaunch && { includeLaunch }) };
}

const PRICE = /^(0|[1-9][0-9]*)(\.[0-9]+)?$/;

/**
 * The curated ecosystem coins whose ticker or name contains a search (not a
 * coin type): an exact ticker first, then a ticker prefix, then the rest in
 * `CORE_COINS` order. Each one routes through the aggregator, so it is tradable.
 */
function ecosystemSearchCoins(q: string): readonly (typeof CORE_COINS)[number][] {
  if (q.startsWith("0x")) return [];
  const term = q.toLowerCase();
  const rank = (symbol: string) => (symbol === term ? 0 : symbol.startsWith(term) ? 1 : 2);
  return CORE_COINS
    .filter((coin) => coin.symbol.toLowerCase().includes(term) || coin.name.toLowerCase().includes(term))
    .sort((a, b) => rank(a.symbol.toLowerCase()) - rank(b.symbol.toLowerCase()));
}

/**
 * `coin` as the wire can carry it, the way `wireWalletCoin` repairs a wallet
 * coin: text cut to its bound (an empty symbol becomes the type's name, an
 * empty name the symbol), a bad logo or price becomes none. A coin that still
 * fails (its decimals, say) is left out, so one coin never fails the page.
 */
export function wireTradeCoin(coin: SocialTradeCoin): SocialTradeCoin | null {
  const field = socialTradeCoinSchema.shape;
  const symbol = wireText(coin.symbol, 64) ?? coinTypeName(coin.coin_type, 64);
  const fixed: SocialTradeCoin = {
    ...coin,
    symbol,
    name: wireText(coin.name, 128) ?? symbol,
    icon_url: wireIconUrl(coin.icon_url),
    usd_price: field.usd_price.safeParse(coin.usd_price).success ? coin.usd_price : null,
  };
  return socialTradeCoinSchema.safeParse(fixed).success ? fixed : null;
}

/** Sale and ecosystem coin discovery, or exact coin metadata using the quote server's eligibility rules. */
export async function readTradeCoinPage(db: ReadableDatabase, query: TradeCoinListQuery, nowMs: number): Promise<SocialTradeCoinPage> {
  const exactType = exactCoinType(query);
  if (exactType !== null && TEST_SUI_COIN_TYPES.includes(exactType)) return { coins: [], next_cursor: null };
  const text = !query.cursor && !exactType ? query.q : null;
  // A search's first page leads with the ecosystem coins it names, at most half the page, so sales still show and the keyset cursor keeps an anchor.
  const ecosystem = text ? ecosystemSearchCoins(text).slice(0, Math.floor(query.limit / 2)) : [];
  const launchLimit = Math.max(1, Math.floor(query.limit / 2));
  const [{ rows }, prices, launches] = await Promise.all([
    db.read<CoinRow>(TRADE_COIN_LIST_SQL, [
      query.q === null ? null : likePattern(query.q),
      query.cursor?.symbol ?? null,
      query.cursor?.presaleId ?? null,
      query.limit + 1, nowMs, query.q?.startsWith("0x") ?? false, query.includeLaunch ? exactType : null,
    ]),
    ecosystem.length ? readEcosystemPrices(db, ecosystem.map((coin) => coin.coinType), nowMs) : new Map<string, string>(),
    text && query.includeLaunch ? readLaunchMatches(db, text, launchLimit) : [],
  ]);
  // A matching sale keeps a slot so the cursor can resume after it.
  const saleReserve = Math.min(rows.length, 1);
  const visibleLaunches = launches.slice(0, query.limit - ecosystem.length - saleReserve);
  const saleLimit = query.limit - ecosystem.length - visibleLaunches.length;
  const page = rows.slice(0, saleLimit);
  const coins = page.flatMap((row) => wireTradeCoin({
    coin_type: row.sale_token,
    symbol: row.sale_symbol ?? "",
    name: row.sale_name ?? "",
    decimals: Number(row.sale_decimals),
    icon_url: row.sale_icon_url,
    usd_price: row.as_of_ms !== null && nowMs - Number(row.as_of_ms) <= PORTFOLIO_PRICE_MAX_AGE_MS ? row.usd_price : null,
    presale_id: row.presale_id,
    ...(row.verified_team ? { verified_team: true } : {}),
    ...(row.in_presale ? { in_presale: true, quote_symbol: row.quote_symbol, quote_type: row.quote_type } : {}),
  }) ?? []);
  if (exactType) {
    const exact = coins.find(coin => coin.coin_type === exactType);
    return { coins: exact ? [exact] : await readExactTradeCoin(db, exactType, nowMs, query.includeLaunch === true), next_cursor: null };
  }
  const listed = new Set(coins.map((coin) => coin.coin_type));
  const leading = ecosystem.filter((coin) => !listed.has(coin.coinType)).map((coin): SocialTradeCoin => ({
    coin_type: coin.coinType,
    symbol: coin.symbol,
    name: coin.name,
    decimals: coin.decimals,
    icon_url: coin.logoUrl,
    usd_price: coin.coinType === USDC_COIN_TYPE ? "1" : prices.get(coin.coinType) ?? null,
    presale_id: null,
  }));
  const last = page[page.length - 1];
  return {
    coins: [...leading, ...visibleLaunches, ...coins],
    next_cursor: rows.length > saleLimit && last ? encodeTradeCoinCursor({ symbol: cursorSymbol(last.sale_symbol), presaleId: last.presale_id }) : null,
  };
}

function exactCoinType({ q, cursor }: TradeCoinListQuery): string | null {
  return q && !cursor && isValidStructTag(q) ? q : null;
}

async function readLaunchMatches(db: ReadableDatabase, text: string, limit: number): Promise<SocialTradeCoin[]> {
  const contains = likePattern(text);
  const { rows } = await db.read<LaunchCoinRow>(TRADE_LAUNCH_SEARCH_SQL, [
    text, contains, contains.slice(1), limit, text.startsWith("0x"),
  ]);
  return rows.flatMap((row) => wireTradeCoin({
    coin_type: row.coin_type,
    launch_id: row.launch_id,
    symbol: row.symbol,
    name: row.name ?? "",
    decimals: Number(row.decimals),
    icon_url: row.icon_url,
    usd_price: null,
    presale_id: null,
    ...(row.verified_team ? { verified_team: true } : {}),
  }) ?? []);
}

/** Fresh R3-20 prices of the named ecosystem coins, by type: one read, no eligibility probes (each is tradable by curation). */
async function readEcosystemPrices(db: ReadableDatabase, coinTypes: readonly string[], nowMs: number): Promise<Map<string, string>> {
  const { rows } = await db.read<Readonly<{ coin_type: string; usd_price: string; as_of_ms: string }>>(TRADE_PRICES_SQL, [coinTypes.filter((type) => type !== USDC_COIN_TYPE)]);
  return new Map(rows.filter((row) => PRICE.test(row.usd_price) && nowMs - Number(row.as_of_ms) <= PORTFOLIO_PRICE_MAX_AGE_MS).map((row) => [row.coin_type, row.usd_price]));
}

/** An exact coin's Known deployer flag and, when requested, its original launch. */
export const TRADE_COIN_TRUST_SQL = `
  SELECT ${verifiedTeamSql("$1::text", "$2::text")} AS verified,
    CASE WHEN $3::boolean AND $1::text IS NULL THEN (
      SELECT c.launch_id FROM ${BLAST_LAUNCH_COINS} c
      WHERE c.coin_type = $2::text AND c.launch_id IS NOT NULL
      ORDER BY c.launch_id LIMIT 1
    ) END AS launch_id,
    EXISTS (SELECT 1 FROM ${TEST_SUI_LAUNCH_TYPES} test WHERE test.coin_type = $2::text) AS test_market`;

/** Indexed wallet coins share the quote reader; a price or pool is not required for metadata. */
async function readExactTradeCoin(db: ReadableDatabase, coinType: string, nowMs: number, includeLaunch: boolean): Promise<SocialTradeCoin[]> {
  const coin = (await readTradeCoins(db, [coinType], nowMs)).get(coinType);
  if (!coin) return [];
  const metadata = (await readCoinMetadata(db, [coinType])).get(coinType);
  // R3-23: a pasted coin type finds a curve coin, or a sale off the first page, so it reads its own flag.
  const { rows: [details] } = await db.read<{ verified: boolean; launch_id: string | null; test_market: boolean }>(
    TRADE_COIN_TRUST_SQL, [coin.presaleId, coinType, includeLaunch],
  );
  if (details?.test_market) return [];
  const core = coreCoin(coinType);
  const exact = wireTradeCoin({
    coin_type: coin.coinType,
    symbol: coin.symbol,
    name: core?.name || metadata?.name || coin.symbol,
    decimals: coin.decimals,
    icon_url: wireIconUrl(metadata?.icon_url) ?? core?.logoUrl ?? null,
    usd_price: coin.usdPrice,
    presale_id: coin.presaleId,
    ...(details?.verified ? { verified_team: true } : {}),
    ...(details?.launch_id ? { launch_id: details.launch_id } : {}),
  });
  return exact ? [exact] : [];
}
