// A fixture Sui node for migrated-venue trading: one launch migrated to a
// Cetus CLMM pool and one migrated to Bluefin Spot, their migration
// transactions (the launchpad's `Migrated` and the vault's `VaultCreated`),
// the LP vault and venue pool objects in their real BCS layouts, balances, a
// Cetus swap that follows the SDK-built transaction exactly (flash swap, pay,
// repay, and the minimum-output split) and emits a real `pool::SwapEvent`, and
// a Bluefin `pool::swap` that follows the SDK-built transaction (exact input,
// `amount_limit` as the minimum output, Bluefin's `slippage_exceeds` abort
// below it) and emits a real `events::AssetSwap`. Both pools price with a
// constant-product stand-in for the venues' tick math, which the web never
// computes. It serves adapter, controller, and harness checks, never real
// value.

import { SUI_COIN_TYPE as SUI_TYPE } from "@blast/core/lib/sui/coin-types.ts";
import { fixtureSharedContent, runtimeFor } from "../../../../../../packages/core/test/fixtures/modules/launchpad-coin/deployment-runtime.ts";
import { sharedObjectEntries, type BlastDeploymentInput } from "@interest-protocol/blast-sdk/deployments";
import { launchBcs, launchpadEventBcs, memeAtomicSupply } from "@interest-protocol/blast-sdk/launchpad";
import {
  BLUEFIN_MAX_SQRT_PRICE_X64,
  BLUEFIN_MIN_SQRT_PRICE_X64,
  bluefinPoolBcs,
  bluefinPoolTierBcs,
  bluefinSwapEventBcs,
  CETUS_MAX_SQRT_PRICE_X64,
  CETUS_MIN_SQRT_PRICE_X64,
  cetusPoolPrefixBcs,
  cetusSwapEventBcs,
  venueWitnessType,
} from "@interest-protocol/blast-sdk/migrators";
import { vaultBcs, vaultEventBcs, vaultId } from "@interest-protocol/blast-sdk/vault";
import type { VaultTerms } from "@interest-protocol/blast-core/migration";
import { bcs } from "@mysten/sui/bcs";
import { ObjectError, SimulationError, type ClientWithCoreApi, type SuiClientTypes } from "@mysten/sui/client";
import { Transaction, TransactionDataBuilder } from "@mysten/sui/transactions";
import { fromBase64, normalizeStructTag, normalizeSuiAddress } from "@mysten/sui/utils";
import { verifyTransactionSignature } from "@mysten/sui/verify";

import { NON_PRODUCTION_MANIFEST } from "../transaction/fixtures.ts";

/**
 * Cetus CLMM revision 15's lineage and the Cetus shared objects, copied from
 * the SDK's venue fixture (sdk eb23457 `test/fixtures/venue-deployment.ts`,
 * itself copied from contracts 442116a `sui/launchpad/ptb_tests/fork`). They
 * are mainnet venue identities used as fixture data on a non-production
 * manifest.
 */
const CETUS = {
  cetusClmm: {
    packageId: "0x260693ec785a6e6c9d81d58c7d2ff72f1288ae0fa6a9725abe05a6478b11f084",
    originalPackageId: "0x1eabed72c53feb3805120a081dc15963c204dc8d091542592abaf7a35689b2fb",
  },
  cetusLpBurn: {
    packageId: "0xc4aabc874f5060d3147d8f74c14e3a8a1f9f8d92edea138a51635395ed167cd9",
    originalPackageId: "0x12d73de9a6bc3cb658ec9dc0fe7de2662be1cea5c76c092fcc3606048cdbac27",
  },
  cetusConfig: { objectId: "0xdaa46292632c3c4d8f31f23ea0f9b36a28ff3677e9684980e4438403a67a3d8f", initialSharedVersion: "1574190" },
  cetusPools: { objectId: "0xf699e7f2276f5c9a75944b37a0c5b5d9ddfd2471bf6242483b03ab2887d198d0", initialSharedVersion: "1574190" },
  cetusBurnManager: { objectId: "0x1d94aa32518d0cb00f9de6ed60d450c9a2090761f326752ffad06b2e9404f845", initialSharedVersion: "327723159" },
} as const;

/**
 * Bluefin Spot revision 17's lineage and its `GlobalConfig`, copied from the
 * same SDK fixture (sdk eb23457 `test/fixtures/venue-deployment.ts`,
 * `VENUE_LINEAGE`). Mainnet venue identities used as fixture data only.
 */
const BLUEFIN = {
  bluefinSpot: {
    packageId: "0xd075338d105482f1527cbfd363d6413558f184dec36d9138a70261e87f486e9c",
    originalPackageId: "0x3492c874c1e3b3e2984e8c41b589e642d4d0a5d6459e5a9cfc2d52fd7c89c267",
  },
  bluefinConfig: { objectId: "0x03db251ba509a8d5d8777b6338836082335d93eecbdd09a11e190a1cff51c352", initialSharedVersion: "406496849" },
} as const;

/**
 * The non-production manifest with the complete Cetus and Bluefin sets, the
 * Cetus 200 / 1% route and the Bluefin 60 / 0.3% and 200 / 1% routes, as the
 * SDK's `manifestWithVenues(["cetus", "bluefin"])`.
 */
export const VENUE_FIXTURE_MANIFEST = {
  ...NON_PRODUCTION_MANIFEST,
  packages: { ...NON_PRODUCTION_MANIFEST.packages, cetusClmm: CETUS.cetusClmm, cetusLpBurn: CETUS.cetusLpBurn, bluefinSpot: BLUEFIN.bluefinSpot },
  sharedObjects: {
    ...NON_PRODUCTION_MANIFEST.sharedObjects,
    cetus: { config: CETUS.cetusConfig, pools: CETUS.cetusPools, burnManager: CETUS.cetusBurnManager },
    bluefin: { config: BLUEFIN.bluefinConfig },
  },
  routes: [{ venue: "cetus", tiers: [{ tickSpacing: 200, feeRate: "10000" }] }, ...NON_PRODUCTION_MANIFEST.routes],
} as const satisfies BlastDeploymentInput;

