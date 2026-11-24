// A fixture Sui node for bonding-curve trading: one Live launch whose object
// is the real `Launch` BCS layout, SUI and coin balances, and buy and sell
// execution that follows the contract's rules through the SDK's own previews
// (`previewBuy`, `previewSell`) and emits real `Bought`/`Sold` payloads. The
// same launch can be in its opening round: the node then serves the Sui
// clock object, each bidder's `OpeningRoundBidKey` field, and opening-round
// joins under `launch::join_opening_round`'s checks (contracts 442116a),
// emitting real `OpeningRoundJoined` payloads, settlement under
// `launch::settle_opening_round`'s checks, emitting the pot's `Bought` and
// `OpeningRoundSettled`, and delivery under `launch::deliver_opening_round`'s,
// emitting `OpeningRoundDelivered`. It serves adapter, controller, and harness
// checks, never real value.

import { SUI_COIN_TYPE as SUI_TYPE } from "@blast/core/lib/sui/coin-types.ts";
import { fixtureSharedContent, runtimeFor } from "../../modules/launchpad-coin/deployment-runtime.ts";
import { sharedObjectEntries } from "@interest-protocol/blast-sdk/deployments";
import { launchBcs, launchpadEventBcs, memeAtomicSupply, previewBuy, previewSell, type CurveState } from "@interest-protocol/blast-sdk/launchpad";
import { venueWitnessType } from "@interest-protocol/blast-sdk/migrators";
import { bcs } from "@mysten/sui/bcs";
import { ObjectError, type ClientWithCoreApi, type SuiClientTypes } from "@mysten/sui/client";
import { Transaction, TransactionDataBuilder } from "@mysten/sui/transactions";
import { fromBase64, normalizeStructTag, normalizeSuiAddress } from "@mysten/sui/utils";
import { verifyTransactionSignature } from "@mysten/sui/verify";

import type { OutcomeFixtureTransaction } from "../../modules/launchpad-telemetry/outcome-fixtures.ts";
import { NON_PRODUCTION_MANIFEST } from "../../modules/launchpad-coin/manifest-fixtures.ts";

const LAUNCHPAD = normalizeSuiAddress(NON_PRODUCTION_MANIFEST.packages.launchpad.originalPackageId);

/** The fixture coin and its launch. */
export const TRADE_MEME_TYPE = normalizeStructTag(`0x${"4d".repeat(32)}::toad::TOAD`);
export const TRADE_LAUNCH_ID = normalizeSuiAddress(`0x${"1b".repeat(32)}`);
export const TRADE_MEME_DECIMALS = 9;
const LAUNCH_SHARED_VERSION = "12";
/** When the fixture launch was shared (`public_start_ms`). */
const TRADE_PUBLIC_START_MS = 1_790_000_000_000n;
const CLOCK_ID = normalizeSuiAddress("0x6");
const clockBcs = bcs.struct("Clock", { id: bcs.Address, timestamp_ms: bcs.u64() });
const GAS_COIN = { objectId: normalizeSuiAddress(`0x${"6e".repeat(32)}`), digest: "BMwg3HvPTPQaKr9Lnk5jjNkw1bseCftzVgdaGksass4W" };

const SHARED_OBJECTS = runtimeFor(NON_PRODUCTION_MANIFEST).sharedObjects;

export type TradeLifecycle = "OpeningRound" | "Live" | "MigrationReady" | "Migrated";

export type TradeFixtureState = {
  chainIdentifier: string;
  reads: "available" | "unavailable";
  curve: CurveState;
  sellBurnBps: bigint;
  pendingBurn: bigint;
  lifecycle: TradeLifecycle;
  /** The launch object's version; every trade advances it. */
  version: number;
  /** Atomic SUI per owner; an absent owner holds 100 SUI. */
  sui: Record<string, bigint>;
  /** Atomic coin per owner; an absent owner holds none. */
  meme: Record<string, bigint>;
  /** `contract`: simulation applies the contract's checks; `unavailable`: the node cannot simulate. */
  simulation: "contract" | "unavailable";
  /**
   * `unknown`: the trade lands but the submission answer is lost; `abort`: it aborts on chain; `out-of-gas`: it
   * fails on chain outside the contract; `preempted`: another wallet's settlement (or, for a delivery, another
   * wallet's delivery to the same bidder) lands just before it;
   * `no-evidence`: it completes but carries no launchpad event and changes nothing.
   */
  execution: "complete" | "abort" | "unknown" | "out-of-gas" | "preempted" | "no-evidence";
  confirmation: "checkpointed" | "pending";
  /** `public_start_ms`. */
  publicStartMs: bigint;
  /** `opening_round_ms`: zero without an opening round. */
  openingRoundMs: bigint;
  /** Each bidder's undelivered opening-round Quote, by address (`OpeningRoundBidKey`). */
  bids: Record<string, bigint>;
  /** The Sui clock object's `timestamp_ms`, the time every simulation and execution sees. */
  clockMs: number;
  /** Once the round settled: the coin and the refund Quote still held for undelivered bids; null before. */
  settlement: Readonly<{ meme: bigint; quote: bigint }> | null;
  /** The launch's coin decimals (its canonical supply); `TRADE_MEME_DECIMALS` by default. */
  memeDecimals: number;
  /** The launch's Quote type; SUI by default. Only reads and opening-round deliveries use another Quote. */
  quoteType: string;
  quoteMetadata: SuiClientTypes.CoinMetadata | null;
};

