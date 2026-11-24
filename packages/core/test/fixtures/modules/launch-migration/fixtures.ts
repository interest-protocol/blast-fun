// Fixtures for the public Complete migration action: a non-production
// deployment that records both venues' object sets, and a mutable in-memory
// Sui node with one MigrationReady launch on either venue, its registry
// currencies, the venue objects, Bluefin's pool-creation fee, and a competing
// wallet that can migrate first. They serve tests and the development
// harness, never real value.

import { SUI_COIN_TYPE as SUI } from "@blast/core/lib/sui/coin-types.ts";
import { sharedObjectEntries, type BlastDeployment, type BlastDeploymentInput } from "@interest-protocol/blast-sdk/deployments";
import { SUI_COIN_REGISTRY_OBJECT_ID as COIN_REGISTRY_ID } from "@mysten/sui/utils";
import { bluefinPoolTierBcs } from "@interest-protocol/blast-sdk/migrators";
import { launchpadEventBcs } from "@interest-protocol/blast-sdk/launchpad";
import { bcs } from "@mysten/sui/bcs";
import { ObjectError, type ClientWithCoreApi, type SuiClientTypes } from "@mysten/sui/client";
import { Transaction, TransactionDataBuilder } from "@mysten/sui/transactions";
import { deriveObjectID, fromBase64, normalizeStructTag, normalizeSuiAddress } from "@mysten/sui/utils";
import { verifyTransactionSignature } from "@mysten/sui/verify";

import type { LaunchLifecycle } from "../../../../src/modules/launchpad-contract/discovery.ts";
import { COIN_FIXTURE, launchObjectFixture } from "../launchpad-coin/fixtures.ts";
import { fixtureSharedContent, runtimeFor } from "../launchpad-coin/deployment-runtime.ts";
import { NON_PRODUCTION_MANIFEST } from "../launchpad-coin/manifest-fixtures.ts";

export type FixtureVenue = "cetus" | "bluefin";

/**
 * Venue identities as fixture data, copied from the SDK's venue-deployment
 * test fixture (contracts 442116a `ptb_tests/fork` snapshot): mainnet Cetus
 * CLMM, Cetus LP Burn, and Bluefin Spot lineages and their shared objects.
 */
export const VENUE_FIXTURE_LINEAGE = {
  packages: {
    cetusClmm: {
      packageId: "0x260693ec785a6e6c9d81d58c7d2ff72f1288ae0fa6a9725abe05a6478b11f084",
      originalPackageId: "0x1eabed72c53feb3805120a081dc15963c204dc8d091542592abaf7a35689b2fb",
    },
    cetusLpBurn: {
      packageId: "0xc4aabc874f5060d3147d8f74c14e3a8a1f9f8d92edea138a51635395ed167cd9",
      originalPackageId: "0x12d73de9a6bc3cb658ec9dc0fe7de2662be1cea5c76c092fcc3606048cdbac27",
    },
    bluefinSpot: {
      packageId: "0xd075338d105482f1527cbfd363d6413558f184dec36d9138a70261e87f486e9c",
      originalPackageId: "0x3492c874c1e3b3e2984e8c41b589e642d4d0a5d6459e5a9cfc2d52fd7c89c267",
    },
  },
  sharedObjects: {
    cetus: {
      config: {
        objectId: "0xdaa46292632c3c4d8f31f23ea0f9b36a28ff3677e9684980e4438403a67a3d8f",
        initialSharedVersion: "1574190",
      },
      pools: {
        objectId: "0xf699e7f2276f5c9a75944b37a0c5b5d9ddfd2471bf6242483b03ab2887d198d0",
        initialSharedVersion: "1574190",
      },
      burnManager: {
        objectId: "0x1d94aa32518d0cb00f9de6ed60d450c9a2090761f326752ffad06b2e9404f845",
        initialSharedVersion: "327723159",
      },
    },
    bluefin: {
      config: {
        objectId: "0x03db251ba509a8d5d8777b6338836082335d93eecbdd09a11e190a1cff51c352",
        initialSharedVersion: "406496849",
      },
    },
  },
} as const;

/** Each venue's shared objects, as the manifest paths that name them. */
const VENUE_SETS: Readonly<Record<FixtureVenue, readonly string[]>> = {
  cetus: ["cetus.config", "cetus.pools", "cetus.burnManager"],
  bluefin: ["bluefin.config"],
};