const LAUNCHPAD = normalizeSuiAddress(NON_PRODUCTION_MANIFEST.packages.launchpad.originalPackageId);
const MIGRATORS = NON_PRODUCTION_MANIFEST.packages.migrators;
const VAULT_PACKAGE = NON_PRODUCTION_MANIFEST.packages.vault.originalPackageId;
const VAULT_REGISTRY = {
  originalPackageId: VAULT_PACKAGE,
  registry: NON_PRODUCTION_MANIFEST.sharedObjects.vault.registry,
};
const PACKAGE_WITNESS = `${LAUNCHPAD}::blast_fun::PackageWitness`;
const CETUS_ORIGINAL = normalizeSuiAddress(CETUS.cetusClmm.originalPackageId);
const CETUS_PACKAGE = normalizeSuiAddress(CETUS.cetusClmm.packageId);
const BLUEFIN_ORIGINAL = normalizeSuiAddress(BLUEFIN.bluefinSpot.originalPackageId);
const BLUEFIN_PACKAGE = normalizeSuiAddress(BLUEFIN.bluefinSpot.packageId);

/** The fixture coin, its Cetus-migrated launch, vault, pool, and migration. */
export const VENUE_MEME_TYPE = normalizeStructTag(`0x${"5e".repeat(32)}::frog::FROG`);
export const VENUE_MEME_DECIMALS = 9;
export const CETUS_LAUNCH_ID = normalizeSuiAddress(`0x${"2c".repeat(32)}`);
export const CETUS_VAULT_ID = vaultId(VAULT_REGISTRY, PACKAGE_WITNESS, CETUS_LAUNCH_ID);
export const CETUS_POOL_ID = normalizeSuiAddress(`0x${"4c".repeat(32)}`);
/** Another Cetus pool of the same coins and tier, which the launch did not record. */
export const OTHER_CETUS_POOL_ID = normalizeSuiAddress(`0x${"7c".repeat(32)}`);

/** The Bluefin fixture coin (six decimals, unlike FROG), its Bluefin-migrated launch, vault, pool, and migration. */
export const BLUEFIN_MEME_TYPE = normalizeStructTag(`0x${"5b".repeat(32)}::newt::NEWT`);
export const BLUEFIN_MEME_DECIMALS = 6;
export const BLUEFIN_LAUNCH_ID = normalizeSuiAddress(`0x${"2b".repeat(32)}`);
export const BLUEFIN_VAULT_ID = vaultId(VAULT_REGISTRY, PACKAGE_WITNESS, BLUEFIN_LAUNCH_ID);
export const BLUEFIN_POOL_ID = normalizeSuiAddress(`0x${"4b".repeat(32)}`);
/** Another Bluefin pool of the same coins and tier, which the launch did not record. */
export const OTHER_BLUEFIN_POOL_ID = normalizeSuiAddress(`0x${"7b".repeat(32)}`);
/** The Bluefin pool's recorded fee rate, in millionths: the 60-spacing tier's 0.3%. */
export const BLUEFIN_FEE_RATE = 3_000n;

const digestOf = (label: string) => TransactionDataBuilder.getDigestFromBytes(new TextEncoder().encode(label));
export const CETUS_MIGRATION_DIGEST = digestOf("venue-fixture:cetus-migration");
export const BLUEFIN_MIGRATION_DIGEST = digestOf("venue-fixture:bluefin-migration");
/** A migration of another launch, as a substituted record would name. */
export const OTHER_MIGRATION_DIGEST = digestOf("venue-fixture:other-migration");

const GAS_COIN = { objectId: normalizeSuiAddress(`0x${"6f".repeat(32)}`), digest: "BMwg3HvPTPQaKr9Lnk5jjNkw1bseCftzVgdaGksass4W" };
const POOL_SHARED_VERSION = "1016519798";
const BLUEFIN_POOL_SHARED_VERSION = "1016519806";
/** Cetus fee in millionths of the input: the 200-spacing tier's 1%. */
const FEE_RATE = 10_000n;
const Q128 = 1n << 128n;
/** Bluefin Spot `errors::slippage_exceeds()` (interface 91ce930): the output is below `amount_limit`. */
export const BLUEFIN_SLIPPAGE_EXCEEDS = 1010;

const SHARED_OBJECTS = runtimeFor(VENUE_FIXTURE_MANIFEST).sharedObjects;

export type VenueFixtureState = {
  quoteType: string;
  chainIdentifier: string;
  reads: "available" | "unavailable";
  /** `mismatch`: the node reports the Cetus `GlobalConfig` with another type, so the SDK marks Cetus unavailable. */
  cetusConfig: "observed" | "mismatch";
  /** The Cetus pool's coin balances: SUI is coin A, the Meme coin B. */
  pool: { sui: bigint; meme: bigint };
  /** The pool object's version; every swap advances it. */
  poolVersion: number;
  /** Atomic SUI per owner; an absent owner holds 100 SUI. */
  sui: Record<string, bigint>;
  /** Atomic Meme per owner; an absent owner holds none. */
  meme: Record<string, bigint>;
  /**
   * The deployment's recorded Bluefin `GlobalConfig` as the node reports it:
   * `mismatch` with another type, `absent` not at all. Either way the SDK
   * marks Bluefin unavailable.
   */
  bluefinConfig: "observed" | "mismatch" | "absent";
  /** `absent`: the node has no object at the launch's recorded Bluefin pool. */
  bluefinPoolObject: "present" | "absent";
  /** `changed`: Bluefin added a field to its `Pool`, so the pool is no longer in the v17 layout. */
  bluefinPoolLayout: "v17" | "changed";
  /** The Bluefin pool's coin balances: the Meme is coin A, SUI coin B. */
  bluefinReserves: { meme: bigint; sui: bigint };
  bluefinPoolVersion: number;
  /** The Bluefin pool's fee rate in millionths; anything but the launch's recorded 3,000 is a Bluefin fee change. */
  bluefinFeeRate: bigint;
  /** Atomic NEWT (the Bluefin coin) per owner; an absent owner holds none. */
  newt: Record<string, bigint>;
  /** `unavailable`: the node cannot simulate Bluefin swaps, so the Bluefin quote provider is out. */
  bluefinProvider: "available" | "unavailable";
  /** `after-quote`: another trader buys 500 SUI on the Bluefin pool right after the next quote (once). */
  bluefinRace: "none" | "after-quote";
  /** `unavailable`: the node cannot simulate, so no quote or review can be made. */
  simulation: "contract" | "unavailable";
  /**
   * `unknown`: the swap lands but the submission answer is lost; `abort`: it
   * aborts on chain; `no-swap-event`: it completes without the venue's swap
   * event, so its effects never reconcile with the signed quote.
   */
  execution: "complete" | "abort" | "unknown" | "no-swap-event";
  confirmation: "checkpointed" | "pending";
  /**
   * `estimated`: like a real node's client, building a transaction without a
   * gas budget simulates it to estimate one, so a swap that would fail fails
   * the build with the client's `SimulationError`; `preset`: the build sets a
   * budget and never simulates.
   */
  gasBudget: "preset" | "estimated";
};

