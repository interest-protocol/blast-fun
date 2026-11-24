import { z } from "zod";
import { bcs } from "@mysten/sui/bcs";
import type { ClientWithCoreApi, SuiClientTypes } from "@mysten/sui/client";
import { coinWithBalance, Transaction } from "@mysten/sui/transactions";
import { normalizeStructTag, normalizeSuiAddress } from "@mysten/sui/utils";

import type { TradeRoute, TradeRouter } from "@blast/server/modules/social/trades/aggregator.ts";
import { AFTERMATH_SLIPPAGE_ABORT } from "@blast/server/modules/social/trades/aftermath.ts";
import { SUI_COIN_TYPE } from "@blast/core/lib/sui/coin-types.ts";

/**
 * The trade's chain side (social feed R3-30 and R3-31): building the swap of a
 * route from a wallet's own coins, and dry-running it on Sui mainnet before
 * it is offered. The fullnode is a port (`TradeChain`), so tests run the
 * builder over an in-memory client and a recorded verdict.
 */

/** A dry run's gas budget ceiling, in MIST (the sponsor's per-transaction cap). */
export const TRADE_SIMULATION_BUDGET_MIST = 50_000_000n;

export type TradeSimulationResult = SuiClientTypes.SimulateTransactionResult<{ effects: true; balanceChanges: true }>;

/** What the trade path reads from mainnet. Every method may reject (the caller answers `pool_unavailable`). */
export interface TradeChain {
  /** The client `Transaction.build` resolves the wallet's coins and the pools through. */
  readonly client: ClientWithCoreApi;
  /** `owner`'s balance of `coinType` (coins plus address balance), in atoms. */
  balance(owner: string, coinType: string, signal?: AbortSignal): Promise<bigint>;
  referenceGasPrice(signal?: AbortSignal): Promise<bigint>;
  /** Simulates full `TransactionData` bytes. */
  simulate(transactionBytes: Uint8Array, signal?: AbortSignal): Promise<TradeSimulationResult>;
}

/** The mainnet fullnode as a `TradeChain`. */
export function fullnodeTradeChain(client: ClientWithCoreApi): TradeChain {
  return Object.freeze({
    client,
    async balance(owner: string, coinType: string, signal?: AbortSignal) {
      const answer = await client.core.getBalance({ owner, coinType, signal });
      const text = answer?.balance?.balance;
      if (!z.string().regex(/^(0|[1-9][0-9]*)$/).safeParse(text).success) throw new Error("The fullnode answered a malformed balance.");
      return BigInt(text);
    },
    async referenceGasPrice(signal?: AbortSignal) {
      const { referenceGasPrice } = await client.core.getReferenceGasPrice({ signal });
      if (!z.string().regex(/^[1-9][0-9]*$/).safeParse(referenceGasPrice).success) throw new Error("The fullnode reported no reference gas price.");
      return BigInt(referenceGasPrice);
    },
    async simulate(transactionBytes: Uint8Array, signal?: AbortSignal) {
      // No gas selection: bytes with no payment are simulated with the fullnode's mocked gas coin, as
      // `simulationBytes` intends. With selection (the SDK's default for an empty payment) mainnet picks
      // the sender's own SUI for a 0.05 SUI budget, and refuses a wallet whose SUI the swap spends or that
      // holds none (a sponsored Blast wallet). Bytes that carry a payment are simulated as they are.
      const options: SuiClientTypes.SimulateTransactionOptions<{ effects: true; balanceChanges: true }> & { doGasSelection: boolean } = {
        transaction: transactionBytes,
        include: { effects: true, balanceChanges: true },
        doGasSelection: false,
        signal,
      };
      return client.core.simulateTransaction(options);
    },
  });
}

export type SwapBuild = Readonly<{
  router: TradeRouter;
  route: TradeRoute;
  sender: string;
  inCoin: string;
  slippageBps: number;
  /**
   * Whether a SUI input may be split from the gas coin: only when the wallet
   * pays its own gas in the executed transaction. A dry run and a sponsored
   * swap never touch the gas coin, so the swap is funded from the wallet's own
   * coins and a short balance shows.
   */
  useGasCoin: boolean;
}>;

/**
 * The swap as a transaction: exactly the route's `amountIn` of `inCoin` from
 * the sender's coins (or address balance), the route's legs in its order, and
 * the output transferred to the sender. Nothing else: no fee, no other
 * recipient.
 */
export async function swapTransaction(build: SwapBuild): Promise<Transaction> {
  const tx = new Transaction();
  tx.setSender(build.sender);
  const input = tx.add(coinWithBalance({ type: build.inCoin, balance: build.route.amountIn, useGasCoin: build.useGasCoin }));
  const output = await build.router.appendSwap(tx, build.route, input, build.slippageBps);
  tx.transferObjects([output], build.sender);
  return tx;
}

/** The swap's `TransactionKind` bytes, built through `client` (the sender's coins and the pools are resolved). */
export async function swapKind(build: SwapBuild, client: ClientWithCoreApi): Promise<Uint8Array> {
  return (await swapTransaction(build)).build({ client, onlyTransactionKind: true });
}

/**
 * Full `TransactionData` V1 bytes for a dry run: the kind unchanged, the
 * sender, a gas owner, no payment (the fullnode simulates with a mock gas
 * coin), the price and a budget. Nothing here can execute: it is never signed.
 */
