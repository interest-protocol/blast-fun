// Fixture transactions for verified-outcome reporting: completed launch and
// curve-Buy transactions on the SDK's non-production deployment, and every
// case that must not record (a settlement buy, a `Sold`, a failed, unknown,
// foreign-lineage, other-launch or uncheckpointed transaction). They serve
// tests and the dev fixture server, never real value.

import { launchpadEventBcs } from "@interest-protocol/blast-sdk/launchpad";
import { TransactionError, type ClientWithCoreApi, type SuiClientTypes } from "@mysten/sui/client";
import { fromBase64, normalizeSuiAddress, toBase58, toBase64 } from "@mysten/sui/utils";

import { NON_PRODUCTION_MANIFEST } from "../launchpad-coin/manifest-fixtures.ts";

const LAUNCHPAD = NON_PRODUCTION_MANIFEST.packages.launchpad.originalPackageId;
const FOREIGN_PACKAGE = normalizeSuiAddress(`0x${"f0".repeat(32)}`);
const CREATOR = normalizeSuiAddress(`0x${"c1".repeat(32)}`);
const BUYER = normalizeSuiAddress(`0x${"c2".repeat(32)}`);

function digest(seed: number): string {
  return toBase58(new Uint8Array(32).fill(seed));
}

export const OUTCOME_FIXTURE = Object.freeze({
  launchId: normalizeSuiAddress(`0x${"5a".repeat(32)}`),
  otherLaunchId: normalizeSuiAddress(`0x${"5b".repeat(32)}`),
  checkpoint: 326_274_101,
  timestampMs: 1_790_000_123_000,
  /** Each transaction's sender: the launch's creator signs its creation, a buyer every other transaction. */
  senders: Object.freeze({ creator: CREATOR, buyer: BUYER }),
  digests: Object.freeze({
    /** The launch's creation: `LaunchShared` at event 1. */
    launch: digest(11),
    /** A curve buy: `Bought` at event 0. */
    buy: digest(12),
    /** The opening round's settlement: the pot's `Bought`, then `OpeningRoundSettled`. */
    settlement: digest(13),
    /** A settlement, then a bidder's own buy in the same transaction (event 2). */
    settlementThenBuy: digest(14),
    sold: digest(15),
    failed: digest(16),
    /** Another launch's `LaunchShared` and `Bought`. */
    otherLaunch: digest(17),
    /** A `Bought` and `LaunchShared` for this launch ID from another package. */
    foreign: digest(18),
    /** A completed `Bought` the node has not put in a checkpoint yet. */
    uncheckpointed: digest(19),
    /** No node has it. */
    unknown: digest(20),
    /**
     * The launch's creation with the creator's first buy before it is shared,
     * as the SDK builds it: `Bought` at event 0, then `LaunchShared` at event 1.
     * Two outcomes of one transaction.
     */
    creationWithBuy: digest(21),
  }),
});

type FixtureEvent = SuiClientTypes.Event;

/** An event of a buyer's transaction; `landed` sets the transaction's own sender on each. */
function event(name: string, bcs: Uint8Array, packageId: string = LAUNCHPAD): FixtureEvent {
  return {
    packageId,
    module: "launch",
    sender: BUYER,
    eventType: `${packageId}::events::${name}<0x3::coin::COIN,0x2::sui::SUI>`,
    bcs,
    json: null,
  };
}

const TRADE_FEES = { protocol_meme_fee: 0n, creator_meme_fee: 0n, protocol_quote_fee: 10_000_000n, creator_quote_fee: 0n };

function bought(launchId: string, packageId?: string): FixtureEvent {
  const payload = launchpadEventBcs.Bought.serialize({
    launch_id: launchId,
    quote_in: 1_000_000_000n,
    meme_out_gross: 2_000_000_000_000n,
    meme_out_net: 2_000_000_000_000n,
    quote_refund: 0n,
    ...TRADE_FEES,
    meme_reserve: 798_000_000_000_000_000n,
    real_quote_reserve: 1_990_000_000n,
  });
  return event("Bought", payload.toBytes(), packageId);
}

