/**
 * Test fixtures for the trade path (social feed R3-30, R3-31). Test-only:
 * runtime code must not import this file.
 *
 * - `replayRouter`: the production router (`createCetusTradeRouter`) over a
 *   real `AggregatorClient`, with `fetch` answered from the Cetus aggregator's
 *   recorded mainnet answers (`fixtures/cetus-routes.json`, written by
 *   `test/scripts/social-trade-fixtures.ts`). Any request not recorded fails, so
 *   no test reaches the network.
 * - `offlineTradeChain`: a `TradeChain` whose client resolves a wallet's
 *   coins and every object offline for `Transaction.build`, with balances and
 *   a dry-run verdict the test sets, and a log of every call.
 * - `replayDryRuns`: dry-run verdicts from real mainnet simulations of the
 *   recorded routes at the trade's and OA-29's reference size
 *   (`fixtures/dry-runs.json`, written by `test/scripts/social-trade-dry-runs.ts`),
 *   matched to the swap a test builds by its pools and amount.
 */
import { Env } from "@cetusprotocol/aggregator-sdk";
import { bcs } from "@mysten/sui/bcs";
import type { ClientWithCoreApi } from "@mysten/sui/client";
import { normalizeStructTag, normalizeSuiAddress } from "@mysten/sui/utils";

import { SOCIAL_TRADE_BASE_COINS } from "@blast/core/modules/social/contracts/trades.ts";
import type { BlastTradeFee } from "../../../../../../core/src/lib/blast-trade-fee.ts";
import { createCetusTradeRouter, DEFAULT_TRADE_PROVIDERS, type TradeRouter } from "@blast/server/modules/social/trades/aggregator.ts";
import type { TradeChain, TradeSimulationResult } from "@blast/server/modules/social/trades/chain.ts";
import routeRecordings from "./fixtures/cetus-routes.json" with { type: "json" };
import dryRunRecordings from "./fixtures/dry-runs.json" with { type: "json" };

export const SUI = SOCIAL_TRADE_BASE_COINS.sui;
export const USDC = SOCIAL_TRADE_BASE_COINS.usdc;
/** The owner's mainnet test sale quoted in SUI, migrated to a Cetus pool (contracts PR #54). */
export const SALE_B = normalizeStructTag("0x5650d58030f361f60f81913b54bf026e93e957bfbf506234f8f2e83bd3bfbd85::sale_tokens::SALE_B");
/** Its sibling quoted in the run's own TEST_SUI on Bluefin: no route reaches it from SUI. */
export const SALE_A = normalizeStructTag("0x5650d58030f361f60f81913b54bf026e93e957bfbf506234f8f2e83bd3bfbd85::sale_tokens::SALE_A");
/** SALE_B's Cetus migration pool, as the recordings route through it. */
export const SALE_B_POOL = "0xb56610d84d29a899f1657f4d44185c0a58ebe9b7212a3a623ca3e4d1c2db1326";
/** The aggregator v3 package the recordings name. */
export const AGGREGATOR_PACKAGE = "0xffd4058af7d6f6d66c335930cced8c91e38ec943e2392232aee27e8127e684e9";
export const SENDER = normalizeSuiAddress("0x5e11");

type Recording = Readonly<{
  name: string;
  request: Readonly<{ from: string; target: string; amount: string; by_amount_in: boolean; providers: readonly string[] }>;
  status: number;
  body: string;
}>;

const RECORDINGS: readonly Recording[] = routeRecordings.recordings;

/** One recording by name. */
export function recording(name: string): Recording {
  const found = RECORDINGS.find((entry) => entry.name === name);
  if (!found) throw new Error(`no recording ${name}`);
  return found;
}

/** The recorded answer's `data` (amounts as text, so nothing above 2^53 is rounded). */
export function recordedData(name: string): Readonly<{ amountIn: string; amountOut: string; deviation: string; requestId: string }> {
  const body = recording(name).body;
  const pick = (key: string) => new RegExp(`"${key}":"?([^,"}]*)"?`).exec(body)?.[1] ?? "";
  return { amountIn: pick("amount_in"), amountOut: pick("amount_out"), deviation: pick("deviation_ratio"), requestId: pick("request_id") };
}