const VENUE_PACKAGES: Readonly<Record<FixtureVenue, readonly (keyof typeof VENUE_FIXTURE_LINEAGE.packages)[]>> = {
  cetus: ["cetusClmm", "cetusLpBurn"],
  bluefin: ["bluefinSpot"],
};

const ROUTE_TIERS: Readonly<Record<FixtureVenue, readonly Readonly<{ tickSpacing: number; feeRate: string }>[]>> = {
  cetus: [{ tickSpacing: 60, feeRate: "3000" }, { tickSpacing: 200, feeRate: "10000" }],
  bluefin: [{ tickSpacing: 60, feeRate: "3000" }, { tickSpacing: 200, feeRate: "10000" }],
};

/**
 * The non-production manifest with `sets` venues' whole object sets and
 * `routes` venues' routes (by default the same venues). A route without its
 * set is a venue this deployment cannot sign for.
 */
export function migrationManifest({
  sets = ["cetus", "bluefin"],
  routes = sets,
}: Readonly<{ sets?: readonly FixtureVenue[]; routes?: readonly FixtureVenue[] }> = {}): BlastDeploymentInput {
  const packages: Record<string, unknown> = { ...NON_PRODUCTION_MANIFEST.packages };
  const sharedObjects: Record<string, unknown> = { ...NON_PRODUCTION_MANIFEST.sharedObjects };
  for (const venue of sets) {
    for (const name of VENUE_PACKAGES[venue]) packages[name] = VENUE_FIXTURE_LINEAGE.packages[name];
    sharedObjects[venue] = VENUE_FIXTURE_LINEAGE.sharedObjects[venue];
  }
  return {
    ...NON_PRODUCTION_MANIFEST,
    packages,
    sharedObjects,
    routes: routes.map((venue) => ({ venue, tiers: ROUTE_TIERS[venue] })),
  } as BlastDeploymentInput;
}

const LAUNCHPAD = NON_PRODUCTION_MANIFEST.packages.launchpad.originalPackageId;
const MIGRATORS = NON_PRODUCTION_MANIFEST.packages.migrators.originalPackageId;
const MIGRATORS_CURRENT = NON_PRODUCTION_MANIFEST.packages.migrators.packageId;
const FRAMEWORK = normalizeSuiAddress("0x2");

export const MIGRATION_LAUNCH_ID = COIN_FIXTURE.launchId;
/** A Meme whose Cetus type name sorts after SUI's, so it is the pool's coin A. */
export const MEME_A_TYPE = COIN_FIXTURE.coinType;
/** A Meme whose Cetus type name sorts before SUI's (address 0x…01), so SUI is coin A. */
export const MEME_B_TYPE = `${normalizeSuiAddress("0x1")}::low::LOW`;

const cetusConfigPrefixBcs = bcs.struct("GlobalConfig", {
  id: bcs.Address,
  protocolFeeRate: bcs.u64(),
  feeTiers: bcs.vector(bcs.struct("Entry", { spacing: bcs.u32(), tickSpacing: bcs.u32(), feeRate: bcs.u64() })),
});
const vaultTier = { tick_spacing: 60, fee_rate: 3000n };

const VENUE_OBJECT_NAMES = new Set<string>([...VENUE_SETS.cetus, ...VENUE_SETS.bluefin]);
const FEE_TABLE_ID = normalizeSuiAddress(`0x${"fe".repeat(32)}`);
const GAS_COIN = {
  objectId: normalizeSuiAddress(`0x${"6b".repeat(32)}`),
  version: "7",
  digest: "BMwg3HvPTPQaKr9Lnk5jjNkw1bseCftzVgdaGksass4W",
};
const DEFAULT_BALANCE = 100_000_000_000n;

