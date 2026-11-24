import {
  AggregatorClient,
  type AggregatorClientParams,
  ALL_DEXES,
  PACKAGE_NAMES,
  PYTH_ORACLE_BASED_DEXES,
  ZERO,
  type RouterDataV3,
} from "@cetusprotocol/aggregator-sdk";
import type { Transaction, TransactionObjectArgument } from "@mysten/sui/transactions";

import { blastTradeFeeAtoms, type BlastTradeFee } from "@blast/core/lib/blast-trade-fee.ts";
import { minOut } from "@blast/core/modules/social/trades/amounts.ts";
import {
  CETUS_ROUTER_ENDPOINT,
  DEFAULT_TRADE_PROVIDERS,
  findCetusRoute,
  grossForNetOut,
  type TradeRoute,
  type TradeRouteAnswer,
  type TradeRouteRequest,
} from "@blast/core/modules/social/trades/cetus-route.ts";

export {
  DEFAULT_TRADE_PROVIDERS,
  grossForNetOut,
  TRADE_ROUTE_MAX_PATHS,
  TRADE_ROUTE_TIMEOUT_MS,
  withBlastFee,
  type TradePath,
  type TradeRoute,
  type TradeRouteAnswer,
  type TradeRouteRequest,
} from "@blast/core/modules/social/trades/cetus-route.ts";

/**
 * The trade router (social feed R3-30, OA-25 Q1/Q11). Routes come from the
 * Cetus aggregator's API through `findCetusRoute` (a plain `fetch`, shared
 * with the browser's estimate); swaps are built by the Cetus aggregator SDK,
 * the one place it is touched, so the quote and swap services see plain data
 * (`TradeRoute`) and tests inject a router over recorded answers
 * (`fixtures/cetus-routes.json`).
 *
 * Blast's app fee (`BLAST_TRADE_FEE_BPS`, `lib/blast-trade-fee.ts`) is the
 * SDK's overlay fee: the swap context carries its rate and receiver, and the
 * aggregator's `confirm_swap_v3` splits `⌊output × ppm ÷ 10⁶⌋` off the swap's
 * output coin and transfers it to the receiver, then checks what is left
 * against the minimum. Every swap here is exact-in, so the fee is always in
 * the output coin: the bought coin for a buy, SUI or USDC for a sell. A
 * route's `amountOut` is already net of it.
 */

export interface TradeRouter {
  /** Blast's fee every route and swap of this router carries; null for none. */
  readonly fee: BlastTradeFee | null;
  /**
   * The aggregator's best route for the request; never throws. With a fee, an
   * exact-out request asks for enough more that what is left after the fee
   * is still the amount asked.
   */
  findRoute(request: TradeRouteRequest): Promise<TradeRouteAnswer>;
  /**
   * Appends the route's swap to `tx`, consuming `inputCoin` (exactly the
   * route's `amountIn`), and returns the output coin. The swap aborts on chain
   * if the net payout is below the rounded-up minimum. Offline: it builds
   * Move calls and reads nothing.
   */
  appendSwap(tx: Transaction, route: TradeRoute, inputCoin: TransactionObjectArgument, slippageBps: number): Promise<TransactionObjectArgument>;
}

/**
 * The providers whose swaps the SDK builds from a route alone: no Pyth price
 * update (which pays its fee from the gas coin, refused for a sponsored
 * swap) and no per-pool details the route might not carry.
 */
const BUILDABLE = new Set(["CETUS", "BLUEFIN", "CETUSDLMM", "MOMENTUM", "MAGMA", "FERRACLMM", "FERRADLMM", "FULLSAIL"]);

/**
 * `SOCIAL_TRADE_PROVIDERS`: comma-separated aggregator providers, each one the
 * SDK knows, builds offline and does not price with Pyth. Unset or blank is
 * the default; anything else invalid throws (the runtime answers
 * `service_unavailable`).
 */
export function parseTradeProviders(value: string | undefined): readonly string[] {
  const entries = (value ?? "").split(",").map((entry) => entry.trim().toUpperCase()).filter(Boolean);
  if (entries.length === 0) return DEFAULT_TRADE_PROVIDERS;
  for (const entry of entries) {
    if (!ALL_DEXES.includes(entry) || PYTH_ORACLE_BASED_DEXES.includes(entry) || !BUILDABLE.has(entry)) {
      throw new Error(`SOCIAL_TRADE_PROVIDERS: ${entry} is not a provider the trade path builds`);
    }
  }
  return Object.freeze([...new Set(entries)]);
}