/** Each request the replayed aggregator was asked, in order. */
export type RouteLog = { from: string; target: string; amount: string; byAmountIn: boolean }[];

/**
 * Answers the SDK's `find_routes` request from the recordings while `run`
 * runs; any other request (another URL, coin, amount or direction) throws.
 */
async function withRecordedFetch<T>(log: RouteLog, run: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    if (url.origin !== "https://api-sui.cetus.zone" || url.pathname !== "/router_v3/find_routes") {
      throw new Error(`fixture blocks network request ${url.origin}${url.pathname}`);
    }
    const asked = {
      from: normalizeStructTag(url.searchParams.get("from") ?? ""),
      target: normalizeStructTag(url.searchParams.get("target") ?? ""),
      amount: url.searchParams.get("amount") ?? "",
      byAmountIn: url.searchParams.get("by_amount_in") === "true",
    };
    log.push(asked);
    const found = RECORDINGS.find(
      (entry) =>
        normalizeStructTag(entry.request.from) === asked.from &&
        normalizeStructTag(entry.request.target) === asked.target &&
        entry.request.amount === asked.amount &&
        entry.request.by_amount_in === asked.byAmountIn,
    );
    if (!found) throw new Error(`no recording for ${JSON.stringify(asked)}`);
    return new Response(found.body, { status: found.status });
  }) as typeof fetch;
  try {
    return await run();
  } finally {
    globalThis.fetch = original;
  }
}

/** A test receiver for Blast's fee: a made-up address, never a real treasury. */
export const TEST_FEE_RECEIVER = normalizeSuiAddress("0xfee5");
/** Blast's fee as the owner set it (0.5%), paid to the test receiver. */
export const TEST_BLAST_FEE: BlastTradeFee = Object.freeze({ bps: 50, ppm: 5_000, receiver: TEST_FEE_RECEIVER });

/** The production router over the recordings, and the log of what it asked; `fee` is Blast's (none by default). */
export function replayRouter(
  providers: readonly string[] = DEFAULT_TRADE_PROVIDERS,
  fee: BlastTradeFee | null = null,
): Readonly<{ router: TradeRouter; log: RouteLog }> {
  const log: RouteLog = [];
  const real = createCetusTradeRouter({ aggregator: { env: Env.Mainnet }, providers, fee });
  const router: TradeRouter = {
    fee: real.fee,
    findRoute: (request) => withRecordedFetch(log, () => real.findRoute(request)),
    appendSwap: (tx, route, input, slippage) => real.appendSwap(tx, route, input, slippage),
  };
  return { router, log };
}

/** A router whose aggregator cannot be reached: every request is `unavailable`. */
export const unreachableRouter: TradeRouter = {
  fee: null,
  findRoute: async () => ({ status: "unavailable", reason: "error" }),
  appendSwap: async () => {
    throw new Error("unreachable router builds nothing");
  },
};

const DIGEST = "11111111111111111111111111111111";
/** The argument counts of the Move functions a Cetus or Bluefin swap calls (aggregator SDK 1.7.3), Aftermath's DAO-fee swap, and the versioned presale's commits. */
const ARITY: Readonly<Record<string, number>> = {
  "router::new_swap_context_v3": 8,
  "router::confirm_swap_v3": 1,
  "router::transfer_or_destroy_coin": 1,
  "cetus::swap": 7,
  "bluefin::swap": 6,
  "swap::swap_exact_in": 10,
  "blast_presale::commit_open": 4,
  "blast_presale::commit_uncapped": 4,
  "blast_presale::commit_allowlisted": 7,
};
const id = (n: number) => normalizeSuiAddress(n.toString(16));

/** What the offline chain was asked: balances, gas prices, dry runs and (R3-31) executions. */
export type ChainLog = { kind: "balance" | "price" | "simulate" | "execute"; detail: string }[];

export type OfflineChainOptions = {
  /** Atoms each (owner, coin type) holds; missing is 0. */
  balances?: Readonly<Record<string, bigint>>;
  /** The dry run's verdict (default: success, 1,500,000 MIST of gas). */
  simulation?: (bytes: Uint8Array) => TradeSimulationResult;
  /** Makes every fullnode call reject (an outage). */
  down?: boolean;
};

export const balanceKey = (owner: string, coinType: string) => `${normalizeSuiAddress(owner)}|${normalizeStructTag(coinType)}`;