export type VenueFixtureCalls = { simulate: number; execute: number };

export type VenueFixtureChain = Readonly<{
  client: ClientWithCoreApi;
  state: VenueFixtureState;
  calls: VenueFixtureCalls;
  /** The exact transactions the node simulated, newest last. */
  simulated: Uint8Array[];
  /** The exact signed transactions the node executed, newest last. */
  executed: Uint8Array[];
  /** Another trader buys with `sui` atoms, moving the pool's price. */
  competingBuy(sui: bigint): void;
  /** Another trader buys with `sui` atoms on the Bluefin pool. */
  competingBluefinBuy(sui: bigint): void;
}>;

const DEFAULT_SUI = 100_000_000_000n;
type Landed = { status: SuiClientTypes.ExecutionStatus; events: SuiClientTypes.Event[] };
type TransactionData = ReturnType<Transaction["getData"]>;

function failure(message: string): SuiClientTypes.ExecutionStatus {
  return { success: false, error: { $kind: "Unknown", message, Unknown: null } as unknown as SuiClientTypes.ExecutionError };
}

function abort(module: string, fn: string, code: number, address = "0x2"): SuiClientTypes.ExecutionStatus {
  const location = `${normalizeSuiAddress(address)}::${module}::${fn}`;
  return {
    success: false,
    error: {
      $kind: "MoveAbort",
      message: `MoveAbort in command, abort code: ${code}, in '${location}' (instruction 9)`,
      MoveAbort: { abortCode: String(code), location: { package: normalizeSuiAddress(address), module, functionName: fn } },
    } as SuiClientTypes.ExecutionError,
  };
}

function isqrt(value: bigint): bigint {
  if (value < 2n) return value;
  let x = value;
  let y = (x + 1n) / 2n;
  while (y < x) {
    x = y;
    y = (x + value / x) / 2n;
  }
  return x;
}

/** Cetus's Q64.64 square-root price of coin B per coin A for these balances, clamped to its range. */
function sqrtPriceX64(balanceA: bigint, balanceB: bigint): bigint {
  const raw = isqrt((balanceB * Q128) / balanceA);
  return raw < CETUS_MIN_SQRT_PRICE_X64 ? CETUS_MIN_SQRT_PRICE_X64 : raw > CETUS_MAX_SQRT_PRICE_X64 ? CETUS_MAX_SQRT_PRICE_X64 : raw;
}

/** Bluefin's Q64.64 square-root price of coin B (SUI) per coin A (the Meme), clamped to its range. */
function bluefinSqrtPriceX64(meme: bigint, sui: bigint): bigint {
  const raw = isqrt((sui * Q128) / meme);
  return raw < BLUEFIN_MIN_SQRT_PRICE_X64 ? BLUEFIN_MIN_SQRT_PRICE_X64 : raw > BLUEFIN_MAX_SQRT_PRICE_X64 ? BLUEFIN_MAX_SQRT_PRICE_X64 : raw;
}

function inputIndex(argument: unknown): number | undefined {
  return (argument as { Input?: number }).Input;
}

function pure<T>(data: TransactionData, argument: unknown, type: { parse(bytes: Uint8Array): T }): T | null {
  const index = inputIndex(argument);
  const bytes = index === undefined ? undefined : data.inputs[index]?.Pure?.bytes;
  return bytes ? type.parse(fromBase64(bytes)) : null;
}

function sharedId(data: TransactionData, argument: unknown): string | null {
  const index = inputIndex(argument);
  const object = index === undefined ? undefined : (data.inputs[index] as { Object?: { SharedObject?: { objectId: string } } })?.Object;
  return object?.SharedObject ? normalizeSuiAddress(object.SharedObject.objectId) : null;
}

function resultOf(argument: unknown): number | undefined {
  return (argument as { Result?: number }).Result ?? (argument as { NestedResult?: [number, number] }).NestedResult?.[0];
}

/** The amount of the coin a command result produced: a gas split, or an address-balance withdrawal. */
function coinAmount(data: TransactionData, argument: unknown): bigint | null {
  const result = resultOf(argument);
  const command = result === undefined ? undefined : data.commands[result];
  if (command?.SplitCoins) {
    const amount = pure(data, command.SplitCoins.amounts[0], bcs.u64());
    return amount === null ? null : BigInt(amount);
  }
  const call = command?.MoveCall;
  if (call && call.function === "redeem_funds") {
    const index = inputIndex(call.arguments[0]);
    const withdrawal = index === undefined ? undefined : (data.inputs[index] as { FundsWithdrawal?: { reservation: { MaxAmountU64?: string } } })?.FundsWithdrawal;
    return withdrawal?.reservation.MaxAmountU64 ? BigInt(withdrawal.reservation.MaxAmountU64) : null;
  }
  return null;
}

