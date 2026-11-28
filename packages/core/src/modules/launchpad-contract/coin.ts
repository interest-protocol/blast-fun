import { matchesSchema, contractValue, recordSchema, listSchema, ContractViolation, parseAtomic, parseCount, parseUsdString } from "@blast/core/modules/launchpad-contract/decimal.ts";
import { normalizeFeeSplit, type Destination, type FeeSplit } from "@interest-protocol/blast-sdk";
import { z } from "zod";
import { fdvInQuote } from "@blast/core/modules/social/prices/valuation.ts";
import { marketCapUsd, quoteValueUsd } from "./market-cap-usd.ts";
import { parseCoinFeePolicy, parseCoinMarket, type CoinFeePolicy, type CoinMarket } from "./display.ts";
import type {
  AllocationPlan,
} from "@interest-protocol/blast-sdk/launchpad";

import type { MarketDataDependencies } from "../read-routing/market-data.ts";
import { parseMarketEconomics, readV1, type MarketEconomics } from "@blast/core/modules/launchpad-contract/v1.ts";
import { COIN_TYPE, SUI_OBJECT_ID_PATTERN } from "@blast/core/lib/sui/ids.ts";
import { POOL_KEY } from "./venues.ts";

/**
 * blast-infra `/v1` shapes beside the launch summary (T-024's
 * `discovery.ts`): trading windows and holder counts of a pool or coin, a
 * launch's snapshotted allocation plan and LP-fee split (as the SDK's types),
 * the coin summary (`GET /v1/coins/{coin_type}`) and a venue pool summary.
 * Each refuses a value that breaks the wire contract (docs/api.md) with a
 * ContractViolation, never a zero.
 */

/** One trading window of a pool or coin summary. */
export type TradeWindow = Readonly<{
  volumeQuote: bigint;
  volumeUsd: string | null;
  buys: number;
  sells: number;
  trades: number;
}>;

/** Activity totals blast-infra keeps for a pool or a coin; `holders` is null when the coin's holder snapshot is incomplete. */
export type PoolStats = Readonly<{ day: TradeWindow; all: TradeWindow; holders: number | null }>;

/** `GET /v1/coins/{coin_type}`: the coin across its pools; market values are its current pool's. */
export type CoinSummary = Readonly<{
  coinType: string;
  decimals: number;
  quoteDecimals: number | null;
  creator: string | null;
  creatorSource: "address" | "claim" | null;
  /** The public wallet that published the launch ticket. */
  launcher?: string | null;
  currentPool: string;
  pools: readonly string[];
  supply: bigint;
  marketCap: bigint | null;
  stats: PoolStats;
  feePolicy?: CoinFeePolicy | null;
  /** The current pool's USD market cap and 24 h move; null when the producer leaves it out or it is malformed. */
  market?: CoinMarket | null;
}>;

/** The coin's migration pool on its venue. */
export type VenuePool = Readonly<{ poolKey: string; economics: MarketEconomics; marketCapUsd: string | null; fdvUsd: string | null; stats: PoolStats }>;

const addressSchema = z.string().regex(SUI_OBJECT_ID_PATTERN);
const launcherSchema = addressSchema.refine((address) => address !== `0x${"0".repeat(64)}`);

function record(value: unknown, field: string): Record<string, unknown> {
  return contractValue(recordSchema, value, field, "must be an object");
}

export function parseWindow(value: unknown, field: string): TradeWindow {
  const window = record(value, field);
  return {
    volumeQuote: parseAtomic(window.volume_quote, `${field}.volume_quote`),
    volumeUsd: window.volume_usd === null ? null : parseUsdString(window.volume_usd, `${field}.volume_usd`),
    buys: parseCount(window.buys, `${field}.buys`),
    sells: parseCount(window.sells, `${field}.sells`),
    trades: parseCount(window.trades, `${field}.trades`),
  };
}

export function parsePoolStats(summary: Record<string, unknown>, field: string): PoolStats {
  const windows = record(summary.windows, `${field}.windows`);
  return {
    day: parseWindow(windows["24h"], `${field}.windows.24h`),
    all: parseWindow(windows.all, `${field}.windows.all`),
    holders: summary.holders === null ? null : parseCount(summary.holders, `${field}.holders`),
  };
}

function list(value: unknown, field: string): unknown[] {
  return contractValue(listSchema, value, field, "must be a list");
}

function destination(value: unknown, field: string): string {
  return contractValue(z.string().regex(SUI_OBJECT_ID_PATTERN), value, field, "must be an address");
}

export function parseAllocationPlan(value: unknown, field: string): AllocationPlan {
  const plan = record(value, field);
  const bps = (key: string) => parseAtomic(plan[key], `${field}.${key}`, 64);
  return {
    curveMemeBps: bps("curve_meme_bps"),
    lpMemeBps: bps("lp_meme_bps"),
    lpQuoteBps: bps("lp_quote_bps"),
    protocolMemeBps: bps("protocol_meme_bps"),
    protocolQuoteBps: bps("protocol_quote_bps"),
    recipients: list(plan.recipients, `${field}.recipients`).map((item, index) => {
      const at = `${field}.recipients[${index}]`;
      const share = record(item, at);
      const recipient = record(share.recipient, `${at}.recipient`);
      const terms = recipient.vesting_terms === null ? null : record(recipient.vesting_terms, `${at}.recipient.vesting_terms`);
      return {
        recipient: {
          destination: destination(recipient.destination, `${at}.recipient.destination`),
          vestingTerms: terms && {
            cliffDelayMs: parseAtomic(terms.cliff_delay_ms, `${at}.recipient.vesting_terms.cliff_delay_ms`, 64),
            periodDurationMs: parseAtomic(terms.period_duration_ms, `${at}.recipient.vesting_terms.period_duration_ms`, 64),
            periods: parseAtomic(terms.periods, `${at}.recipient.vesting_terms.periods`, 64),
          },
        },
        memeBps: parseAtomic(share.meme_bps, `${at}.meme_bps`, 64),
        quoteBps: parseAtomic(share.quote_bps, `${at}.quote_bps`, 64),
      };
    }),
  };
}