/** A successful dry run's result. */
export function simulationSuccess(gas: Readonly<{ computation: bigint; storage: bigint; rebate: bigint }> = { computation: 1_000_000n, storage: 600_000n, rebate: 100_000n }): TradeSimulationResult {
  return {
    $kind: "Transaction",
    Transaction: {
      effects: {
        status: { success: true, error: null },
        gasUsed: { computationCost: String(gas.computation), storageCost: String(gas.storage), storageRebate: String(gas.rebate), nonRefundableStorageFee: "0" },
      },
      balanceChanges: [],
    },
  } as unknown as TradeSimulationResult;
}

/** A dry run that aborted in `module` of `pkg` with `code` (the aggregator's slippage abort is `errors`, 1). */
export function simulationAbort(pkg: string, module: string, code: number): TradeSimulationResult {
  return {
    $kind: "FailedTransaction",
    FailedTransaction: {
      effects: {
        status: {
          success: false,
          error: { $kind: "MoveAbort", message: "aborted", MoveAbort: { abortCode: String(code), location: { package: pkg, module, functionName: "f" } } },
        },
        gasUsed: { computationCost: "1000000", storageCost: "0", storageRebate: "0", nonRefundableStorageFee: "0" },
      },
      balanceChanges: [],
    },
  } as unknown as TradeSimulationResult;
}

/**
 * An in-memory chain. Its client lists the owner's coins (one coin object per
 * balance), resolves every object as shared and describes each Move function
 * as taking objects only, which is all `Transaction.build` asks while
 * building a swap kind.
 */
export function offlineTradeChain(options: OfflineChainOptions = {}): TradeChain & { log: ChainLog } {
  const log: ChainLog = [];
  const balances = new Map(Object.entries(options.balances ?? {}));
  const held = (owner: string, coinType: string) => balances.get(balanceKey(owner, coinType)) ?? 0n;
  const fail = () => {
    if (options.down) throw new Error("fullnode down");
  };
  const core = {
    resolveTransactionPlugin: () => undefined,
    // The builder asks for the gas payer's SUI without naming the coin.
    getBalance: async ({ owner, coinType = SUI }: { owner: string; coinType?: string }) => {
      fail();
      const balance = held(owner, coinType);
      return { balance: { coinType, balance: String(balance), coinBalance: String(balance), addressBalance: "0" } };
    },
    getCurrentSystemState: async () => {
      fail();
      return { systemState: { referenceGasPrice: "750", epoch: "900" } };
    },
    getChainIdentifier: async () => {
      fail();
      return { chainIdentifier: "35834a8a" };
    },
    listCoins: async ({ owner, coinType }: { owner: string; coinType: string }) => {
      fail();
      const balance = held(owner, coinType);
      return {
        objects: balance > 0n ? [{ objectId: id(0xc0 + coinType.length), version: "11", digest: DIGEST, balance: String(balance), type: `0x2::coin::Coin<${coinType}>` }] : [],
        hasNextPage: false,
        cursor: null,
      };
    },
    getObjects: async ({ objectIds }: { objectIds: string[] }) => {
      fail();
      return {
        objects: objectIds.map((objectId) => ({ objectId, version: "9", digest: DIGEST, owner: { $kind: "Shared", Shared: { initialSharedVersion: "3" } } })),
      };
    },
    getMoveFunction: async ({ moduleName, name }: { moduleName: string; name: string }) => {
      fail();
      const count = ARITY[`${moduleName}::${name}`];
      if (count === undefined) throw new Error(`fixture has no Move function ${moduleName}::${name}`);
      const object = { reference: "mutable", body: { $kind: "datatype", datatype: { typeName: "0x2::object::UID", typeParameters: [] } } };
      return { function: { parameters: Array.from({ length: count }, () => object) } };
    },
  };
  const client = { core } as unknown as ClientWithCoreApi;
  return {
    client,
    log,
    async balance(owner, coinType) {
      log.push({ kind: "balance", detail: normalizeStructTag(coinType) });
      fail();
      return held(owner, coinType);
    },
    async referenceGasPrice() {
      log.push({ kind: "price", detail: "" });
      fail();
      return 750n;
    },
    async simulate(bytes) {
      log.push({ kind: "simulate", detail: String(bytes.length) });
      fail();
      return options.simulation ? options.simulation(bytes) : simulationSuccess();
    },
  };
}