function sold(launchId: string): FixtureEvent {
  const payload = launchpadEventBcs.Sold.serialize({
    launch_id: launchId,
    meme_in_gross: 2_000_000_000_000n,
    pending_burn: 0n,
    quote_out_gross: 900_000_000n,
    ...TRADE_FEES,
    meme_reserve: 800_000_000_000_000_000n,
    real_quote_reserve: 1_000_000_000n,
  });
  return event("Sold", payload.toBytes());
}

function launchShared(launchId: string, packageId?: string): FixtureEvent {
  const payload = launchpadEventBcs.LaunchShared.serialize({ launch_id: launchId, public_start_ms: 1_790_000_100_000n });
  return event("LaunchShared", payload.toBytes(), packageId);
}

function openingRoundSettled(launchId: string): FixtureEvent {
  const payload = launchpadEventBcs.OpeningRoundSettled.serialize({
    launch_id: launchId,
    bids: 1_000_000_000n,
    meme_amount: 2_000_000_000_000n,
    quote_amount: 0n,
  });
  return event("OpeningRoundSettled", payload.toBytes());
}

/** An event of a package other than the launchpad, such as a coin's own. */
function unrelated(): FixtureEvent {
  return {
    packageId: "0x2",
    module: "coin",
    sender: BUYER,
    eventType: "0x2::coin::CoinCreated",
    bcs: new Uint8Array([1]),
    json: null,
  };
}

/** A transaction as a fixture node stores it. */
export type OutcomeFixtureTransaction = Readonly<{
  digest: string;
  success: boolean;
  checkpoint: string | null;
  timestampMs: number | null;
  events: readonly FixtureEvent[];
}>;

/** A transaction `sender` signed: every event it emits carries that sender, as on Sui. */
function landed(
  digest: string,
  events: readonly FixtureEvent[],
  overrides: Partial<OutcomeFixtureTransaction> = {},
  sender: string = BUYER,
): OutcomeFixtureTransaction {
  return {
    digest,
    success: true,
    checkpoint: String(OUTCOME_FIXTURE.checkpoint),
    timestampMs: OUTCOME_FIXTURE.timestampMs,
    events: events.map((entry) => ({ ...entry, sender })),
    ...overrides,
  };
}

/** Every fixture transaction by digest; `unknown` is deliberately absent. */
export function outcomeFixtureTransactions(): Map<string, OutcomeFixtureTransaction> {
  const { launchId, otherLaunchId, digests } = OUTCOME_FIXTURE;
  return new Map(
    [
      landed(digests.launch, [unrelated(), launchShared(launchId)], {}, CREATOR),
      landed(digests.creationWithBuy, [bought(launchId), launchShared(launchId)], {}, CREATOR),
      landed(digests.buy, [bought(launchId)]),
      landed(digests.settlement, [bought(launchId), openingRoundSettled(launchId)]),
      landed(digests.settlementThenBuy, [bought(launchId), openingRoundSettled(launchId), bought(launchId)]),
      landed(digests.sold, [sold(launchId)]),
      landed(digests.failed, [], { success: false }),
      landed(digests.otherLaunch, [launchShared(otherLaunchId), bought(otherLaunchId)]),
      landed(digests.foreign, [launchShared(launchId, FOREIGN_PACKAGE), bought(launchId, FOREIGN_PACKAGE)]),
      landed(digests.uncheckpointed, [bought(launchId)], { checkpoint: null, timestampMs: null }),
    ].map((transaction) => [transaction.digest, transaction]),
  );
}