function launchContent(
  launchId: string,
  witness: string,
  decimals: number,
): Uint8Array {
  const zero = 0n;
  const plan = { curveMemeBps: 6_900n, lpMemeBps: 2_000n, lpQuoteBps: 9_450n, protocolMemeBps: 100n, protocolQuoteBps: 100n, recipients: [] };
  return launchBcs
    .serialize({
      id: { id: { bytes: launchId } },
      lifecycle: { Migrated: true } as never,
      public_start_ms: 1_790_000_000_000n,
      opening_round_ms: 0n,
      opening_round_bids: 0n,
      opening_round_quote: zero,
      opening_round_meme: zero,
      sell_burn_bps: 200n,
      virtual_quote: 3_000_000_000_000n,
      graduation_target: 12_000_000_000_000n,
      quote_fee_bps: 100n,
      meme_fee_bps: 0n,
      venue: witness,

      lp_fee_split: { routes: [{ destination: { kind: "Owner" }, bps: 5000n }, { destination: { kind: "AutoLp" }, bps: 2500n }, { destination: { kind: "HolderRewards" }, bps: 2500n }] },
      atomic_supply: memeAtomicSupply(decimals),
      meme_reserve: zero,
      real_quote_reserve: zero,
      pending_burn: zero,
      allocation_plan: plan,
      allocated_meme: zero,
      protocol_fees: { packageWitness: PACKAGE_WITNESS, origin: launchId, partnerId: null, meme: zero, quote: zero, sui: zero },
        creator_meme_fees: zero,
        creator_quote_fees: zero,
      metadata_cap: { id: { id: { bytes: normalizeSuiAddress(`0x${"4e".repeat(32)}`) } } },
      curve_fee_cap_reassignment: { parent: launchId, key: null, delay_ms: 172_800_000n, pending: null },
        creator_metadata_cap_reassignment: { parent: launchId, key: null, delay_ms: 172_800_000n, pending: null },
      creator: null,
      curve_fee_cap_id: null,
      creator_metadata_cap_id: null,
      partner_id: null,
    })
    .toBytes();
}

function vaultTerms(launchId: string): VaultTerms {
  return {
    origin: launchId,
    packageWitness: PACKAGE_WITNESS,
    feeSplit: {
      routes: [
        { destination: { kind: "Owner" }, bps: 5000n },
        { destination: { kind: "AutoLp" }, bps: 2500n },
        { destination: { kind: "HolderRewards" }, bps: 2500n },
      ],
    },
    protocolMemeBps: 0n,
    protocolQuoteBps: 0n,
    partnerId: null,
    residuals: "Protocol",
  };
}

function vaultContent(vaultId: string, poolId: string, launchId: string, venue: "cetus" | "bluefin"): Uint8Array {
  const terms = vaultTerms(launchId);
  const delayed = { parent: vaultId, key: null, delay_ms: 0n, pending: null };
  return vaultBcs.serialize({
    id: { id: { bytes: vaultId } },
    terms,
    venue: venueWitnessType(MIGRATORS, venue),
    pool_id: poolId,
    fee_split: { ...delayed, value: terms.feeSplit },
    protocol_bps: { ...delayed, value: { meme_bps: 0n, quote_bps: 0n } },
    protocol: { packageWitness: `${VAULT_PACKAGE}::blast_vault_package::PackageWitness`, origin: vaultId, partnerId: null, meme: 0n, quote: 0n, sui: 0n },
    owner_meme: 0n,
    owner_quote: 0n,
    auto_lp_meme: 0n,
    auto_lp_quote: 0n,
    rewards_meme: 0n,
    rewards_quote: 0n,
    burn_quote: 0n,
    next_round: 0n,
    last_checkpoint: null,
    round_publication: delayed,
  }).toBytes();
}

function object(objectId: string, type: string, initialSharedVersion: string, content: Uint8Array, version = "90") {
  return {
    objectId,
    version,
    digest: GAS_COIN.digest,
    owner: { $kind: "Shared" as const, Shared: { initialSharedVersion } },
    type,
    content,
    previousTransaction: GAS_COIN.digest,
    json: null,
    objectBcs: undefined,
    display: undefined,
  };
}

function eventEntry(type: string, module: string, sender: string, payload: Uint8Array): SuiClientTypes.Event {
  const tag = type.split("::")[0]!;
  return { packageId: tag, module, sender, eventType: type, bcs: payload, json: null };
}

type MigratedVenue = Readonly<{ venue: "cetus" | "bluefin"; vaultId: string; poolId: string; memeType: string; decimals: number }>;

const CETUS_MIGRATED: MigratedVenue = { venue: "cetus", vaultId: CETUS_VAULT_ID, poolId: CETUS_POOL_ID, memeType: VENUE_MEME_TYPE, decimals: VENUE_MEME_DECIMALS };
const BLUEFIN_MIGRATED: MigratedVenue = {
  venue: "bluefin",
  vaultId: BLUEFIN_VAULT_ID,
  poolId: BLUEFIN_POOL_ID,
  memeType: BLUEFIN_MEME_TYPE,
  decimals: BLUEFIN_MEME_DECIMALS,
};

/** The migration transaction of `launchId` that created `migrated`'s vault and pool. */
function migrationEvents(launchId: string, migrated: MigratedVenue = CETUS_MIGRATED, quoteType = SUI_TYPE): SuiClientTypes.Event[] {
  const migratedEvent = launchpadEventBcs.Migrated.serialize({
    launch_id: launchId,
    meme_amount: memeAtomicSupply(migrated.decimals) / 5n,
    quote_amount: 11_000_000_000_000n,
    disposed_meme: 0n,
    total_supply_after: memeAtomicSupply(migrated.decimals),
  });
  const created = vaultEventBcs.VaultCreated.serialize({
    vault_id: migrated.vaultId,
    pool_id: migrated.poolId,
    position_id: normalizeSuiAddress(`0x${"8c".repeat(32)}`),
    liquidity: 2_056_088_519_495n,
    terms: vaultTerms(launchId),
    residual_meme_amount: 0n,
    residual_quote_amount: 0n,
  });
  const sender = normalizeSuiAddress(`0x${"9a".repeat(32)}`);
  return [
    eventEntry(`${LAUNCHPAD}::events::Migrated<${migrated.memeType},${quoteType}>`, "launch", sender, migratedEvent.toBytes()),
    eventEntry(`${VAULT_PACKAGE}::blast_vault_events::VaultCreated<${migrated.memeType},${quoteType},${venueWitnessType(MIGRATORS, migrated.venue)}>`, migrated.venue, sender, created.toBytes()),
  ];
}