/** Every fact of the fixture node that a test or the harness may change between steps. */
export type MigrationFixtureState = {
  chainIdentifier: string;
  lifecycle: LaunchLifecycle;
  /** The adapter module the launch recorded as its witness; `turbos` is one no SDK routes. */
  witness: FixtureVenue | "turbos";
  memeType: string;
  version: number;
  /** `missing`: the node does not hold the manifest's venue objects. */
  venueObjects: "present" | "missing";
  /** Bluefin's configured SUI pool-creation fee, in MIST. */
  bluefinFee: bigint;
  /** Atomic SUI the signer holds. */
  balance: bigint;
  reads: "available" | "unavailable";
  simulation: "success" | "failure" | "unavailable";
  /** `unknown`: the transaction lands but the submission call fails. */
  execution: "complete" | "abort" | "unknown";
  confirmation: "checkpointed" | "pending";
  /** `missing`: a submission completes without migrating and without the `Migrated` event. */
  evidence: "event" | "missing";
};

export type MigrationFixtureCalls = { simulate: number; execute: number; lookup: number; launchReads: number };

export type MigrationFixtureChain = Readonly<{
  client: ClientWithCoreApi;
  manifest: BlastDeploymentInput;
  state: MigrationFixtureState;
  calls: MigrationFixtureCalls;
  /** Another wallet (or Blast's automation) migrates the launch first. */
  migrateElsewhere(): void;
  /** Runs after each simulation, before it answers: a test's hook into the node's timeline. */
  hooks: { afterSimulation?: () => void };
}>;

function currencyId(coinType: string): string {
  return deriveObjectID(COIN_REGISTRY_ID, `0x2::coin_registry::CurrencyKey<${normalizeStructTag(coinType)}>`, new Uint8Array([0]));
}

function shared(objectId: string, initialSharedVersion: string | number, type: string, version = "90") {
  return {
    objectId,
    version,
    digest: GAS_COIN.digest,
    owner: { $kind: "Shared", Shared: { initialSharedVersion: String(initialSharedVersion) } },
    type,
    content: new Uint8Array(),
    json: null,
  };
}

function status(success: boolean, message = ""): SuiClientTypes.ExecutionStatus {
  return success
    ? { success: true, error: null }
    : ({ success: false, error: { $kind: "MoveAbort", message, MoveAbort: { abortCode: "3" } } } as SuiClientTypes.ExecutionStatus);
}

type Landed = { status: SuiClientTypes.ExecutionStatus; events: SuiClientTypes.Event[] };

