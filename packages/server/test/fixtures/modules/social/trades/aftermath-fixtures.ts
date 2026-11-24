/**
 * Test fixtures for Aftermath DAO-fee routes (`aftermath.ts`); runtime code
 * must not import this file. The pool is a real mainnet DAO-fee pool, its
 * three objects recorded as the fullnode returned them, with what the chain
 * gave for nine swaps of it (`fixtures/aftermath-dao-pool.json`). The Cetus
 * leg of a two-leg route is a stub at a fixed rate, built by the real Cetus
 * router offline.
 */
import { readFileSync } from "node:fs";

import { Env } from "@cetusprotocol/aggregator-sdk";
import { fromBase64, normalizeStructTag, normalizeSuiAddress } from "@mysten/sui/utils";

import type { BlastTradeFee } from "../../../../../../core/src/lib/blast-trade-fee.ts";
import { createCetusTradeRouter, DEFAULT_TRADE_PROVIDERS, type TradeRoute, type TradeRouter } from "@blast/server/modules/social/trades/aggregator.ts";
import { createAftermathDaoRouter, parseAftermathDaoPool, type AftermathDaoPool, type AftermathDaoPools } from "@blast/server/modules/social/trades/aftermath.ts";
import { AGGREGATOR_PACKAGE, SUI, USDC } from "./fixtures.ts";

type RecordedObject = Readonly<{ object_id: string; version: string; type: string; content_base64: string }>;
type Recording = Readonly<{
  pool: RecordedObject;
  wrapper: RecordedObject;
  vault: RecordedObject;
  swaps: readonly Readonly<{ from: 0 | 1; amount_in: string; amount_out: string }>[];
}>;

export const AFTERMATH_RECORDING: Recording = JSON.parse(readFileSync(new URL("./fixtures/aftermath-dao-pool.json", import.meta.url), "utf8"));

/** The recorded pool's sale coin (YUM, paired with SUI). */
export const YUM = normalizeStructTag("0xbeb462f2f86980c89892e6052cf5e90db4b5032db462f47684b9cd8bdf729fb0::yum::YUM");
export const YUM_POOL = normalizeSuiAddress(AFTERMATH_RECORDING.pool.object_id);
export const YUM_WRAPPER = normalizeSuiAddress(AFTERMATH_RECORDING.wrapper.object_id);
export const YUM_BINDING = Object.freeze({ coinType: YUM, poolId: YUM_POOL });

/** The recorded objects as `parseAftermathDaoPool` takes them, with any field replaced. */
export function recordedPoolInput(overrides: Partial<Parameters<typeof parseAftermathDaoPool>[0]> = {}): Parameters<typeof parseAftermathDaoPool>[0] {
  const { pool, wrapper, vault } = AFTERMATH_RECORDING;
  return {
    poolId: pool.object_id,
    poolType: pool.type,
    pool: fromBase64(pool.content_base64),
    wrapperId: wrapper.object_id,
    wrapperType: wrapper.type,
    wrapper: fromBase64(wrapper.content_base64),
    vaultType: vault.type,
    vault: fromBase64(vault.content_base64),
    ...overrides,
  };
}

export function recordedPool(): AftermathDaoPool {
  const pool = parseAftermathDaoPool(recordedPoolInput());
  if (!pool) throw new Error("the recorded pool does not parse");
  return pool;
}

/** A pool reader over the recording: the recorded pool by its id, null for any other; `down` rejects. */
export function recordedPools(options: Readonly<{ down?: boolean }> = {}): AftermathDaoPools & { reads: string[] } {
  const reads: string[] = [];
  return {
    reads,
    async read(poolId: string) {
      reads.push(poolId);
      if (options.down) throw new Error("fullnode down");
      return normalizeSuiAddress(poolId) === YUM_POOL ? recordedPool() : null;
    },
  };
}

/** The Cetus pool and adapter the stub's leg names (a recorded mainnet route's). */
export const STUB_CETUS_POOL = normalizeSuiAddress("0xc1e7");
export const STUB_CETUS_ADAPTER = "0x87b17d7f0b448b83ab934a13eb64b05b60e17d0a371e2a721c241bcf3f5ec9e7";
/** The stub's rate: 3 USDC (6 decimals) per SUI (9 decimals). */
const USDC_PER_SUI = Object.freeze({ usdc: 3_000_000n, sui: 1_000_000_000n });

/**
 * A fee-less Cetus router for the USDC ↔ SUI leg: one CETUS leg at a fixed
 * rate with a 0.25% fee, built by the real Cetus router offline. `log` holds
 * what it was asked.
 */
export function stubCetusBase(): TradeRouter & { log: string[] } {
  const real = createCetusTradeRouter({ aggregator: { env: Env.Mainnet }, providers: DEFAULT_TRADE_PROVIDERS, fee: null });
  const log: string[] = [];
  const convert = (from: string, amount: bigint) =>
    from === USDC ? (amount * USDC_PER_SUI.sui * 9_975n) / (USDC_PER_SUI.usdc * 10_000n) : (amount * USDC_PER_SUI.usdc * 9_975n) / (USDC_PER_SUI.sui * 10_000n);
  const invert = (from: string, out: bigint) =>
    from === USDC ? (out * USDC_PER_SUI.usdc * 10_000n) / (USDC_PER_SUI.sui * 9_975n) + 1n : (out * USDC_PER_SUI.sui * 10_000n) / (USDC_PER_SUI.usdc * 9_975n) + 1n;
  return {
    log,
    fee: null,
    async findRoute(request) {
      log.push(`${request.from === USDC ? "USDC" : "SUI"}->${request.target === USDC ? "USDC" : "SUI"} ${request.byAmountIn ? "in" : "out"} ${request.amount}`);
      const pair = new Set([request.from, request.target]);
      if (!pair.has(SUI) || !pair.has(USDC)) return { status: "no_route" };
      const amountIn = request.byAmountIn ? request.amount : invert(request.from, request.amount);
      const amountOut = convert(request.from, amountIn);
      const route: TradeRoute = {
        requestId: "stub-quote",
        amountIn,
        amountOut,
        paths: [{ poolId: STUB_CETUS_POOL, provider: "CETUS", direction: request.from === USDC, from: request.from, target: request.target, feeRate: "0.0025", amountIn, amountOut, publishedAt: normalizeSuiAddress(STUB_CETUS_ADAPTER) }],
        aggregatorPackage: AGGREGATOR_PACKAGE,
        deviationRatio: "",
        blastFee: 0n,
      };
      return { status: "route", route };
    },
    appendSwap: (tx, route, input, slippage) => real.appendSwap(tx, route, input, slippage),
  };
}

/** The Aftermath router over the recording and the stub's Cetus leg. */
export function recordedAftermathRouter(fee: BlastTradeFee | null = null, pools: AftermathDaoPools = recordedPools()): TradeRouter & { base: ReturnType<typeof stubCetusBase> } {
  const base = stubCetusBase();
  return { ...createAftermathDaoRouter({ pools, base, fee }), base };
}