type DryRunRecording = Readonly<{
  name: string;
  /** The cetus-routes.json recording the swap was built from. */
  route: string;
  run: "trade" | "reference";
  /** The public mainnet address the dry run was simulated from (it held the input). */
  sender: string;
  amount_in: string;
  pools: readonly string[];
  /** What the verdict reads, as the fullnode answered: the effects' status and gas, and the balance changes. */
  result: Readonly<{ $kind: string; effects: unknown; balanceChanges: readonly Readonly<{ coinType: string; address: string; amount: string }>[] }>;
}>;

const DRY_RUNS = dryRunRecordings.dry_runs;

/** One recorded dry run by name. */
export function dryRunRecording(name: string): DryRunRecording {
  const found = DRY_RUNS.find((entry) => entry.name === name);
  if (!found) throw new Error(`no dry run ${name}`);
  if (found.run !== "trade" && found.run !== "reference") throw new Error(`invalid dry run kind ${found.run}`);
  return { ...found, run: found.run };
}

/**
 * A recorded dry run's result as `sender`'s: the balance changes the recorded
 * sender saw are `sender`'s (a dry run reads the sender's coins and nothing
 * else of it, so another wallet holding the input gets the same fill).
 */
export function recordedDryRun(name: string, sender: string = SENDER): TradeSimulationResult {
  const recorded = dryRunRecording(name);
  const from = normalizeSuiAddress(recorded.sender);
  const body = {
    effects: recorded.result.effects,
    balanceChanges: recorded.result.balanceChanges.map((change) =>
      normalizeSuiAddress(change.address) === from ? { ...change, address: normalizeSuiAddress(sender) } : change),
  };
  return { $kind: recorded.result.$kind, [recorded.result.$kind]: body } as unknown as TradeSimulationResult;
}

/** The swap a dry run's bytes simulate: its sender, the swap context's input (`new_swap_context_v3`'s quoted amount in) and each leg's shared objects, in order. */
export function simulatedSwap(bytes: Uint8Array): Readonly<{ sender: string; amountIn: bigint | null; legs: string[][] }> {
  const data = bcs.TransactionData.parse(bytes).V1!;
  const { inputs, commands } = data.kind.ProgrammableTransaction!;
  const input = (argument: { $kind: string; Input?: number }) => (argument.$kind === "Input" ? inputs[argument.Input!] : undefined);
  let amountIn: bigint | null = null;
  const legs: string[][] = [];
  for (const command of commands) {
    const call = command.MoveCall;
    if (!call) continue;
    if (call.module === "router" && call.function === "new_swap_context_v3") {
      const pure = input(call.arguments[2]!)?.Pure;
      amountIn = pure ? BigInt(bcs.u64().fromBase64(pure.bytes)) : null;
    } else if (call.function === "swap") {
      legs.push(call.arguments.flatMap((argument) => {
        const shared = input(argument)?.Object?.SharedObject;
        return shared ? [normalizeSuiAddress(shared.objectId)] : [];
      }));
    }
  }
  return { sender: normalizeSuiAddress(data.sender), amountIn, legs };
}

/**
 * An `offlineTradeChain` simulation that answers each swap with the recorded
 * mainnet dry run of the same pools in the same order and the same input, as
 * the swap's sender's; any other swap gets `otherwise`, or throws.
 */
export function replayDryRuns(otherwise?: (bytes: Uint8Array) => TradeSimulationResult): (bytes: Uint8Array) => TradeSimulationResult {
  return (bytes) => {
    const swap = simulatedSwap(bytes);
    const found = DRY_RUNS.find(
      (entry) =>
        swap.amountIn !== null &&
        entry.amount_in === swap.amountIn.toString() &&
        entry.pools.length === swap.legs.length &&
        entry.pools.every((pool, at) => swap.legs[at]!.includes(normalizeSuiAddress(pool))),
    );
    if (found) return recordedDryRun(found.name, swap.sender);
    if (otherwise) return otherwise(bytes);
    throw new Error(`no recorded dry run of ${swap.amountIn} over ${swap.legs.length} legs`);
  };
}
