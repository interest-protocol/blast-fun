import { normalizeStructTag } from "@mysten/sui/utils";
import { exactAtoms, exactDecimal, exactText, fixedExact, multiplyExact, shiftExact } from "@blast/core/lib/exact-amount.ts";
import { processSingleton } from "@blast/core/lib/process-singleton.ts";
import { SUI_COIN_TYPE } from "@blast/core/lib/sui/coin-types.ts";
import { replicaPool } from "@blast/core/modules/database/pool.ts";
import { autocommitReader } from "@blast/core/modules/database/transaction.ts";
import { PORTFOLIO_PRICE_MAX_AGE_MS } from "@blast/core/modules/social/contracts/portfolio.ts";
import type { LegacyCoinMarket, LegacyDiscoveryMarket } from "@blast/core/modules/launchpad-discovery/rows.ts";
import { INDEXED_POOL_COINS } from "@blast/core/modules/social/portfolio/core-coins.ts";
import { publicReadCache } from "@blast/server/modules/public-reads/shared-runtime.ts";
import { optionalSource } from "@blast/server/modules/social/optional-source.ts";
import { createPublicPresaleReader } from "@blast/server/modules/social/presales/public-reads.ts";
import { socialMainnetClient } from "@blast/server/modules/social/route-kit/shared-runtime.ts";

type IndexedPoolCoin = (typeof INDEXED_POOL_COINS)[number];

type UsdObservation = Readonly<{
  priceUsd: string;
  asOfMs: number;
}>;

export type TrackedPoolMarket = Readonly<{
  price?: UsdObservation;
  totalSupplyAtoms?: string;
  circulatingSupplyAtoms?: string;
}>;

type TrackedPoolMarkets = Readonly<Record<string, TrackedPoolMarket | undefined>>;

type PoolMarketSnapshot = Readonly<{
  legacy?: LegacyDiscoveryMarket;
  tracked?: TrackedPoolMarkets;
}>;

const POOL_TYPES = {
  cetus: "0x1eabed72c53feb3805120a081dc15963c204dc8d091542592abaf7a35689b2fb::pool::Pool",
  bluefin: "0x3492c874c1e3b3e2984e8c41b589e642d4d0a5d6459e5a9cfc2d52fd7c89c267::pool::Pool",
};

const pools = INDEXED_POOL_COINS.map((coin) => {
  const [venue, objectId] = coin.poolKey.split(":");
  const poolType = POOL_TYPES[venue as keyof typeof POOL_TYPES];
  return { coin, objectId, type: `${poolType}<${coin.coinType},${SUI_COIN_TYPE}>` };
});

const QUOTE_DECIMALS = 9;
const BURN_ADDRESS = `0x${"0".repeat(64)}`;
const CACHE_MS = 10_000;
const CACHE_KEY = "legacy-market-v2";

/** Pool price is quote atoms per coin atom, stored as a Q64.64 square root.
 * Dividing its square by 2^128 is exactly multiplying by 5^128 / 10^128.
 */
function legacyPoolPrice(sqrtPrice: unknown) {
  if (typeof sqrtPrice !== "string" || !/^[1-9]\d{0,38}$/.test(sqrtPrice)) return null;
  const sqrt = BigInt(sqrtPrice);
  if (sqrt >= 1n << 128n) return null;
  return { n: sqrt * sqrt * 5n ** 128n, scale: 128 };
}

export function legacyFdvUsd(sqrtPrice: unknown, supply: bigint, suiUsd: string): string | null {
  const value = valuationUsd(legacyPoolPrice(sqrtPrice), supply, suiUsd);
  return value && fixedExact(value, 2);
}

/** Convert quote atoms per coin atom to dollars per whole coin. */
export function trackedPoolPriceUsd(quoteAtomPrice: string | undefined, suiUsd: string | null, coinDecimals: number): string | undefined {
  const price = exactDecimal(quoteAtomPrice);
  const rate = exactDecimal(suiUsd);
  if (!price?.n || !rate?.n) return undefined;
  return exactText(shiftExact(multiplyExact(price, rate), QUOTE_DECIMALS - coinDecimals));
}

export function trackedPoolMarketOf(
  market: LegacyCoinMarket,
  coinDecimals: number,
  suiUsd: UsdObservation | null,
  poolObservedAtMs: number | undefined,
): TrackedPoolMarket | undefined {
  const { totalSupplyAtoms, circulatingSupplyAtoms } = market;
  const priceUsd = trackedPoolPriceUsd(market.price, suiUsd?.priceUsd ?? null, coinDecimals);
  const price = priceUsd && suiUsd && poolObservedAtMs !== undefined
    ? { priceUsd, asOfMs: Math.min(suiUsd.asOfMs, poolObservedAtMs) }
    : undefined;
  if (!price && totalSupplyAtoms === undefined) return undefined;
  return { price, totalSupplyAtoms, circulatingSupplyAtoms };
}

/** Graduated coins have no pending curve burns. Treasury supply already excludes native burns. */
function legacyCirculatingSupply(total: bigint | undefined, zeroBalance: string | undefined) {
  const burned = exactAtoms(zeroBalance, 0)?.n;
  return total !== undefined && burned !== undefined && burned <= total ? total - burned : undefined;
}

function valuationUsd(price: ReturnType<typeof legacyPoolPrice>, supply: bigint, suiUsd: string) {
  const quote = exactAtoms(supply, QUOTE_DECIMALS);
  const rate = exactDecimal(suiUsd);
  if (!price || !quote || !rate?.n) return null;
  return multiplyExact(multiplyExact(price, quote), rate);
}