/** The SDK's `BN`, from one of its own constants: the swap builder calls `BN` methods on the route's totals. */
const SdkBN = (ZERO as { constructor: new (value: string, base: number) => unknown }).constructor;

/**
 * The route's legs in the SDK's shape. The SDK deducts the overlay fee from
 * `grossOut` before putting the net minimum in the swap context.
 */
export function routeToSdk(route: TradeRoute, grossOut: bigint): RouterDataV3 {
  return {
    quoteID: route.requestId,
    amountIn: new SdkBN(route.amountIn.toString(), 10),
    amountOut: new SdkBN(grossOut.toString(), 10),
    byAmountIn: true,
    insufficientLiquidity: false,
    deviationRatio: 0,
    packages: new Map([[PACKAGE_NAMES.AGGREGATOR_V3, route.aggregatorPackage]]),
    paths: route.paths.map((path) => ({
      id: path.poolId,
      direction: path.direction,
      provider: path.provider,
      from: path.from,
      target: path.target,
      feeRate: path.feeRate as unknown as number,
      amountIn: path.amountIn.toString(),
      amountOut: path.amountOut.toString(),
      publishedAt: path.publishedAt,
    })),
  } as RouterDataV3;
}

type TransactionArgument = Parameters<AggregatorClient["routerSwap"]>[0];

/**
 * The SDK client that builds swaps carrying Blast's fee. The SDK takes the
 * overlay rate as a fraction and scales it by 10⁶ in floating point, which
 * for some whole basis points lands a hair off a whole number of parts per
 * million (the swap context's `u32` would refuse it), so the exact rate is
 * set over it.
 */
class FeeAggregatorClient extends AggregatorClient {
  constructor(params: AggregatorClientParams, fee: BlastTradeFee) {
    super({ ...params, overlayFeeRate: fee.ppm / 1_000_000, overlayFeeReceiver: fee.receiver });
    this.overlayFeeRate = fee.ppm;
  }
}

/**
 * The production router: Cetus's aggregator API (`findCetusRoute`), limited
 * to `providers`, charging `fee` when there is one. The fee is taken from the
 * route in atoms, exactly as the aggregator takes it on chain; swaps are built
 * by an SDK client that carries the fee.
 */
export function createCetusTradeRouter(input: Readonly<{
  /** The SDK client's settings for building swaps; its overlay fee is never set from here (`fee` is Blast's). */
  aggregator: Omit<AggregatorClientParams, "overlayFeeRate" | "overlayFeeReceiver">;
  providers: readonly string[];
  fee?: BlastTradeFee | null;
  timeoutMs?: number;
}>): TradeRouter {
  const { providers, timeoutMs } = input;
  const fee = input.fee ?? null;
  const params: AggregatorClientParams = { ...input.aggregator, overlayFeeRate: undefined, overlayFeeReceiver: undefined };
  const swapper = fee === null ? new AggregatorClient(params) : new FeeAggregatorClient(params, fee);
  const endpoint = input.aggregator.endpoint ?? CETUS_ROUTER_ENDPOINT;
  const router: TradeRouter = {
    fee,
    findRoute: (request) => findCetusRoute({ request, providers, fee, timeoutMs, endpoint }),
    async appendSwap(tx, route, inputCoin, slippageBps) {
      if (route.blastFee !== blastTradeFeeAtoms(route.amountOut + route.blastFee, fee)) {
        throw new Error("The route was priced with another Blast fee than this router charges.");
      }
      const minimum = minOut(route.amountOut, slippageBps);
      // Supply the gross equivalent so the SDK's fee deduction leaves exactly the quoted minimum.
      return swapper.routerSwap({
        router: routeToSdk(route, grossForNetOut(minimum, fee)),
        inputCoin: inputCoin as TransactionArgument["inputCoin"],
        slippage: 0,
        txb: tx as unknown as TransactionArgument["txb"],
      }) as unknown as TransactionObjectArgument;
    },
  };
  return Object.freeze(router);
}