export function simulationBytes(input: Readonly<{ kind: Uint8Array; sender: string; gasOwner: string; price: bigint; budget?: bigint }>): Uint8Array {
  return bcs.TransactionData.serialize({
    V1: {
      kind: bcs.TransactionKind.parse(input.kind),
      sender: input.sender,
      gasData: { payment: [], owner: input.gasOwner, price: input.price, budget: input.budget ?? TRADE_SIMULATION_BUDGET_MIST },
      expiration: { None: true },
    },
  }).toBytes();
}

/** The aggregator v3 contract's abort for a fill below the swap context's minimum (`errors`, code 1). */
const SLIPPAGE_ABORT = Object.freeze({ module: "errors", code: 1 });

/** The Aftermath-to-Cetus net-payout check splits and restores the minimum before transferring the output. */
export function minimumOutFailed(
  error: SuiClientTypes.ExecutionError | null | undefined,
  commands: () => readonly { $kind: string }[] | undefined,
): boolean {
  if (error?.command === undefined || !/insufficient\s*coin\s*balance/i.test(error.message)) return false;
  const built = commands();
  return built !== undefined && error.command === built.length - 3 &&
    built[error.command]?.$kind === "SplitCoins" && built.at(-2)?.$kind === "MergeCoins" &&
    built.at(-1)?.$kind === "TransferObjects";
}

export type TradeDryRun =
  | Readonly<{ status: "passed"; gasMist: bigint; received: bigint | null }>
  | Readonly<{ status: "failed"; failure: "slippage" | "abort" | "insufficient" | "other"; gasMist: bigint }>;

/** The gas the transaction is charged, computation + storage − rebate (negative when the rebate is larger). */
function netGasOf(effects: SuiClientTypes.TransactionEffects | null | undefined): bigint {
  const used = effects?.gasUsed;
  if (!used) return 0n;
  return BigInt(used.computationCost) + BigInt(used.storageCost) - BigInt(used.storageRebate);
}

function gasOf(effects: SuiClientTypes.TransactionEffects | null | undefined): bigint {
  const net = netGasOf(effects);
  return net < 0n ? 0n : net;
}

function abortCode(abort: SuiClientTypes.MoveAbort): number | null {
  const clever = abort.cleverError?.errorCode;
  if (typeof clever === "number" && Number.isSafeInteger(clever)) return clever;
  return /^[0-9]{1,15}$/.test(abort.abortCode) ? Number(abort.abortCode) : null;
}

function receivedAmount(transaction: TradeSimulationResult["Transaction"] | TradeSimulationResult["FailedTransaction"], effects: NonNullable<TradeSimulationResult["Transaction"]>["effects"], context: Readonly<{ sender: string; outCoin: string }>): bigint | null {
  const owner = normalizeSuiAddress(context.sender);
  const changes = transaction?.balanceChanges;
  let received: bigint | null = null;
  if (Array.isArray(changes) && changes.length > 0) {
    received = changes
      .filter((change) => normalizeSuiAddress(change.address) === owner && normalizeStructTag(change.coinType) === context.outCoin)
      .reduce((sum, change) => sum + BigInt(change.amount), 0n);
    if (context.outCoin === SUI_COIN_TYPE) received += netGasOf(effects);
  }
  return received;
}

/**
 * The dry run's verdict. `slippage` is the aggregator's own minimum-out
 * abort from the route's aggregator package or Aftermath AMM, or a short
 * payout at the absolute minimum check. Any other abort is `abort`; a wallet
 * short of coins or gas is `insufficient`; any other failure is `other`.
 * `received` is what the swap gave the sender in `outCoin`: its balance
 * change, and for SUI that change with the gas added back (every dry run here
 * names the sender as its gas owner, so its SUI change is what the swap gave
 * less the gas, which mainnet's simulation shows on the mocked gas coin too).
 * Null when the result carries no balance changes to read.
 */
export function dryRunVerdict(
  result: TradeSimulationResult,
  context: Readonly<{ aggregatorPackage: string; sender: string; outCoin: string }>,
  bytes?: Uint8Array,
): TradeDryRun {
  const transaction = result.$kind === "Transaction" ? result.Transaction : result.FailedTransaction;
  const effects = transaction?.effects;
  const gasMist = gasOf(effects);
  if (effects?.status.success) {
    const received = receivedAmount(transaction, effects, context);
    return { status: "passed", gasMist, received };
  }
  const error = effects?.status.error;
  if (error?.$kind === "MoveAbort") {
    const abort = error.MoveAbort;
    const pkg = abort.location?.package ? normalizeSuiAddress(abort.location.package) : null;
    const code = abortCode(abort);
    const slippage = (pkg === normalizeSuiAddress(context.aggregatorPackage) && abort.location?.module === SLIPPAGE_ABORT.module && code === SLIPPAGE_ABORT.code) ||
      (pkg === AFTERMATH_SLIPPAGE_ABORT.package && abort.location?.module === AFTERMATH_SLIPPAGE_ABORT.module && code === AFTERMATH_SLIPPAGE_ABORT.code);
    return { status: "failed", failure: slippage ? "slippage" : "abort", gasMist };
  }
  if (bytes && minimumOutFailed(error, () => bcs.TransactionData.parse(bytes).V1?.kind.ProgrammableTransaction?.commands)) {
    return { status: "failed", failure: "slippage", gasMist };
  }
  // The wallet's coins or gas fell short (`InsufficientGas`, `InsufficientCoinBalance`, …).
  if (error && /insufficient/i.test(`${error.$kind} ${error.message}`)) return { status: "failed", failure: "insufficient", gasMist };
  return { status: "failed", failure: "other", gasMist };
}