async function readSuiUsd(): Promise<UsdObservation | null> {
  const database = autocommitReader(replicaPool(), "social", { label: "launchpad.legacy_fdv" });
  const now = Date.now();
  const { rows: [row] } = await database.read<{ usd: string; as_of_ms: string }>(
    `SELECT usd_price::text AS usd, as_of_ms::text FROM chain_read_v1.prices
     WHERE coin_type = $1 AND usd_price > 0
       AND as_of_ms BETWEEN $2 AND $3`,
    [SUI_COIN_TYPE, now - PORTFOLIO_PRICE_MAX_AGE_MS + CACHE_MS, now],
  );
  if (!row) return null;
  const asOfMs = Number(row.as_of_ms);
  return Number.isSafeInteger(asOfMs) && asOfMs > 0 ? { priceUsd: row.usd, asOfMs } : null;
}

async function readCoinInfo(coin: IndexedPoolCoin, signal: AbortSignal) {
  const node = socialMainnetClient("legacy-fdv");
  const { response } = await node.stateService.getCoinInfo({ coinType: coin.coinType }, { abort: signal });
  if (!response.coinType || normalizeStructTag(response.coinType) !== coin.coinType) return null;
  const description = response.metadata?.description?.trim();
  return {
    supply: response.treasury?.totalSupply,
    description: description && description.length <= 1024 ? description : undefined,
  };
}

export function legacyCoinMarket(
  fields: Readonly<Record<string, unknown>> | null | undefined,
  info: Awaited<ReturnType<typeof readCoinInfo>> | undefined,
  zeroBalance: string | undefined,
  suiUsd: string | null,
) {
  // Cetus and Bluefin leave the last swap's closing price in the pool.
  const price = legacyPoolPrice(fields?.current_sqrt_price);
  const fee = fields?.fee_rate;
  const feeRate = typeof fee === "string" && /^[0-9]{1,6}$/.test(fee) ? Number(fee) : undefined;
  const circulating = legacyCirculatingSupply(info?.supply, zeroBalance);
  const cap = circulating !== undefined && suiUsd ? valuationUsd(price, circulating, suiUsd) : null;
  const fdv = info?.supply !== undefined && suiUsd ? valuationUsd(price, info.supply, suiUsd) : null;
  const market: LegacyCoinMarket = {
    price: price ? exactText(price) : undefined,
    totalSupplyAtoms: info?.supply?.toString(),
    circulatingSupplyAtoms: circulating?.toString(),
    marketCapUsd: cap ? exactText(cap) : undefined,
    feeRate,
    description: info?.description,
  };
  return { market, fdv: fdv && fixedExact(fdv, 2) };
}

async function loadLegacyMarket(): Promise<PoolMarketSnapshot> {
  const signal = AbortSignal.timeout(2_000);
  const node = socialMainnetClient("legacy-fdv");
  const [suiUsd, poolsRead, infos, zeroBalances] = await Promise.all([
    optionalSource("legacy_sui_usd", readSuiUsd, null),
    optionalSource("legacy_pools", async () => {
      const { objects } = await node.core.getObjects({ objectIds: pools.map(({ objectId }) => objectId), include: { json: true }, signal });
      return { objects, asOfMs: Date.now() };
    }, null),
    Promise.all(pools.map(({ coin }) => optionalSource("legacy_coin_info", () => readCoinInfo(coin, signal), null))),
    Promise.all(pools.map(({ coin }) => optionalSource("legacy_burn_balance", async () => {
      const { response } = await node.stateService.getBalance(
        { owner: BURN_ADDRESS, coinType: coin.coinType }, { abort: signal },
      );
      const balance = response.balance;
      if (!balance?.coinType || normalizeStructTag(balance.coinType) !== coin.coinType) return undefined;
      return balance.balance?.toString();
    }, undefined))),
  ]);
  const legacyFdvUsd: Record<string, string> = {};
  const legacyMarket: Record<string, LegacyCoinMarket> = {};
  const tracked: Record<string, TrackedPoolMarket> = {};
  for (const [index, { coin, objectId, type }] of pools.entries()) {
    const pool = poolsRead?.objects[index];
    const fields = pool && !(pool instanceof Error) && pool.objectId === objectId && pool.type === type
      ? pool.json
      : null;
    const { market, fdv } = legacyCoinMarket(fields, infos[index], zeroBalances[index], suiUsd?.priceUsd ?? null);
    if (Object.values(market).some((value) => value !== undefined)) legacyMarket[coin.coinType] = market;
    if (fdv !== null) legacyFdvUsd[coin.coinType] = fdv;
    const snapshot = trackedPoolMarketOf(market, coin.decimals, suiUsd, poolsRead?.asOfMs);
    if (snapshot) tracked[coin.coinType] = snapshot;
  }
  return { legacy: { legacyFdvUsd, legacyMarket }, tracked };
}

/** One fixed pool batch shared by Discover and launchpad market readers. */
function readPoolMarket(): Promise<PoolMarketSnapshot> {
  const local = processSingleton("launchpad.legacy-market", () => createPublicPresaleReader());
  return local(CACHE_KEY, () =>
    optionalSource("legacy_market", () => publicReadCache("market")(CACHE_KEY, loadLegacyMarket, CACHE_MS), {}),
  CACHE_MS);
}

export async function readLegacyMarket(): Promise<LegacyDiscoveryMarket> {
  return (await readPoolMarket()).legacy ?? {};
}

export async function readTrackedPoolMarket(): Promise<TrackedPoolMarkets> {
  return (await readPoolMarket()).tracked ?? {};
}