export type TradeFixtureCalls = { simulate: number; execute: number };

export type TradeFixtureChain = Readonly<{
  client: ClientWithCoreApi;
  state: TradeFixtureState;
  calls: TradeFixtureCalls;
  /** Another trader buys `quoteAmount` of the curve, changing its reserves and version. */
  competingBuy(quoteAmount: bigint): void;
  /** `bidder` joins the opening round with `quoteAmount`, changing the pot and the launch version. */
  competingJoin(bidder: string, quoteAmount: bigint): void;
  /** Another wallet settles the ended opening round now. */
  competingSettle(): void;
  /** Another wallet delivers `bidder`'s share of the settled round now (a refused delivery changes nothing). */
  competingDeliver(bidder: string): void;
  /**
   * A checkpointed transaction this node executed, as the dev fixture node
   * stores it, so a dev page can land it there for the outcomes route; null
   * when the node has none (or it is not checkpointed yet).
   */
  transactionOf(digest: string): OutcomeFixtureTransaction | null;
}>;

const DEFAULT_SUI = 100_000_000_000n;
/** The checkpoint every executed transaction lands in once confirmed. */
const FIXTURE_CHECKPOINT = "41";
/** The wallet that settles, or delivers, first in a race. */
const COMPETING_SETTLER = normalizeSuiAddress(`0x${"c5".repeat(32)}`);

export function tradeFixtureCurve(): CurveState {
  return {
    memeReserve: 690_000_000_000_000_000n,
    realQuoteReserve: 1_000_000_000_000n,
    virtualQuote: 3_000_000_000_000n,
    graduationTarget: 12_000_000_000_000n,
    quoteFeeBps: 100n,
    memeFeeBps: 0n,
  };
}

type Landed = { status: SuiClientTypes.ExecutionStatus; events: SuiClientTypes.Event[] };
type TransactionData = ReturnType<Transaction["getData"]>;

function abort(module: string, fn: string, code: number, command: number): SuiClientTypes.ExecutionStatus {
  return {
    success: false,
    error: {
      $kind: "MoveAbort",
      message: `MoveAbort in ${command + 1}${["st", "nd", "rd"][command] ?? "th"} command, abort code: ${code}, in '${LAUNCHPAD}::${module}::${fn}' (instruction 12)`,
      MoveAbort: { abortCode: String(code), location: { package: LAUNCHPAD, module, functionName: fn } },
    } as SuiClientTypes.ExecutionError,
  };
}

function failure(message: string): SuiClientTypes.ExecutionStatus {
  return { success: false, error: { $kind: "Unknown", message, Unknown: null } as unknown as SuiClientTypes.ExecutionError };
}

/** An abort raised inside the Sui framework, as `dynamic_field::remove` raises it for a missing field. */
function frameworkAbort(module: string, fn: string, code: number, command: number): SuiClientTypes.ExecutionStatus {
  const framework = normalizeSuiAddress("0x2");
  return {
    success: false,
    error: {
      $kind: "MoveAbort",
      message: `MoveAbort in ${command + 1}${["st", "nd", "rd"][command] ?? "th"} command, abort code: ${code}, in '${framework}::${module}::${fn}' (instruction 0)`,
      MoveAbort: { abortCode: String(code), location: { package: framework, module, functionName: fn } },
    } as SuiClientTypes.ExecutionError,
  };
}