const SPECIAL_DESTINATIONS = {
  owner: "Owner",
  auto_lp: "AutoLp",
  holder_rewards: "HolderRewards",
  burn: "Burn",
} as const;

function feeDestination(value: unknown, field: string): Destination {
  const entry = record(value, field);
  if (entry.kind === "address") return { kind: "Address", address: destination(entry.address, `${field}.address`) };
  const kind = entry.kind;
  if (typeof kind === "string" && Object.hasOwn(SPECIAL_DESTINATIONS, kind)) {
    return { kind: SPECIAL_DESTINATIONS[kind as keyof typeof SPECIAL_DESTINATIONS] };
  }
  throw new ContractViolation(`${field}.kind`, "is not a fee destination");
}

export function parseFeeSplit(value: unknown, field: string): FeeSplit {
  const split = record(value, field);
  const routes = list(split.routes, `${field}.routes`).map((item, index) => {
    const at = `${field}.routes[${index}]`;
    const route = record(item, at);
    return { destination: feeDestination(route.destination, `${at}.destination`), bps: parseAtomic(route.bps, `${at}.bps`, 64) };
  });
  try {
    return normalizeFeeSplit({ routes });
  } catch {
    throw new ContractViolation(field, "is not a valid fee split");
  }
}

function poolKey(value: unknown, field: string): string {
  return contractValue(z.string().regex(POOL_KEY), value, field, "must be a pool key");
}

function smallCount(value: unknown, field: string): number {
  const parsed = parseAtomic(value, field);
  if (parsed > 255n) throw new ContractViolation(field, "must be at most 255");
  return Number(parsed);
}

export function readCoinMarketSummary(coinType: string, dependencies: MarketDataDependencies) {
  return readV1("market", `/v1/coins/${coinType}`, (body) => parseCoinSummary(body, coinType), dependencies);
}

/** `GET /v1/coins/{coin_type}`: the coin, which must be the requested launch's. */
export function parseCoinSummary(body: unknown, coinType: string, launchId?: string): CoinSummary {
  const coin = record(body, "body");
  if (coin.coin !== coinType || !matchesSchema(z.string().regex(COIN_TYPE), coinType)) throw new ContractViolation("coin", "must be the requested coin");
  if (launchId !== undefined && coin.launch_id !== undefined && coin.launch_id !== launchId) {
    throw new ContractViolation("launch_id", "must be the requested launch");
  }
  if (coin.creator !== null && (!matchesSchema(addressSchema, coin.creator))) {
    throw new ContractViolation("creator", "must be an address or null");
  }
  if (!matchesSchema(z.enum(["address", "claim"]).nullable(), coin.creator_source)) {
    throw new ContractViolation("creator_source", "is unknown");
  }
  if (!matchesSchema(listSchema, coin.pools)) throw new ContractViolation("pools", "must be a list");
  return {
    coinType,
    decimals: smallCount(coin.decimals, "decimals"),
    quoteDecimals: coin.quote_decimals === null ? null : smallCount(coin.quote_decimals, "quote_decimals"),
    creator: coin.creator as string | null,
    creatorSource: coin.creator_source as CoinSummary["creatorSource"],
    launcher: matchesSchema(launcherSchema, coin.launcher) ? coin.launcher : null,
    currentPool: poolKey(coin.current_pool, "current_pool"),
    pools: coin.pools.map((key, index) => poolKey(key, `pools[${index}]`)),
    supply: parseAtomic(coin.supply, "supply", 64),
    marketCap: coin.market_cap === null ? null : parseAtomic(coin.market_cap, "market_cap"),
    stats: parsePoolStats(coin, "coin"),
    feePolicy: parseCoinFeePolicy(coin.fee_policy),
    market: parseCoinMarket(coin.market),
  };
}

/** `GET /v1/pools/{venue}/{pool_id}` of the coin's migration pool. */
export function parseVenuePool(body: unknown, key: string, coinType: string): VenuePool {
  const pool = record(record(body, "body").pool, "pool");
  if (pool.pool_key !== key) throw new ContractViolation("pool.pool_key", "must be the requested pool");
  if (pool.coin !== coinType) throw new ContractViolation("pool.coin", "must be the launch's coin");
  const economics = parseMarketEconomics(pool, "pool");
  if (economics.venue === "blast_curve") throw new ContractViolation("pool.venue", "must be a venue pool");
  const { currencySupply, quoteDecimals } = economics.inputs;
  return {
    poolKey: key,
    economics,
    marketCapUsd: marketCapUsd(economics.marketCap, quoteDecimals, pool.quote_usd),
    fdvUsd: quoteValueUsd(fdvInQuote(economics.price, currencySupply, quoteDecimals), pool.quote_usd),
    stats: parsePoolStats(pool, "pool"),
  };
}