function transactionResult(digest: string, landed: Landed, checkpoint: string | null) {
  const transaction = {
    digest,
    signatures: [],
    epoch: "3",
    timestampMs: null,
    checkpoint,
    status: landed.status,
    balanceChanges: undefined,
    effects: {
      bcs: null,
      version: 2,
      status: landed.status,
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
    events: landed.events,
    objectTypes: {},
    transaction: undefined,
    bcs: undefined,
  };
  return landed.status.success
    ? { $kind: "Transaction" as const, Transaction: transaction }
    : { $kind: "FailedTransaction" as const, FailedTransaction: transaction };
}

/** The amount of the SUI coin a Bluefin migration pays: a zero coin, or a split of the gas coin. */
function paidFee(data: ReturnType<Transaction["getData"]>): bigint | null {
  for (const command of data.commands) {
    if (command.MoveCall?.package === FRAMEWORK && command.MoveCall.module === "coin" && command.MoveCall.function === "zero") {
      return 0n;
    }
    const split = command.SplitCoins;
    if (split?.coin.$kind === "GasCoin") {
      const amount = split.amounts[0];
      const input = amount?.$kind === "Input" ? data.inputs[amount.Input] : undefined;
      if (input?.Pure) return BigInt(bcs.u64().parse(fromBase64(input.Pure.bytes)));
    }
  }
  return null;
}

/**
 * An in-memory Sui node for migration. A migration lands only when the
 * launch is MigrationReady, the call is the recorded venue's `migrate` of
 * this deployment's migrators package, and a Bluefin call pays exactly the
 * configured fee; landing makes the launch Migrated and emits `Migrated`.
 */
export function createMigrationFixtureChain(
  overrides: Partial<MigrationFixtureState> = {},
  manifest: BlastDeploymentInput = migrationManifest(),
): MigrationFixtureChain {
  const state: MigrationFixtureState = {
    chainIdentifier: NON_PRODUCTION_MANIFEST.chainIdentifier,
    lifecycle: "migration_ready",
    witness: "cetus",
    memeType: MEME_A_TYPE,
    version: 40,
    venueObjects: "present",
    bluefinFee: 0n,
    balance: DEFAULT_BALANCE,
    reads: "available",
    simulation: "success",
    execution: "complete",
    confirmation: "checkpointed",
    evidence: "event",
    ...overrides,
  };
  const calls: MigrationFixtureCalls = { simulate: 0, execute: 0, lookup: 0, launchReads: 0 };
  const hooks: MigrationFixtureChain["hooks"] = {};
  const landed = new Map<string, Landed>();
  let gasVersion = Number(GAS_COIN.version);
  const sharedTypes = runtimeFor(manifest).sharedObjects;
  const sharedByPath = new Map(sharedObjectEntries(manifest.sharedObjects as BlastDeployment["sharedObjects"]));
  const sharedNames = new Map(
    sharedObjectEntries(manifest.sharedObjects as BlastDeployment["sharedObjects"]).map(([path, identity]) => [
      normalizeSuiAddress(identity.objectId),
      path,
    ]),
  );

  function requireReads() {
    if (state.reads === "unavailable") throw new Error("The fixture node is not answering reads.");
  }

  function launch() {
    const object = launchObjectFixture(state.lifecycle, {
      migrationWitness: `${MIGRATORS}::${state.witness}::Venue`,
      memeType: state.memeType,
    });
    return { ...shared(object.objectId, object.initialSharedVersion, object.type, String(state.version)), content: object.content };
  }

  function find(objectId: string) {
    const id = normalizeSuiAddress(objectId);
    const name = sharedNames.get(id);
    if (name && !(state.venueObjects === "missing" && VENUE_OBJECT_NAMES.has(name))) {
      const identity = sharedByPath.get(name)!;
      const object = shared(id, String(identity.initialSharedVersion), sharedTypes[name]!.type);
      const content = name === "cetus.config"
        ? cetusConfigPrefixBcs.serialize({
          id,
          protocolFeeRate: 2_000n,
          feeTiers: [{ spacing: vaultTier.tick_spacing, tickSpacing: vaultTier.tick_spacing, feeRate: vaultTier.fee_rate }],
        }).toBytes()
        : fixtureSharedContent(name, id);
      return { ...object, content };
    }
    if (id === normalizeSuiAddress(MIGRATION_LAUNCH_ID)) {
      calls.launchReads += 1;
      return launch();
    }
    for (const coinType of [state.memeType, SUI]) {
      if (id === currencyId(coinType)) return shared(id, "8", `${FRAMEWORK}::coin_registry::Currency<${normalizeStructTag(coinType)}>`);
    }
    return null;
  }

  /** Why this transaction cannot migrate the launch now, or null when it can. */
  function refusal(bytes: Uint8Array): string | null {
    if (state.lifecycle !== "migration_ready") return "launch::migrate aborted: the launch is not MigrationReady.";
    const data = Transaction.from(bytes).getData();
    const call = data.commands.find((command) => command.MoveCall?.function === "migrate" && command.MoveCall.module === state.witness)?.MoveCall;
    if (!call || normalizeSuiAddress(call.package) !== normalizeSuiAddress(MIGRATORS_CURRENT) || call.module !== state.witness) {
      return "The call is not this launch's recorded migration route.";
    }
    if (call.module === "bluefin" && paidFee(data) !== state.bluefinFee) {
      return "Bluefin aborted: the pool-creation fee is not the configured fee.";
    }
    return null;
  }

  function migratedEvent(sender: string): SuiClientTypes.Event {
    const payload = launchpadEventBcs.Migrated.serialize({
      launch_id: MIGRATION_LAUNCH_ID,
      meme_amount: 190_000_000_000_000_000n,
      quote_amount: 11_760_000_000_000n,
      disposed_meme: 0n,
      total_supply_after: 1_000_000_000_000_000n,
    });
    return {
      packageId: MIGRATORS,
      module: state.witness,
      sender,
      eventType: `${LAUNCHPAD}::events::Migrated<${state.memeType},${SUI}>`,
      bcs: payload.toBytes(),
      json: null,
    };
  }

  function lookup(digest: string) {
    calls.lookup += 1;
    requireReads();
    const found = landed.get(digest);
    if (!found || state.confirmation === "pending") throw new Error(`Transaction ${digest} is not confirmed yet.`);
    return transactionResult(digest, found, "41");
  }

  function dynamicField(parentId: string, name: Readonly<{ type: string; bcs: Uint8Array }>) {
    if (normalizeSuiAddress(parentId) === normalizeSuiAddress(manifest.sharedObjects.migrators.venueConfig.objectId)) {
      const key = normalizeStructTag(name.type);
      const tierKey = (venue: FixtureVenue) => normalizeStructTag(`${MIGRATORS}::${venue}::PoolTierKey<${state.memeType}>`);
      if (key === tierKey("cetus")) return { type: "u32", bcs: bcs.u32().serialize(vaultTier.tick_spacing).toBytes() };
      if (key === tierKey("bluefin")) return { type: `${MIGRATORS}::bluefin::PoolTier`, bcs: bluefinPoolTierBcs.serialize(vaultTier).toBytes() };
      return null;
    }
    const key = bcs.string().parse(name.bcs);
    const config = manifest.sharedObjects.bluefin?.config;
    if (config && normalizeSuiAddress(parentId) === normalizeSuiAddress(config.objectId) && key === "pool_creation_fee") {
      const table = bcs.struct("Table", { id: bcs.Address, size: bcs.u64() }).serialize({ id: FEE_TABLE_ID, size: 1n });
      return { type: "0x2::table::Table<0x1::string::String, u64>", bcs: table.toBytes() };
    }
    if (normalizeSuiAddress(parentId) === FEE_TABLE_ID && key === SUI.slice(2)) {
      return { type: "u64", bcs: bcs.u64().serialize(state.bluefinFee).toBytes() };
    }
    return null;
  }

  const core = {
    async getChainIdentifier() {
      requireReads();
      return { chainIdentifier: state.chainIdentifier };
    },
    async getObjects({ objectIds }: Readonly<{ objectIds: readonly string[] }>) {
      requireReads();
      return { objects: objectIds.map((id) => find(id) ?? new Error(`Object ${id} does not exist.`)) };
    },
    async getObject({ objectId }: Readonly<{ objectId: string }>) {
      requireReads();
      const object = find(objectId);
      if (!object) throw new ObjectError("notFound", `Object ${objectId} does not exist.`, { reason: "notFound", objectId });
      return { object };
    },
    async getDynamicField({ parentId, name }: Readonly<{ parentId: string; name: { type: string; bcs: Uint8Array } }>) {
      requireReads();
      const value = dynamicField(parentId, name);
      if (!value) throw new ObjectError("notFound", `No such field of ${parentId}.`, { reason: "notFound", objectId: parentId });
      return { dynamicField: { value } };
    },
    async getBalance() {
      requireReads();
      const balance = String(state.balance);
      return { balance: { coinType: SUI, balance, coinBalance: balance, addressBalance: "0" } };
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
      const refused = state.simulation === "failure" ? "The migration aborted in simulation (abort 3)." : refusal(transaction);
      hooks.afterSimulation?.();
      return { ...transactionResult(digest, { status: status(refused === null, refused ?? ""), events: [] }, null), commandResults: undefined };
    },
    async executeTransaction({ transaction, signatures }: Readonly<{ transaction: Uint8Array; signatures: string[] }>) {
      calls.execute += 1;
      const signer = await verifyTransactionSignature(transaction, signatures[0] ?? "", { offline: true });
      const digest = TransactionDataBuilder.getDigestFromBytes(transaction);
      gasVersion += 1;
      const refused = state.execution === "abort" ? "The migration aborted on chain (abort 3)." : refusal(transaction);
      const outcome: Landed = refused
        ? { status: status(false, refused), events: [] }
        : { status: status(true), events: state.evidence === "event" ? [migratedEvent(signer.toSuiAddress())] : [] };
      if (!refused && state.evidence === "event") {
        state.lifecycle = "migrated";
        state.version += 1;
      }
      landed.set(digest, outcome);
      if (state.execution === "unknown") throw new Error("The Sui node closed the connection before answering.");
      return transactionResult(digest, outcome, null);
    },
    async waitForTransaction({ digest }: Readonly<{ digest: string }>) {
      return lookup(digest);
    },
    async getTransaction({ digest }: Readonly<{ digest: string }>) {
      return lookup(digest);
    },
  };

  return {
    client: { core } as unknown as ClientWithCoreApi,
    manifest,
    state,
    calls,
    hooks,
    migrateElsewhere() {
      state.lifecycle = "migrated";
      state.version += 1;
    },
  };
}