function event(name: "Bought" | "Sold" | "OpeningRoundJoined" | "OpeningRoundSettled" | "OpeningRoundDelivered", sender: string, payload: Uint8Array): SuiClientTypes.Event {
  return {
    packageId: LAUNCHPAD,
    module: "launch",
    sender,
    eventType: `${LAUNCHPAD}::events::${name}<${TRADE_MEME_TYPE},${SUI_TYPE}>`,
    bcs: payload,
    json: null,
  };
}

/** The `Bought` a curve purchase emits. */
function boughtEvent(sender: string, preview: ReturnType<typeof previewBuy>): SuiClientTypes.Event {
  const payload = launchpadEventBcs.Bought.serialize({
    launch_id: TRADE_LAUNCH_ID,
    quote_in: preview.quoteInGross,
    meme_out_gross: preview.memeOutGross,
    meme_out_net: preview.memeOutNet,
    quote_refund: preview.quoteRefund,
    protocol_meme_fee: 0n,
    creator_meme_fee: preview.memeFee,
    protocol_quote_fee: preview.quoteFee,
    creator_quote_fee: 0n,
    meme_reserve: preview.memeReserveAfter,
    real_quote_reserve: preview.realQuoteReserveAfter,
  });
  return event("Bought", sender, payload.toBytes());
}

/** The pure `u64` an argument names, when it names one. */
function pureU64(data: TransactionData, argument: unknown): bigint | null {
  const index = (argument as { Input?: number }).Input;
  const bytes = index === undefined ? undefined : data.inputs[index]?.Pure?.bytes;
  return bytes ? BigInt(bcs.u64().parse(fromBase64(bytes))) : null;
}

/** The pure address an argument names, when it names one. */
function pureAddress(data: TransactionData, argument: unknown): string | null {
  const index = (argument as { Input?: number }).Input;
  const bytes = index === undefined ? undefined : data.inputs[index]?.Pure?.bytes;
  return bytes ? normalizeSuiAddress(bcs.Address.parse(fromBase64(bytes))) : null;
}

/** The amount of the coin a command result produced: a gas split, or an address-balance withdrawal. */
function coinAmount(data: TransactionData, argument: unknown): bigint | null {
  const result = (argument as { Result?: number }).Result ?? (argument as { NestedResult?: [number, number] }).NestedResult?.[0];
  const command = result === undefined ? undefined : data.commands[result];
  if (command?.SplitCoins) return pureU64(data, command.SplitCoins.amounts[0]);
  const call = command?.MoveCall;
  if (call && call.function === "redeem_funds") {
    const index = (call.arguments[0] as { Input?: number }).Input;
    const withdrawal = index === undefined ? undefined : (data.inputs[index] as { FundsWithdrawal?: { reservation: { MaxAmountU64?: string } } })?.FundsWithdrawal;
    return withdrawal?.reservation.MaxAmountU64 ? BigInt(withdrawal.reservation.MaxAmountU64) : null;
  }
  return null;
}