/** The Core API result a node returns for `transaction`. */
export function outcomeTransactionResult(
  transaction: OutcomeFixtureTransaction,
): SuiClientTypes.TransactionResult<{ events: true }> {
  const status: SuiClientTypes.ExecutionStatus = transaction.success
    ? { success: true, error: null }
    : {
        success: false,
        error: { $kind: "MoveAbort", message: "abort 7", MoveAbort: { abortCode: "7" } } as SuiClientTypes.ExecutionError,
      };
  const result = {
    digest: transaction.digest,
    sender: transaction.events[0]?.sender ?? BUYER,
    signatures: [],
    epoch: "3",
    timestampMs: transaction.timestampMs,
    checkpoint: transaction.checkpoint,
    status,
    balanceChanges: undefined,
    effects: undefined,
    events: [...transaction.events],
    objectTypes: undefined,
    transaction: undefined,
    bcs: undefined,
  };
  return transaction.success
    ? { $kind: "Transaction", Transaction: result }
    : { $kind: "FailedTransaction", FailedTransaction: result };
}

/** A fixture transaction as the dev fixture server sends it (event BCS in base64). */
export function outcomeTransactionWire(transaction: OutcomeFixtureTransaction): Record<string, unknown> {
  return { ...transaction, events: transaction.events.map((entry) => ({ ...entry, bcs: toBase64(entry.bcs) })) };
}

/** Reads a fixture transaction back from its wire form; throws on anything else. */
export function outcomeTransactionFromWire(wire: Record<string, unknown>): OutcomeFixtureTransaction {
  const { digest, success, checkpoint, timestampMs, events } = wire;
  if (
    typeof digest !== "string" ||
    typeof success !== "boolean" ||
    (checkpoint !== null && typeof checkpoint !== "string") ||
    (timestampMs !== null && typeof timestampMs !== "number") ||
    !Array.isArray(events)
  ) {
    throw new TypeError("not a fixture transaction");
  }
  return {
    digest,
    success,
    checkpoint,
    timestampMs,
    events: events.map((entry: Record<string, unknown>) => ({
      ...(entry as unknown as FixtureEvent),
      bcs: fromBase64(String(entry.bcs)),
    })),
  };
}

export type OutcomeFixtureNodeState = {
  chainIdentifier: string;
  /** `hang`: reads never answer; `down`: reads fail like an unreachable node. */
  reads: "available" | "hang" | "down";
};

export type OutcomeFixtureNode = Readonly<{
  client: ClientWithCoreApi;
  state: OutcomeFixtureNodeState;
  /** Transaction reads started so far. */
  reads(): number;
  /** Chain-identifier reads started so far. */
  chainReads(): number;
}>;

/**
 * An in-memory node serving the outcome fixture transactions, and `extra`
 * (read live, so a test may land a pending transaction later; presale
 * outcomes add their `Committed` transactions here).
 */
export function createOutcomeFixtureNode(
  overrides: Partial<OutcomeFixtureNodeState> = {},
  extra: ReadonlyMap<string, OutcomeFixtureTransaction> = new Map(),
): OutcomeFixtureNode {
  const state: OutcomeFixtureNodeState = {
    chainIdentifier: NON_PRODUCTION_MANIFEST.chainIdentifier,
    reads: "available",
    ...overrides,
  };
  const transactions = outcomeFixtureTransactions();
  let reads = 0;
  let chainReads = 0;
  async function answer<Value>(value: () => Value, signal?: AbortSignal): Promise<Value> {
    if (state.reads === "down") throw new Error("The fixture node is not answering.");
    if (state.reads === "hang") {
      return new Promise<Value>((_, reject) => {
        signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
    }
    return value();
  }
  const core = {
    getChainIdentifier(options?: Readonly<{ signal?: AbortSignal }>) {
      chainReads += 1;
      return answer(() => ({ chainIdentifier: state.chainIdentifier }), options?.signal);
    },
    getTransaction({ digest, signal }: Readonly<{ digest: string; signal?: AbortSignal }>) {
      reads += 1;
      return answer(() => {
        const found = extra.get(digest) ?? transactions.get(digest);
        if (!found) throw new TransactionError("notFound", digest);
        return outcomeTransactionResult(found);
      }, signal);
    },
  };
  return { client: { core } as unknown as ClientWithCoreApi, state, reads: () => reads, chainReads: () => chainReads };
}