function intoBalanceAmount(data: TransactionData): bigint | null {
  const into = data.commands.find((command) => command.MoveCall?.function === "into_balance")?.MoveCall;
  return into ? coinAmount(data, into.arguments[0]) : null;
}

function minimumSwapOutput(data: TransactionData): string | null {
  const floor = data.commands.find((command) => command.SplitCoins && data.commands[resultOf(command.SplitCoins.coin) ?? -1]?.MoveCall?.function === "from_balance");
  return floor?.SplitCoins ? pure(data, floor.SplitCoins.amounts[0], bcs.u64()) : null;
}

export function createVenueFixtureChain(overrides: Partial<VenueFixtureState> = {}): VenueFixtureChain {
  const state: VenueFixtureState = {
    quoteType: SUI_TYPE,
    chainIdentifier: NON_PRODUCTION_MANIFEST.chainIdentifier,
    reads: "available",
    cetusConfig: "observed",
    pool: { sui: 11_000_000_000_000n, meme: 200_000_000_000_000_000n },
    poolVersion: 60,
    sui: {},
    meme: {},
    bluefinConfig: "observed",
    bluefinPoolObject: "present",
    bluefinPoolLayout: "v17",
    bluefinReserves: { meme: memeAtomicSupply(BLUEFIN_MEME_DECIMALS) / 5n, sui: 11_000_000_000_000n },
    bluefinPoolVersion: 70,
    bluefinFeeRate: BLUEFIN_FEE_RATE,
    newt: {},
    bluefinProvider: "available",
    bluefinRace: "none",
    simulation: "contract",
    execution: "complete",
    confirmation: "checkpointed",
    gasBudget: "preset",
    ...overrides,
  };
  const calls: VenueFixtureCalls = { simulate: 0, execute: 0 };
  const simulated: Uint8Array[] = [];
  const executed: Uint8Array[] = [];
  const QUOTE_TYPE = normalizeStructTag(state.quoteType);
  const migrations = new Set([CETUS_MIGRATION_DIGEST, BLUEFIN_MIGRATION_DIGEST, OTHER_MIGRATION_DIGEST]);
  const landed = new Map<string, Landed>([
    [CETUS_MIGRATION_DIGEST, { status: { success: true, error: null }, events: migrationEvents(CETUS_LAUNCH_ID, CETUS_MIGRATED, QUOTE_TYPE) }],
    [BLUEFIN_MIGRATION_DIGEST, { status: { success: true, error: null }, events: migrationEvents(BLUEFIN_LAUNCH_ID, BLUEFIN_MIGRATED, QUOTE_TYPE) }],
    [OTHER_MIGRATION_DIGEST, { status: { success: true, error: null }, events: migrationEvents(normalizeSuiAddress(`0x${"2d".repeat(32)}`), CETUS_MIGRATED, QUOTE_TYPE) }],
  ]);
  let gasVersion = 7;
  let bluefinSequence = 1n;
  const sharedByPath = new Map<string, Readonly<{ objectId: string; initialSharedVersion: string | number }>>(
    sharedObjectEntries(VENUE_FIXTURE_MANIFEST.sharedObjects),
  );
  const sharedIds = new Map<string, string>(
    sharedObjectEntries(VENUE_FIXTURE_MANIFEST.sharedObjects).map(([path, identity]) => [
      normalizeSuiAddress(identity.objectId),
      path,
    ]),
  );

  const suiOf = (owner: string) => state.sui[normalizeSuiAddress(owner)] ?? DEFAULT_SUI;
  const memeOf = (owner: string) => state.meme[normalizeSuiAddress(owner)] ?? 0n;
  const newtOf = (owner: string) => state.newt[normalizeSuiAddress(owner)] ?? 0n;

  function competingBluefinBuy(sui: bigint) {
    const reserves = state.bluefinReserves;
    const fee = (sui * state.bluefinFeeRate + 999_999n) / 1_000_000n;
    const out = (reserves.meme * (sui - fee)) / (reserves.sui + sui - fee);
    state.bluefinReserves = { meme: reserves.meme - out, sui: reserves.sui + sui };
    state.bluefinPoolVersion += 1;
    bluefinSequence += 1n;
  }

  function requireReads() {
    if (state.reads === "unavailable") throw new Error("The fixture node is not answering reads.");
  }

  function poolObject(objectId: string) {
    const content = cetusPoolPrefixBcs
      .serialize({
        id: { id: { bytes: objectId } },
        coin_a: { value: state.pool.sui },
        coin_b: { value: state.pool.meme },
        tick_spacing: 200,
        fee_rate: FEE_RATE,
        liquidity: 2_056_088_519_495n,
        current_sqrt_price: sqrtPriceX64(state.pool.sui, state.pool.meme),
      })
      .toBytes();
    return object(objectId, `${CETUS_ORIGINAL}::pool::Pool<${QUOTE_TYPE}, ${VENUE_MEME_TYPE}>`, POOL_SHARED_VERSION, content, String(state.poolVersion));
  }

  /** A Bluefin `Pool<NEWT, SUI>` in its whole v17 layout, as `decodeBluefinPoolObject` reads it. */
  function bluefinPoolObject(objectId: string) {
    const table = (byte: string) => ({ id: { id: { bytes: normalizeSuiAddress(`0x${byte.repeat(32)}`) } }, size: 0n });
    const content = bluefinPoolBcs
      .serialize({
        id: { id: { bytes: objectId } },
        name: "NEWT-SUI",
        coin_a: { value: state.bluefinReserves.meme },
        coin_b: { value: state.bluefinReserves.sui },
        fee_rate: state.bluefinFeeRate,
        protocol_fee_share: 200_000n,
        fee_growth_global_coin_a: 0n,
        fee_growth_global_coin_b: 0n,
        protocol_fee_coin_a: 0n,
        protocol_fee_coin_b: 0n,
        ticks_manager: { tick_spacing: 60, ticks: table("d1"), bitmap: table("d2") },
        observations_manager: { observations: [], observation_index: 0n, observation_cardinality: 1n, observation_cardinality_next: 1n },
        current_sqrt_price: bluefinSqrtPriceX64(state.bluefinReserves.meme, state.bluefinReserves.sui),
        current_tick_index: -97_000,
        liquidity: 2_056_088_519_500n,
        reward_infos: [],
        is_paused: false,
        icon_url: "",
        position_index: 1n,
        sequence_number: bluefinSequence,
      })
      .toBytes();
    const layout = state.bluefinPoolLayout === "v17" ? content : new Uint8Array([...content, 1]);
    return object(
      objectId,
      `${BLUEFIN_ORIGINAL}::pool::Pool<${BLUEFIN_MEME_TYPE}, ${QUOTE_TYPE}>`,
      BLUEFIN_POOL_SHARED_VERSION,
      layout,
      String(state.bluefinPoolVersion),
    );
  }

  function sharedObject(name: string) {
    const identity = sharedByPath.get(name)!;
    if (name === "bluefin.config" && state.bluefinConfig === "absent") return null;
    const type =
      name === "cetus.config" && state.cetusConfig === "mismatch"
        ? `${CETUS_ORIGINAL}::config::AdminCap`
        : name === "bluefin.config" && state.bluefinConfig === "mismatch"
          ? `${BLUEFIN_ORIGINAL}::config::AdminCap`
          : SHARED_OBJECTS[name]!.type;
    return object(identity.objectId, type, String(identity.initialSharedVersion), fixtureSharedContent(name, identity.objectId));
  }

  function lookupObject(id: string) {
    const objectId = normalizeSuiAddress(id);
    const shared = sharedIds.get(objectId);
    if (shared) return sharedObject(shared);
    switch (objectId) {
      case CETUS_LAUNCH_ID:
        return object(
          CETUS_LAUNCH_ID,
          `${LAUNCHPAD}::launch::Launch<${VENUE_MEME_TYPE}, ${QUOTE_TYPE}>`,
          "12",
          launchContent(CETUS_LAUNCH_ID, venueWitnessType(MIGRATORS, "cetus"), VENUE_MEME_DECIMALS),
          "44",
        );
      case BLUEFIN_LAUNCH_ID:
        return object(
          BLUEFIN_LAUNCH_ID,
          `${LAUNCHPAD}::launch::Launch<${BLUEFIN_MEME_TYPE}, ${QUOTE_TYPE}>`,
          "13",
          launchContent(BLUEFIN_LAUNCH_ID, venueWitnessType(MIGRATORS, "bluefin"), BLUEFIN_MEME_DECIMALS),
          "45",
        );
      case CETUS_VAULT_ID:
        return object(CETUS_VAULT_ID, `${VAULT_PACKAGE}::vault::Vault<${VENUE_MEME_TYPE}, ${QUOTE_TYPE}>`, "1016519799", vaultContent(CETUS_VAULT_ID, CETUS_POOL_ID, CETUS_LAUNCH_ID, "cetus"));
      case BLUEFIN_VAULT_ID:
        return object(
          BLUEFIN_VAULT_ID,
          `${VAULT_PACKAGE}::vault::Vault<${BLUEFIN_MEME_TYPE}, ${QUOTE_TYPE}>`,
          "1016519807",
          vaultContent(BLUEFIN_VAULT_ID, BLUEFIN_POOL_ID, BLUEFIN_LAUNCH_ID, "bluefin"),
        );
      case CETUS_POOL_ID:
      case OTHER_CETUS_POOL_ID:
        return poolObject(objectId);
      case BLUEFIN_POOL_ID:
        return state.bluefinPoolObject === "present" ? bluefinPoolObject(objectId) : null;
      case OTHER_BLUEFIN_POOL_ID:
        return bluefinPoolObject(objectId);
      default:
        return null;
    }
  }

  function commitBluefinSwap(owner: string, sell: boolean, amount: bigint, out: bigint, after: VenueFixtureState["bluefinReserves"]) {
    state.bluefinReserves = after;
    state.bluefinPoolVersion += 1;
    bluefinSequence += 1n;
    state.sui[owner] = suiOf(owner) + (sell ? out : -amount);
    state.newt[owner] = newtOf(owner) + (sell ? -amount : out);
  }

  function commitCetusSwap(owner: string, buy: boolean, amount: bigint, out: bigint, after: VenueFixtureState["pool"]) {
    state.pool = after;
    state.poolVersion += 1;
    state.sui[owner] = suiOf(owner) + (buy ? -amount : out);
    state.meme[owner] = memeOf(owner) + (buy ? out : -amount);
  }

  /** The SDK-built Bluefin `pool::swap` call of `data`, if it holds one. */
  function bluefinSwapCall(data: TransactionData) {
    return data.commands.find((command) => command.MoveCall?.module === "pool" && command.MoveCall.function === "swap")?.MoveCall ?? null;
  }

  /**
   * Applies the SDK-built Bluefin swap the way Bluefin Spot v17 would: the
   * exact input in, `amount_limit` as the minimum output under
   * `by_amount_in` (`slippage_exceeds` below it), and the whole input
   * consumed; `commit` false only checks it.
   */
  function bluefinSwap(data: TransactionData, sender: string, commit: boolean): Landed {
    const call = bluefinSwapCall(data)!;
    if (normalizeSuiAddress(call.package) !== BLUEFIN_PACKAGE) return { status: failure(`Package ${call.package} is not Bluefin Spot.`), events: [] };
    if (state.bluefinConfig === "absent" || sharedId(data, call.arguments[1]) !== normalizeSuiAddress(BLUEFIN.bluefinConfig.objectId)) {
      return { status: failure("The swap does not use Bluefin's GlobalConfig."), events: [] };
    }
    const poolId = sharedId(data, call.arguments[2]);
    if (poolId !== BLUEFIN_POOL_ID || state.bluefinPoolObject === "absent") return { status: failure(`Pool ${poolId} has no liquidity on the fixture node.`), events: [] };
    const a2b = pure(data, call.arguments[5], bcs.bool());
    const byAmountIn = pure(data, call.arguments[6], bcs.bool());
    const amountText = pure(data, call.arguments[7], bcs.u64());
    const limitText = pure(data, call.arguments[8], bcs.u64());
    const provided = intoBalanceAmount(data);
    if (a2b === null || byAmountIn !== true || amountText === null || limitText === null || provided === null) {
      return { status: failure("The swap's direction, input, or minimum could not be read."), events: [] };
    }
    const amount = BigInt(amountText);
    // `balance::destroy_zero` (ENonZero, 0) aborts unless the pool took the whole input coin.
    if (provided !== amount) return { status: abort("balance", "destroy_zero", 0), events: [] };
    const owner = normalizeSuiAddress(sender);
    const sell = a2b; // The Meme is coin A: a sell puts NEWT in.
    if (sell ? newtOf(owner) < amount : suiOf(owner) < amount) {
      return { status: failure("InsufficientCoinBalance: the sender cannot cover this swap."), events: [] };
    }
    const reserves = state.bluefinReserves;
    const [reserveIn, reserveOut] = sell ? [reserves.meme, reserves.sui] : [reserves.sui, reserves.meme];
    const fee = (amount * state.bluefinFeeRate + 999_999n) / 1_000_000n;
    const out = (reserveOut * (amount - fee)) / (reserveIn + amount - fee);
    if (out < BigInt(limitText)) return { status: abort("pool", "swap", BLUEFIN_SLIPPAGE_EXCEEDS, BLUEFIN_ORIGINAL), events: [] };
    const before = bluefinSqrtPriceX64(reserves.meme, reserves.sui);
    const after = sell ? { meme: reserves.meme + amount, sui: reserves.sui - out } : { meme: reserves.meme - out, sui: reserves.sui + amount };
    if (commit) {
      commitBluefinSwap(owner, sell, amount, out, after);
    }
    const payload = bluefinSwapEventBcs.serialize({
      pool_id: BLUEFIN_POOL_ID,
      a2b,
      amount_in: amount,
      amount_out: out,
      pool_coin_a_amount: after.meme,
      pool_coin_b_amount: after.sui,
      fee,
      before_liquidity: 2_056_088_519_500n,
      after_liquidity: 2_056_088_519_500n,
      before_sqrt_price: before,
      after_sqrt_price: bluefinSqrtPriceX64(after.meme, after.sui),
      current_tick: -97_000,
      exceeded: false,
      sequence_number: bluefinSequence,
    });
    return { status: { success: true, error: null }, events: [eventEntry(`${BLUEFIN_ORIGINAL}::events::AssetSwap`, "pool", owner, payload.toBytes())] };
  }

  /** Applies the SDK-built Cetus swap the way the chain would; `commit` false only checks it. */
  function swap(data: TransactionData, sender: string, commit: boolean): Landed {
    if (bluefinSwapCall(data)) return bluefinSwap(data, sender, commit);
    const flash = data.commands.findIndex((command) => command.MoveCall?.module === "pool" && command.MoveCall.function === "flash_swap");
    const call = data.commands[flash]?.MoveCall;
    if (!call) return { status: failure("The fixture node only executes Cetus swaps."), events: [] };
    if (normalizeSuiAddress(call.package) !== CETUS_PACKAGE) return { status: failure(`Package ${call.package} is not Cetus CLMM.`), events: [] };
    if (sharedId(data, call.arguments[0]) !== normalizeSuiAddress(CETUS.cetusConfig.objectId)) {
      return { status: failure("The swap does not use Cetus's GlobalConfig."), events: [] };
    }
    const poolId = sharedId(data, call.arguments[1]);
    if (poolId !== CETUS_POOL_ID) return { status: failure(`Pool ${poolId} has no liquidity on the fixture node.`), events: [] };
    const a2b = pure(data, call.arguments[2], bcs.bool());
    const byAmountIn = pure(data, call.arguments[3], bcs.bool());
    const amountText = pure(data, call.arguments[4], bcs.u64());
    const provided = intoBalanceAmount(data);
    const minimum = minimumSwapOutput(data);
    if (a2b === null || byAmountIn !== true || amountText === null || provided === null || minimum === null) {
      return { status: failure("The swap's direction, input, or minimum could not be read."), events: [] };
    }
    const amount = BigInt(amountText);
    // `balance::destroy_zero` (ENonZero, 0) aborts unless the pool took the whole input coin.
    if (provided !== amount) return { status: abort("balance", "destroy_zero", 0), events: [] };
    const owner = normalizeSuiAddress(sender);
    const buy = a2b; // SUI is coin A: a buy puts SUI in.
    if (buy ? suiOf(owner) < amount : memeOf(owner) < amount) {
      return { status: failure("InsufficientCoinBalance: the sender cannot cover this swap."), events: [] };
    }
    const [reserveIn, reserveOut] = buy ? [state.pool.sui, state.pool.meme] : [state.pool.meme, state.pool.sui];
    const fee = (amount * FEE_RATE + 999_999n) / 1_000_000n;
    const out = (reserveOut * (amount - fee)) / (reserveIn + amount - fee);
    // `balance::split` (ENotEnough, 2) aborts when the output is below the minimum.
    if (out < BigInt(minimum)) return { status: abort("balance", "split", 2), events: [] };
    const before = sqrtPriceX64(state.pool.sui, state.pool.meme);
    const after = buy ? { sui: state.pool.sui + amount, meme: state.pool.meme - out } : { sui: state.pool.sui - out, meme: state.pool.meme + amount };
    if (commit) {
      commitCetusSwap(owner, buy, amount, out, after);
    }
    const payload = cetusSwapEventBcs.serialize({
      atob: a2b,
      pool: CETUS_POOL_ID,
      partner: normalizeSuiAddress("0x0"),
      amount_in: amount,
      amount_out: out,
      ref_amount: 0n,
      fee_amount: fee,
      vault_a_amount: after.sui,
      vault_b_amount: after.meme,
      before_sqrt_price: before,
      after_sqrt_price: sqrtPriceX64(after.sui, after.meme),
      steps: 1n,
    });
    return { status: { success: true, error: null }, events: [eventEntry(`${CETUS_ORIGINAL}::pool::SwapEvent`, "pool", owner, payload.toBytes())] };
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
    if (state.confirmation === "pending" && !migrations.has(digest)) {
      throw new Error(`Transaction ${digest} is not checkpointed yet.`);
    }
    return result(digest, found, "61");
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
      const found = lookupObject(objectId);
      if (!found) throw new ObjectError("notFound", `Object ${objectId} does not exist.`, { reason: "notFound" });
      return { object: found };
    },
    async getDynamicField({ parentId, name }: { parentId: string; name: { type: string } }) {
      requireReads();
      if (normalizeSuiAddress(parentId) === normalizeSuiAddress(VENUE_FIXTURE_MANIFEST.sharedObjects.migrators.venueConfig.objectId)) {
        const key = normalizeStructTag(name.type);
        const migrators = MIGRATORS.originalPackageId;
        if (key === normalizeStructTag(`${migrators}::cetus::PoolTierKey<${VENUE_MEME_TYPE}>`)) {
          return { dynamicField: { value: { type: "u32", bcs: bcs.u32().serialize(200).toBytes() } } };
        }
        if (key === normalizeStructTag(`${migrators}::bluefin::PoolTierKey<${BLUEFIN_MEME_TYPE}>`)) {
          const bytes = bluefinPoolTierBcs.serialize({ tick_spacing: 60, fee_rate: BLUEFIN_FEE_RATE }).toBytes();
          return { dynamicField: { value: { type: `${migrators}::bluefin::PoolTier`, bcs: bytes } } };
        }
      }
      throw new ObjectError("notFound", `No such field of ${parentId}.`, { reason: "notFound", objectId: parentId });
    },
    async getBalance({ owner, coinType = QUOTE_TYPE }: Readonly<{ owner: string; coinType?: string }>) {
      requireReads();
      const type = normalizeStructTag(coinType);
      if (type === VENUE_MEME_TYPE || type === BLUEFIN_MEME_TYPE) {
        const balance = String(type === VENUE_MEME_TYPE ? memeOf(owner) : newtOf(owner));
        // The coin sits in the address balance, so a sale withdraws it from there.
        return { balance: { coinType: type, balance, coinBalance: "0", addressBalance: balance } };
      }
      const balance = String(suiOf(owner));
      return { balance: { coinType: QUOTE_TYPE, balance, coinBalance: balance, addressBalance: "0" } };
    },
    async listCoins() {
      requireReads();
      return { objects: [], hasNextPage: false, cursor: null };
    },
    resolveTransactionPlugin() {
      return async (data: TransactionDataBuilder, _options: unknown, next: () => Promise<void>) => {
        data.gasData.price ??= "1000";
        if (!data.gasData.budget && state.gasBudget === "estimated") {
          // As the Core API resolver does: simulate at the maximum budget, and fail the build if the transaction fails.
          const probe = Transaction.from(data.build({ overrides: { gasData: { budget: "50000000000", payment: [] } } })).getData();
          const { status } = swap(probe, probe.sender ?? "0x0", false);
          if (!status.success) throw new SimulationError(`Transaction resolution failed: ${status.error.message}`, { executionError: status.error });
        }
        data.gasData.budget ??= "50000000";
        data.gasData.payment ??= [{ ...GAS_COIN, version: String(gasVersion) }];
        await next();
      };
    },
    async simulateTransaction({ transaction }: Readonly<{ transaction: Uint8Array }>) {
      calls.simulate += 1;
      simulated.push(transaction);
      if (state.simulation === "unavailable") throw new Error("The fixture node cannot simulate right now.");
      const digest = TransactionDataBuilder.getDigestFromBytes(transaction);
      const data = Transaction.from(transaction).getData();
      const bluefin = bluefinSwapCall(data);
      if (bluefin && state.bluefinProvider === "unavailable") throw new Error("The fixture node cannot simulate Bluefin swaps right now.");
      const checked = swap(data, data.sender ?? "0x0", false);
      // The quote transport's probe asks for one atom at least; another trader lands right after it.
      if (bluefin && state.bluefinRace === "after-quote" && pure(data, bluefin.arguments[8], bcs.u64()) === "1") {
        state.bluefinRace = "none";
        competingBluefinBuy(500_000_000_000n);
      }
      return { ...result(digest, checked, null), commandResults: undefined };
    },
    async executeTransaction({ transaction, signatures }: Readonly<{ transaction: Uint8Array; signatures: string[] }>) {
      calls.execute += 1;
      executed.push(transaction);
      const signer = await verifyTransactionSignature(transaction, signatures[0] ?? "", { offline: true });
      const digest = TransactionDataBuilder.getDigestFromBytes(transaction);
      const data = Transaction.from(transaction).getData();
      gasVersion += 1;
      const aborted = bluefinSwapCall(data)
        ? abort("pool", "swap", BLUEFIN_SLIPPAGE_EXCEEDS, BLUEFIN_ORIGINAL)
        : abort("balance", "split", 2);
      const landedSwap = state.execution === "abort" ? { status: aborted, events: [] } : swap(data, signer.toSuiAddress(), true);
      const outcome = state.execution === "no-swap-event" ? { ...landedSwap, events: [] } : landedSwap;
      landed.set(digest, outcome);
      if (state.execution === "unknown") throw new Error("The Sui node closed the connection before answering.");
      return result(digest, outcome, null);
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
    simulated,
    executed,
    competingBuy(sui) {
      const fee = (sui * FEE_RATE + 999_999n) / 1_000_000n;
      const out = (state.pool.meme * (sui - fee)) / (state.pool.sui + sui - fee);
      state.pool = { sui: state.pool.sui + sui, meme: state.pool.meme - out };
      state.poolVersion += 1;
    },
    competingBluefinBuy,
  };
}