export function createTradeFixtureChain(overrides: Partial<TradeFixtureState> = {}): TradeFixtureChain {
  const state: TradeFixtureState = {
    chainIdentifier: NON_PRODUCTION_MANIFEST.chainIdentifier,
    reads: "available",
    curve: tradeFixtureCurve(),
    sellBurnBps: 200n,
    pendingBurn: 0n,
    lifecycle: "Live",
    version: 40,
    sui: {},
    meme: {},
    simulation: "contract",
    execution: "complete",
    confirmation: "checkpointed",
    publicStartMs: TRADE_PUBLIC_START_MS,
    openingRoundMs: 0n,
    bids: {},
    clockMs: Number(TRADE_PUBLIC_START_MS) + 600_000,
    settlement: null,
    memeDecimals: TRADE_MEME_DECIMALS,
    quoteType: SUI_TYPE,
    quoteMetadata: null,
    ...overrides,
  };
  const calls: TradeFixtureCalls = { simulate: 0, execute: 0 };
  const landed = new Map<string, Landed>();
  let gasVersion = 7;
  const sharedByPath = new Map<string, Readonly<{ objectId: string; initialSharedVersion: string | number }>>(
    sharedObjectEntries(NON_PRODUCTION_MANIFEST.sharedObjects),
  );
  const sharedIds = new Map<string, string>(
    sharedObjectEntries(NON_PRODUCTION_MANIFEST.sharedObjects).map(([path, identity]) => [identity.objectId, path]),
  );

  const suiOf = (owner: string) => state.sui[normalizeSuiAddress(owner)] ?? DEFAULT_SUI;
  const memeOf = (owner: string) => state.meme[normalizeSuiAddress(owner)] ?? 0n;
  const totalBids = () => Object.values(state.bids).reduce((sum, bid) => sum + bid, 0n);

  function requireReads() {
    if (state.reads === "unavailable") throw new Error("The fixture node is not answering reads.");
  }

  function launchContent(): Uint8Array {
    const zero = 0n;
    const plan = { curveMemeBps: 6_900n, lpMemeBps: 2_000n, lpQuoteBps: 9_450n, protocolMemeBps: 100n, protocolQuoteBps: 100n, recipients: [] };
    return launchBcs
      .serialize({
        id: { id: { bytes: TRADE_LAUNCH_ID } },
        lifecycle: { [state.lifecycle]: true } as never,
        public_start_ms: state.publicStartMs,
        opening_round_ms: state.openingRoundMs,
        opening_round_bids: totalBids(),
        opening_round_quote: state.settlement ? state.settlement.quote : totalBids(),
        opening_round_meme: state.settlement?.meme ?? 0n,
        sell_burn_bps: state.sellBurnBps,
        virtual_quote: state.curve.virtualQuote,
        graduation_target: state.curve.graduationTarget,
        quote_fee_bps: state.curve.quoteFeeBps,
        meme_fee_bps: state.curve.memeFeeBps,
        venue: venueWitnessType(NON_PRODUCTION_MANIFEST.packages.migrators, "bluefin"),

        lp_fee_split: { routes: [{ destination: { kind: "Owner" }, bps: 5000n }, { destination: { kind: "AutoLp" }, bps: 2500n }, { destination: { kind: "HolderRewards" }, bps: 2500n }] },
        atomic_supply: memeAtomicSupply(state.memeDecimals),
        meme_reserve: state.curve.memeReserve,
        real_quote_reserve: state.curve.realQuoteReserve,
        pending_burn: state.pendingBurn,
        allocation_plan: plan,
        allocated_meme: zero,
        protocol_fees: { packageWitness: `${LAUNCHPAD}::blast_fun::PackageWitness`, origin: TRADE_LAUNCH_ID, partnerId: null, meme: zero, quote: zero, sui: zero },
        creator_meme_fees: zero,
        creator_quote_fees: zero,
        metadata_cap: { id: { id: { bytes: normalizeSuiAddress(`0x${"4e".repeat(32)}`) } } },
        curve_fee_cap_reassignment: { parent: TRADE_LAUNCH_ID, key: null, delay_ms: 172_800_000n, pending: null },
        creator_metadata_cap_reassignment: { parent: TRADE_LAUNCH_ID, key: null, delay_ms: 172_800_000n, pending: null },
        creator: null,
        curve_fee_cap_id: null,
        creator_metadata_cap_id: null,
        partner_id: null,
      })
      .toBytes();
  }

  function launchObject() {
    return {
      objectId: TRADE_LAUNCH_ID,
      version: String(state.version),
      digest: GAS_COIN.digest,
      owner: { $kind: "Shared" as const, Shared: { initialSharedVersion: LAUNCH_SHARED_VERSION } },
      type: `${LAUNCHPAD}::launch::Launch<${TRADE_MEME_TYPE}, ${normalizeStructTag(state.quoteType)}>`,
      content: launchContent(),
      previousTransaction: GAS_COIN.digest,
      json: null,
      objectBcs: undefined,
      display: undefined,
    };
  }

  function sharedObject(name: string) {
    const identity = sharedByPath.get(name)!;
    return {
      objectId: identity.objectId,
      version: "90",
      digest: GAS_COIN.digest,
      owner: { $kind: "Shared" as const, Shared: { initialSharedVersion: identity.initialSharedVersion } },
      type: SHARED_OBJECTS[name]!.type,
      content: fixtureSharedContent(name, identity.objectId),
      previousTransaction: GAS_COIN.digest,
      json: null,
      objectBcs: undefined,
      display: undefined,
    };
  }

  function clockObject() {
    return {
      objectId: CLOCK_ID,
      version: String(state.clockMs),
      digest: GAS_COIN.digest,
      owner: { $kind: "Shared" as const, Shared: { initialSharedVersion: "1" } },
      type: "0x2::clock::Clock",
      content: clockBcs.serialize({ id: CLOCK_ID, timestamp_ms: BigInt(state.clockMs) }).toBytes(),
      previousTransaction: GAS_COIN.digest,
      json: null,
      objectBcs: undefined,
      display: undefined,
    };
  }

  function lookupObject(id: string) {
    const objectId = normalizeSuiAddress(id);
    if (objectId === CLOCK_ID) return clockObject();
    const shared = sharedIds.get(objectId);
    if (shared) return sharedObject(shared);
    if (objectId === TRADE_LAUNCH_ID) return launchObject();
    return null;
  }

  /** Another wallet's settlement, applied under the contract's checks (a refused one changes nothing). */
  function settleByAnother() {
    settle(COMPETING_SETTLER, true, 0);
  }

  /** Applies an opening-round join the way `launch::join_opening_round` would; `commit` false only checks it. */
  function join(data: TransactionData, sender: string, commit: boolean, index: number): Landed {
    const call = data.commands[index]!.MoveCall!;
    const owner = normalizeSuiAddress(sender);
    const amount = coinAmount(data, call.arguments[2]);
    if (amount === null) return { status: failure("The join's coin could not be read."), events: [] };
    // `invalid_launch_lifecycle` (15), then `opening_round_ended` (18) by the clock, then `zero_opening_round_bid` (34).
    if (state.lifecycle !== "OpeningRound") return { status: abort("launch", "join_opening_round", 15, index), events: [] };
    if (BigInt(state.clockMs) >= state.publicStartMs + state.openingRoundMs) {
      return { status: abort("launch", "join_opening_round", 18, index), events: [] };
    }
    if (amount === 0n) return { status: abort("launch", "join_opening_round", 34, index), events: [] };
    if (suiOf(owner) < amount) return { status: failure("InsufficientCoinBalance: the gas coin cannot cover this join."), events: [] };
    const bids = totalBids() + amount;
    if (commit) {
      state.bids[owner] = (state.bids[owner] ?? 0n) + amount;
      state.sui[owner] = suiOf(owner) - amount;
      state.version += 1;
    }
    const payload = launchpadEventBcs.OpeningRoundJoined.serialize({ launch_id: TRADE_LAUNCH_ID, quote_amount: amount, bids });
    return { status: { success: true, error: null }, events: [event("OpeningRoundJoined", owner, payload.toBytes())] };
  }

  /**
   * Settles the round the way `launch::settle_opening_round` would; `commit` false only checks it. The whole
   * pot buys from the curve once with no minimum (a purchase that returns nothing leaves the pot for refund).
   */
  function settle(sender: string, commit: boolean, index: number): Landed {
    const owner = normalizeSuiAddress(sender);
    // `invalid_launch_lifecycle` (15), then `opening_round_not_ended` (19) by the clock.
    if (state.lifecycle !== "OpeningRound") return { status: abort("launch", "settle_opening_round", 15, index), events: [] };
    if (BigInt(state.clockMs) < state.publicStartMs + state.openingRoundMs) {
      return { status: abort("launch", "settle_opening_round", 19, index), events: [] };
    }
    const pot = totalBids();
    let bought: ReturnType<typeof previewBuy> | null = null;
    try {
      bought = pot > 0n ? previewBuy(state.curve, pot) : null;
    } catch {
      bought = null;
    }
    const settlement = { meme: bought?.memeOutNet ?? 0n, quote: bought ? bought.quoteRefund : pot };
    if (commit) {
      if (bought) state.curve = { ...state.curve, memeReserve: bought.memeReserveAfter, realQuoteReserve: bought.realQuoteReserveAfter };
      state.lifecycle = bought?.crossedThreshold ? "MigrationReady" : "Live";
      state.settlement = settlement;
      state.version += 1;
    }
    const payload = launchpadEventBcs.OpeningRoundSettled.serialize({ launch_id: TRADE_LAUNCH_ID, bids: pot, meme_amount: settlement.meme, quote_amount: settlement.quote });
    const settled = event("OpeningRoundSettled", owner, payload.toBytes());
    return { status: { success: true, error: null }, events: bought ? [boughtEvent(owner, bought), settled] : [settled] };
  }

  /**
   * Delivers `bidder`'s share the way `launch::deliver_opening_round` would; `commit` false only checks it. The
   * share is the held coin and refund pro rata to the bid among the undelivered bids, each rounded down, sent to
   * the bidder whoever signs.
   */
  function deliver(bidder: string, sender: string, commit: boolean, index: number): Landed {
    // `invalid_launch_lifecycle` (15) during the round; then `dynamic_field::remove` aborts without the bid (1).
    if (state.lifecycle === "OpeningRound") return { status: abort("launch", "deliver_opening_round", 15, index), events: [] };
    const bid = state.bids[bidder];
    if (bid === undefined) return { status: frameworkAbort("dynamic_field", "remove_child_object", 1, index), events: [] };
    const held = state.settlement ?? { meme: 0n, quote: 0n };
    const bids = totalBids();
    const meme = (held.meme * bid) / bids;
    const quote = (held.quote * bid) / bids;
    if (commit) {
      delete state.bids[bidder];
      state.settlement = { meme: held.meme - meme, quote: held.quote - quote };
      state.meme[bidder] = memeOf(bidder) + meme;
      state.sui[bidder] = suiOf(bidder) + quote;
      state.version += 1;
    }
    const payload = launchpadEventBcs.OpeningRoundDelivered.serialize({ launch_id: TRADE_LAUNCH_ID, bidder, bid, meme_amount: meme, quote_amount: quote });
    return { status: { success: true, error: null }, events: [event("OpeningRoundDelivered", normalizeSuiAddress(sender), payload.toBytes())] };
  }

  function buy(owner: string, amount: bigint, minimum: bigint, index: number, commit: boolean): Landed {
    if (suiOf(owner) < amount) return { status: failure("InsufficientCoinBalance: the gas coin cannot cover this purchase."), events: [] };
    const preview = previewBuy(state.curve, amount);
    // `slippage_exceeded` (16).
    if (preview.memeOutNet < minimum) return { status: abort("launch", "buy", 16, index), events: [] };
    if (commit) {
      state.curve = { ...state.curve, memeReserve: preview.memeReserveAfter, realQuoteReserve: preview.realQuoteReserveAfter };
      state.sui[owner] = suiOf(owner) - preview.quoteInGross;
      state.meme[owner] = memeOf(owner) + preview.memeOutNet;
      if (preview.crossedThreshold) state.lifecycle = "MigrationReady";
      state.version += 1;
    }
    return { status: { success: true, error: null }, events: [boughtEvent(owner, preview)] };
  }

  /** Applies a trade the way the contract would; `commit` false only checks it. */
  function trade(data: TransactionData, sender: string, commit: boolean): Landed {
    const deliverAt = data.commands.findIndex((command) => command.MoveCall?.module === "launch" && command.MoveCall.function === "deliver_opening_round");
    if (deliverAt >= 0) {
      const bidder = pureAddress(data, data.commands[deliverAt]!.MoveCall!.arguments[2]);
      if (bidder === null) return { status: failure("The delivery's bidder could not be read."), events: [] };
      return deliver(bidder, sender, commit, deliverAt);
    }
    const settleAt = data.commands.findIndex((command) => command.MoveCall?.module === "launch" && command.MoveCall.function === "settle_opening_round");
    if (settleAt >= 0) return settle(sender, commit, settleAt);
    const joinAt = data.commands.findIndex((command) => command.MoveCall?.module === "launch" && command.MoveCall.function === "join_opening_round");
    if (joinAt >= 0) return join(data, sender, commit, joinAt);
    const index = data.commands.findIndex((command) => command.MoveCall?.module === "launch" && ["buy", "sell"].includes(command.MoveCall.function));
    const call = data.commands[index]?.MoveCall;
    if (!call) return { status: failure("The fixture node only executes curve trades and opening-round joins, settlements and deliveries."), events: [] };
    const owner = normalizeSuiAddress(sender);
    const amount = coinAmount(data, call.arguments[3]);
    const minimum = pureU64(data, call.arguments[4]);
    if (amount === null || minimum === null) return { status: failure("The trade's coin or minimum could not be read."), events: [] };
    // `invalid_launch_lifecycle` (15): the curve trades only while Live.
    if (state.lifecycle !== "Live") return { status: abort("launch", call.function, 15, index), events: [] };
    if (call.function === "buy") return buy(owner, amount, minimum, index, commit);
    if (memeOf(owner) < amount) return { status: failure("InsufficientFundsForWithdraw: the address balance cannot cover this sale."), events: [] };
    const preview = previewSell(state.curve, amount, state.sellBurnBps);
    if (preview.quoteOutNet < minimum) return { status: abort("launch", "sell", 16, index), events: [] };
    if (commit) {
      state.curve = { ...state.curve, memeReserve: preview.memeReserveAfter, realQuoteReserve: preview.realQuoteReserveAfter };
      state.pendingBurn += preview.pendingBurnDelta;
      state.meme[owner] = memeOf(owner) - amount;
      state.sui[owner] = suiOf(owner) + preview.quoteOutNet;
      state.version += 1;
    }
    const payload = launchpadEventBcs.Sold.serialize({
      launch_id: TRADE_LAUNCH_ID,
      meme_in_gross: preview.memeInGross,
      pending_burn: preview.pendingBurnDelta,
      quote_out_gross: preview.quoteOutGross,
      protocol_meme_fee: preview.memeFee,
      creator_meme_fee: 0n,
      protocol_quote_fee: preview.quoteFee,
      creator_quote_fee: 0n,
      meme_reserve: preview.memeReserveAfter,
      real_quote_reserve: preview.realQuoteReserveAfter,
    });
    return { status: { success: true, error: null }, events: [event("Sold", owner, payload.toBytes())] };
  }

  function executeTrade(data: TransactionData, sender: string): Landed {
    const call = data.commands.find((command) => command.MoveCall?.module === "launch")?.MoveCall;
    const code = call?.function === "join_opening_round" ? 18 : call?.function === "settle_opening_round" ? 15 : 17;
    return state.execution === "abort"
      ? call?.function === "deliver_opening_round"
        ? { status: frameworkAbort("dynamic_field", "remove_child_object", 1, 0), events: [] }
        : { status: abort("launch", call?.function ?? "buy", code, 1), events: [] }
      : state.execution === "out-of-gas"
        ? { status: failure("InsufficientGas: the transaction ran out of gas."), events: [] }
        : state.execution === "no-evidence"
          ? { status: { success: true as const, error: null }, events: [] }
          : trade(data, sender, true);
  }

  function result(digest: string, found: Landed, checkpoint: string | null) {
    const transaction = {
      digest,
      signatures: [],
      epoch: "3",
      timestampMs: null,
      checkpoint,
      status: found.status,
      balanceChanges: undefined,
      effects: {
        bcs: null,
        version: 2,
        status: found.status,
        gasUsed: { computationCost: "1000", storageCost: "0", storageRebate: "0", nonRefundableStorageFee: "0" },
        transactionDigest: digest,
        gasObject: null,
        eventsDigest: null,
        dependencies: [],
        lamportVersion: null,
        changedObjects: [],
        unchangedConsensusObjects: [],
        auxiliaryDataDigest: null,
      },
      events: found.events,
      objectTypes: {},
      transaction: undefined,
      bcs: undefined,
    };
    return found.status.success
      ? { $kind: "Transaction" as const, Transaction: transaction }
      : { $kind: "FailedTransaction" as const, FailedTransaction: transaction };
  }

  function lookupTransaction(digest: string) {
    requireReads();
    const found = landed.get(digest);
    if (!found) throw new Error(`Transaction ${digest} was not found.`);
    if (state.confirmation === "pending") throw new Error(`Transaction ${digest} is not checkpointed yet.`);
    return result(digest, found, FIXTURE_CHECKPOINT);
  }

  const core = {
    async getChainIdentifier() {
      requireReads();
      return { chainIdentifier: state.chainIdentifier };
    },
    async getObjects({ objectIds }: Readonly<{ objectIds: readonly string[] }>) {
      requireReads();
      return { objects: objectIds.map((id) => lookupObject(id) ?? new Error(`Object ${id} does not exist.`)) };
    },
    async getObject({ objectId }: Readonly<{ objectId: string }>) {
      requireReads();
      const object = lookupObject(objectId);
      if (!object) throw new ObjectError("notFound", `Object ${objectId} does not exist.`, { reason: "notFound" });
      return { object };
    },
    async getCoinMetadata({ coinType }: SuiClientTypes.GetCoinMetadataOptions): Promise<SuiClientTypes.GetCoinMetadataResponse> {
      requireReads();
      return { coinMetadata: normalizeStructTag(coinType) === normalizeStructTag(state.quoteType) ? state.quoteMetadata : null };
    },
    async getBalance({ owner, coinType = SUI_TYPE }: Readonly<{ owner: string; coinType?: string }>) {
      requireReads();
      const type = normalizeStructTag(coinType);
      if (type === TRADE_MEME_TYPE) {
        const balance = String(memeOf(owner));
        // The coin sits in the address balance, so a sale withdraws it from there.
        return { balance: { coinType: type, balance, coinBalance: "0", addressBalance: balance } };
      }
      const balance = String(suiOf(owner));
      return { balance: { coinType: SUI_TYPE, balance, coinBalance: balance, addressBalance: "0" } };
    },
    async getDynamicField({ parentId, name }: Readonly<{ parentId: string; name: Readonly<{ type: string; bcs: Uint8Array }> }>) {
      requireReads();
      const bidder = normalizeSuiAddress(bcs.Address.parse(name.bcs));
      const bid = state.bids[bidder];
      if (normalizeSuiAddress(parentId) !== TRADE_LAUNCH_ID || name.type !== `${LAUNCHPAD}::launch::OpeningRoundBidKey` || bid === undefined) {
        throw new ObjectError("notFound", `No dynamic field ${name.type} on ${parentId}.`, { reason: "notFound" });
      }
      return { dynamicField: { name, value: { type: "u64", bcs: bcs.u64().serialize(bid).toBytes() } } };
    },
    async listCoins() {
      requireReads();
      return { objects: [], hasNextPage: false, cursor: null };
    },
    resolveTransactionPlugin() {
      return async (data: TransactionDataBuilder, _options: unknown, next: () => Promise<void>) => {
        data.gasData.price ??= "1000";
        data.gasData.budget ??= "50000000";
        data.gasData.payment ??= [{ ...GAS_COIN, version: String(gasVersion) }];
        await next();
      };
    },
    async simulateTransaction({ transaction }: Readonly<{ transaction: Uint8Array }>) {
      calls.simulate += 1;
      if (state.simulation === "unavailable") throw new Error("The fixture node cannot simulate right now.");
      const digest = TransactionDataBuilder.getDigestFromBytes(transaction);
      const data = Transaction.from(transaction).getData();
      const checked = trade(data, data.sender ?? "0x0", false);
      return { ...result(digest, { status: checked.status, events: [] }, null), commandResults: undefined };
    },
    async executeTransaction({ transaction, signatures }: Readonly<{ transaction: Uint8Array; signatures: string[] }>) {
      calls.execute += 1;
      const signer = await verifyTransactionSignature(transaction, signatures[0] ?? "", { offline: true });
      const digest = TransactionDataBuilder.getDigestFromBytes(transaction);
      const data = Transaction.from(transaction).getData();
      gasVersion += 1;
      // `abort`: the trade aborts on chain with `zero_trade_output` (17) in its own function; a join, with
      // `opening_round_ended` (18), as when the round ends between simulation and execution; a settlement, with
      // `invalid_launch_lifecycle` (15); a delivery, in `dynamic_field::remove` (1), as when its bid is gone.
      // `preempted`: another wallet's settlement, or its delivery to the same bidder, lands first.
      const call = data.commands.find((command) => command.MoveCall?.module === "launch")?.MoveCall;
      if (state.execution === "preempted" && call?.function === "deliver_opening_round") {
        const bidder = pureAddress(data, call.arguments[2]);
        if (bidder !== null) deliver(bidder, COMPETING_SETTLER, true, 0);
      } else if (state.execution === "preempted" && state.lifecycle === "OpeningRound") settleByAnother();
      const executed = executeTrade(data, signer.toSuiAddress());
      landed.set(digest, executed);
      if (state.execution === "unknown") throw new Error("The Sui node closed the connection before answering.");
      return result(digest, executed, null);
    },
    async waitForTransaction({ digest }: Readonly<{ digest: string }>) {
      return lookupTransaction(digest);
    },
    async getTransaction({ digest }: Readonly<{ digest: string }>) {
      return lookupTransaction(digest);
    },
  };

  return {
    client: { core } as unknown as ClientWithCoreApi,
    state,
    calls,
    competingBuy(quoteAmount) {
      const preview = previewBuy(state.curve, quoteAmount);
      state.curve = { ...state.curve, memeReserve: preview.memeReserveAfter, realQuoteReserve: preview.realQuoteReserveAfter };
      if (preview.crossedThreshold) state.lifecycle = "MigrationReady";
      state.version += 1;
    },
    competingJoin(bidder, quoteAmount) {
      const owner = normalizeSuiAddress(bidder);
      state.bids[owner] = (state.bids[owner] ?? 0n) + quoteAmount;
      state.version += 1;
    },
    competingSettle: settleByAnother,
    competingDeliver(bidder) {
      deliver(normalizeSuiAddress(bidder), COMPETING_SETTLER, true, 0);
    },
    transactionOf(digest) {
      const found = landed.get(digest);
      if (!found || state.confirmation === "pending") return null;
      return { digest, success: found.status.success, checkpoint: FIXTURE_CHECKPOINT, timestampMs: state.clockMs, events: found.events };
    },
  };
}
