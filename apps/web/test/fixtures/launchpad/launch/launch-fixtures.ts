// Fixtures for launch creation: a non-production manifest with both venue sets
// and an in-memory Sui node that publishes, registers, and creates launches.
// They serve tests and harness checks, never real value.

import { SUI_COIN_TYPE as SUI_TYPE } from "@blast/core/lib/sui/coin-types.ts";
import { fixtureSharedContent, runtimeFor } from "../../../../../../packages/core/test/fixtures/modules/launchpad-coin/deployment-runtime.ts";
import { sharedObjectEntries, type BlastDeployment, type BlastDeploymentInput } from "@interest-protocol/blast-sdk/deployments";
import type { FeeSplit, Route } from "@interest-protocol/blast-sdk";
import { launchBcs, launchConfigBcs, launchpadEventBcs, type CreatorAllocationPlan } from "@interest-protocol/blast-sdk/launchpad";
import { venueWitnessType } from "@interest-protocol/blast-sdk/migrators";
import { partnerBcs } from "@interest-protocol/blast-sdk/partners";
import { bcs } from "@mysten/sui/bcs";
import { ObjectError } from "@mysten/sui/client";
import { deserialize as deserializeModule } from "@mysten/move-bytecode-template";
import type { ClientWithCoreApi, SuiClientTypes } from "@mysten/sui/client";
import { Transaction, TransactionDataBuilder } from "@mysten/sui/transactions";
import { SUI_COIN_REGISTRY_OBJECT_ID, deriveObjectID, fromBase58, fromBase64, normalizeStructTag, normalizeSuiAddress, toBase58, toHex } from "@mysten/sui/utils";
import { verifyTransactionSignature } from "@mysten/sui/verify";

import type { OutcomeFixtureTransaction } from "../../../../../../packages/core/test/fixtures/modules/launchpad-telemetry/outcome-fixtures.ts";
import { NON_PRODUCTION_MANIFEST } from "../transaction/fixtures.ts";
import { cetusGlobalConfigPrefixBcs } from "@blast/core/lib/launchpad/cetus-global-config.ts";

/** The fee recipient of every fixture `blast_partners::Partner`. */
const FIXTURE_PARTNER_RECIPIENT = normalizeSuiAddress(`0x${"8b".repeat(32)}`);

/**
 * The venue identities the launch fixture manifest records, copied from the
 * SDK's venue fixture (sdk eb23457 `test/fixtures/venue-deployment.ts`, itself
 * copied from contracts 442116a `sui/launchpad/ptb_tests/fork`): Cetus CLMM
 * revision 15, Cetus LP Burn revision 8, Bluefin Spot revision 17, and their
 * shared objects. They are mainnet venue identities used as fixture data on a
 * non-production manifest.
 */
const VENUE_SETS = {
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
    cetusConfig: { objectId: "0xdaa46292632c3c4d8f31f23ea0f9b36a28ff3677e9684980e4438403a67a3d8f", initialSharedVersion: "1574190" },
    cetusPools: { objectId: "0xf699e7f2276f5c9a75944b37a0c5b5d9ddfd2471bf6242483b03ab2887d198d0", initialSharedVersion: "1574190" },
    cetusBurnManager: { objectId: "0x1d94aa32518d0cb00f9de6ed60d450c9a2090761f326752ffad06b2e9404f845", initialSharedVersion: "327723159" },
    bluefinConfig: { objectId: "0x03db251ba509a8d5d8777b6338836082335d93eecbdd09a11e190a1cff51c352", initialSharedVersion: "406496849" },
  },
} as const;

/**
 * The Cetus tiers the launch fixture manifest records: tick spacing and the
 * fee rate Cetus fixes for it, in millionths. Fixture values.
 */
const CETUS_ROUTE = { venue: "cetus", tiers: [{ tickSpacing: 60, feeRate: "2500" }, { tickSpacing: 200, feeRate: "10000" }] } as const;

/** The manifest the launch fixtures use: both venue sets, so both venues are available on the fixture node. */
export const LAUNCH_FIXTURE_MANIFEST: BlastDeploymentInput = {
  ...NON_PRODUCTION_MANIFEST,
  packages: {
    ...NON_PRODUCTION_MANIFEST.packages,
    cetusClmm: VENUE_SETS.packages.cetusClmm,
    cetusLpBurn: VENUE_SETS.packages.cetusLpBurn,
    bluefinSpot: VENUE_SETS.packages.bluefinSpot,
  },
  sharedObjects: {
    ...NON_PRODUCTION_MANIFEST.sharedObjects,
    cetus: {
      config: VENUE_SETS.sharedObjects.cetusConfig,
      pools: VENUE_SETS.sharedObjects.cetusPools,
      burnManager: VENUE_SETS.sharedObjects.cetusBurnManager,
    },
    bluefin: { config: VENUE_SETS.sharedObjects.bluefinConfig },
  },
  routes: [CETUS_ROUTE, ...NON_PRODUCTION_MANIFEST.routes],
};

// --- An in-memory Sui node for launch creation. ---

const LAUNCHPAD = normalizeSuiAddress(NON_PRODUCTION_MANIFEST.packages.launchpad.originalPackageId);
const PARTNERS = normalizeSuiAddress(NON_PRODUCTION_MANIFEST.packages.partners.originalPackageId);
const PARTNER_TABLE = normalizeSuiAddress(`0x${"7c".repeat(32)}`);
const PARTNER_SHARED_VERSION = "11";
const MIGRATORS = NON_PRODUCTION_MANIFEST.packages.migrators.originalPackageId;
const GAS_COIN = {
  objectId: normalizeSuiAddress(`0x${"6b".repeat(32)}`),
  digest: "BMwg3HvPTPQaKr9Lnk5jjNkw1bseCftzVgdaGksass4W",
};
const SHARED_OBJECTS = runtimeFor(LAUNCH_FIXTURE_MANIFEST).sharedObjects;
/** Each venue's shared objects, by manifest path. */
const VENUE_OBJECTS: Readonly<Record<string, "cetus" | "bluefin">> = {
  "cetus.config": "cetus",
  "cetus.pools": "cetus",
  "cetus.burnManager": "cetus",
  "bluefin.config": "bluefin",
};
const WITNESSES = {
  bluefin: venueWitnessType(NON_PRODUCTION_MANIFEST.packages.migrators, "bluefin"),
  cetus: venueWitnessType(NON_PRODUCTION_MANIFEST.packages.migrators, "cetus"),
} as const;
const CETUS_PACKAGE = normalizeSuiAddress(VENUE_SETS.packages.cetusClmm.packageId);

/** Every fact of the fixture node a harness or test may change between steps. */
export type LaunchFixtureState = {
  chainIdentifier: string;
  reads: "available" | "unavailable";
  simulation: "success" | "failure" | "unavailable";
  /**
   * `unknown`: the transaction lands but the submission answer is lost;
   * `dropped`: the submission fails and nothing lands.
   */
  execution: "complete" | "abort" | "unknown" | "dropped";
  confirmation: "checkpointed" | "pending";
  /** `automatic`: the registration worker shares each published currency at once. */
  registration: "automatic" | "manual";
  memeDecimals: number[];
  creationFee: bigint;
  /** LaunchConfig's trade fees new launches snapshot, in basis points. */
  quoteFeeBps: bigint;
  memeFeeBps: bigint;
  /** LaunchConfig's Blast allocation shares, in basis points. */
  protocolMemeBps: bigint;
  protocolQuoteBps: bigint;
  /** The current epoch; a transaction whose expiration epoch is below it is refused. */
  epoch: bigint;
  admitsBluefin: boolean;
  admitsCetus: boolean;
  /**
   * How the node reports each venue's recorded objects: `observed` at their
   * recorded types, or `mismatch` (another type, as a foreign or replaced
   * object would be), which makes the SDK mark that venue unavailable.
   */
  venueObjects: { cetus: "observed" | "mismatch"; bluefin: "observed" | "mismatch" };
  /**
   * The tick spacings the fixture Cetus `GlobalConfig` registers, each with the
   * fee rate Cetus fixes for it. `cetus::new` at any other spacing aborts in
   * Cetus (`config::get_fee_rate`), leaving Cetus unchanged.
   */
  cetusTiers: Record<string, string>;
  /**
   * The tiers the node reports when the Cetus `GlobalConfig` is read; null
   * reports `cetusTiers`. A different value models Cetus changing a fee rate
   * between that read and the simulation.
   */
  cetusConfigView: Record<string, string> | null;
  /**
   * `failing`: reading the Cetus `GlobalConfig`'s contents fails (a node
   * error), while the object is still observed for the deployment check.
   */
  cetusConfigRead: "available" | "failing";
  /** Quote types LaunchConfig admits, normalized. */
  quotes: string[];
  /**
   * Shared partners by object ID. `acceptedUntilMs` is LaunchConfig's
   * `PartnerKey` value (u64 max while accepted, the removal deadline after
   * removal), or null when LaunchConfig has never accepted the partner.
   */
  partners: Record<string, { acceptedUntilMs: bigint | null; shareBps: bigint }>;
  /**
   * A contract abort the node reports for every simulation and execution
   * (`code` in `module::functionName` of the launchpad), as Sui formats it.
   */
  rejection: { module: string; functionName: string; code: number } | null;
  /** The node's clock for partner admission; null follows this machine's clock. */
  clockMs: bigint | null;
  /** Atomic SUI per owner; an absent owner holds 100 SUI. */
  balances: Record<string, bigint>;
};

export type LaunchFixtureCalls = { simulate: number; execute: number; publish: number; create: number };

type FixtureObject = {
  objectId: string;
  version: string;
  digest: string;
  owner: SuiClientTypes.ObjectOwner;
  type: string;
  content: Uint8Array;
  previousTransaction: string;
};

type Landed = {
  status: SuiClientTypes.ExecutionStatus;
  changedObjects: SuiClientTypes.ChangedObject[];
  objectTypes: Record<string, string>;
  /** The launchpad events it emitted; a creation emits its launch's `LaunchShared`. */
  events?: SuiClientTypes.Event[];
};

/** The checkpoint every fixture transaction lands in, and its time. */
const FIXTURE_CHECKPOINT = "41";
const FIXTURE_CHECKPOINT_MS = 1_790_000_200_000;

export type LaunchFixtureChain = Readonly<{
  client: ClientWithCoreApi;
  state: LaunchFixtureState;
  calls: LaunchFixtureCalls;
  /** Runs the registration worker: shares every published, unregistered currency. */
  registerCurrencies(): number;
  /** Lands another transaction from the wallet that spends the gas coin's current version. */
  spendGas(): void;
  /** Moves a ticket away from its owner, as another session's launch would consume it. */
  consumeTicket(ticketId: string): void;
  /** The launch tickets `owner` holds now. */
  ownedTickets(owner: string): readonly string[];
  /** The partner a created launch names, or null. */
  partnerOf(launchId: string): string | null;
  /**
   * A landed, checkpointed transaction as another fixture node would serve it
   * (the dev fixture server's `/__fixture/transactions`), or null.
   */
  transactionOf(digest: string): OutcomeFixtureTransaction | null;
}>;

function idFrom(digest: string, tag: number): string {
  const bytes = fromBase58(digest);
  bytes[0] = tag;
  return normalizeSuiAddress(toHex(bytes));
}

function created(
  objectId: string,
  owner: SuiClientTypes.ObjectOwner,
  outputState: "ObjectWrite" | "PackageWrite" = "ObjectWrite",
): SuiClientTypes.ChangedObject {
  return {
    objectId,
    inputState: "DoesNotExist",
    inputVersion: null,
    inputDigest: null,
    inputOwner: null,
    outputState,
    outputVersion: "1",
    outputDigest: GAS_COIN.digest,
    outputOwner: owner,
    idOperation: "Created",
  };
}

function address(owner: string): SuiClientTypes.ObjectOwner {
  return { $kind: "AddressOwner", AddressOwner: normalizeSuiAddress(owner) };
}

function shared(initialSharedVersion: string): SuiClientTypes.ObjectOwner {
  return { $kind: "Shared", Shared: { initialSharedVersion } };
}

function launchConfigContent(state: LaunchFixtureState): Uint8Array {
  const parent = NON_PRODUCTION_MANIFEST.sharedObjects.launchpad.launchConfig.objectId;
  const delayed = { parent, key: null, delay_ms: 172_800_000n, pending: null };
  return launchConfigBcs
    .serialize({
      id: { id: { bytes: parent } },
      meme_decimals: state.memeDecimals,
      quotes: state.quotes,
      trade_fees: { ...delayed, value: { quote_fee_bps: state.quoteFeeBps, meme_fee_bps: state.memeFeeBps } },
      venues: {
        parent,
        key: null,
        members: [...(state.admitsBluefin ? [WITNESSES.bluefin] : []), ...(state.admitsCetus ? [WITNESSES.cetus] : [])],
        delay_ms: delayed.delay_ms,
        admissions: [],
        pending_delay: null,
      },
      protocol_allocation: { ...delayed, value: { memeBps: state.protocolMemeBps, quoteBps: state.protocolQuoteBps } },
      protocol_lp_fees: { ...delayed, value: { meme_bps: 0n, quote_bps: 0n } },
      creation_fee: { ...delayed, value: state.creationFee },
      partners: { parent, acceptance_ends_at_ms: { id: PARTNER_TABLE, size: BigInt(Object.keys(state.partners).length) } },
    })
    .toBytes();
}

function memeModule(module: Uint8Array): string {
  const compiled = deserializeModule(module) as {
    self_module_handle_idx: number;
    module_handles: { name: number }[];
    identifiers: string[];
  };
  return compiled.identifiers[compiled.module_handles[compiled.self_module_handle_idx]!.name]!;
}

function partnerContent(objectId: string, shareBps: bigint): Uint8Array {
  const delayed = { parent: objectId, key: null, delay_ms: 604_800_000n, pending: null };
  return partnerBcs
    .serialize({
      id: { id: { bytes: objectId } },
      recipient: FIXTURE_PARTNER_RECIPIENT,
      share_bps: { ...delayed, value: shareBps },
      cap_id: { ...delayed, value: normalizeSuiAddress(`0x${"8c".repeat(32)}`) },
    })
    .toBytes();
}

/** A Move abort in the launchpad, worded as the Sui client words it. */
function launchpadAbort(rejection: NonNullable<LaunchFixtureState["rejection"]>): SuiClientTypes.ExecutionStatus {
  const location = `${LAUNCHPAD}::${rejection.module}::${rejection.functionName}`;
  return {
    success: false,
    error: {
      $kind: "MoveAbort",
      message: `MoveAbort in 4th command, abort code: ${rejection.code}, in '${location}' (instruction 12)`,
      MoveAbort: { abortCode: String(rejection.code), location: { package: LAUNCHPAD, module: rejection.module } },
    } as SuiClientTypes.ExecutionError,
  };
}

/**
 * Cetus refusing a tick spacing it does not register, worded as the Sui
 * client words an abort in the Cetus CLMM package. The code is a fixture
 * value: the app reads only that the abort is Cetus's.
 */
function cetusAbort(): SuiClientTypes.ExecutionStatus {
  const location = `${CETUS_PACKAGE}::config::get_fee_rate`;
  return {
    success: false,
    error: {
      $kind: "MoveAbort",
      message: `MoveAbort in 1st command, abort code: 2, in '${location}' (instruction 9)`,
      MoveAbort: { abortCode: "2", location: { package: CETUS_PACKAGE, module: "config" } },
    } as SuiClientTypes.ExecutionError,
  };
}

function abort(message: string): SuiClientTypes.ExecutionStatus {
  return {
    success: false,
    error: { $kind: "MoveAbort", message, MoveAbort: { abortCode: "7" } } as SuiClientTypes.ExecutionError,
  };
}

type TransactionData = ReturnType<Transaction["getData"]>;
type Argument = TransactionData["commands"][number] extends infer Command
  ? Command extends { MoveCall?: { arguments: (infer A)[] } | null } ? A : never
  : never;

/**
 * The creator settings a launch-creation transaction applies, read from its
 * commands that construct the core fee routes, allocation plan and launch settings.
 */
function appliedSettings(data: TransactionData, cetusTiers: Readonly<Record<string, string>>) {
  const values = new Map<number, unknown>();
  const pure = (argument: Argument) => {
    const index = (argument as { Input?: number }).Input;
    const input = index === undefined ? undefined : data.inputs[index];
    const bytes = input?.Pure?.bytes;
    return bytes ? fromBase64(bytes) : new Uint8Array();
  };
  const value = (argument: Argument): unknown => {
    const result = (argument as { Result?: number }).Result ?? (argument as { NestedResult?: [number, number] }).NestedResult?.[0];
    return result === undefined ? undefined : values.get(result);
  };
  const settings = {
    venue: "",
    tickSpacing: 0,
    feeRate: 0n,
    virtualQuote: 0n,
    graduationTarget: 0n,
    openingRoundMs: 0n,
    plan: null as CreatorAllocationPlan | null,
    split: null as FeeSplit | null,
    partner: null as string | null,
  };
  data.commands.forEach((command, index) => {
    if (command.MakeMoveVec) {
      values.set(index, command.MakeMoveVec.elements.map((element) => value(element as Argument)));
      return;
    }
    const call = command.MoveCall;
    if (!call) return;
    const args = call.arguments as Argument[];
    switch (`${call.module}::${call.function}`) {
      case "bps::new":
        values.set(index, bcs.u64().parse(pure(args[0]!)));
        break;
      case "payout::vesting_terms":
        values.set(index, {
          cliffDelayMs: bcs.u64().parse(pure(args[0]!)),
          periodDurationMs: bcs.u64().parse(pure(args[1]!)),
          periods: bcs.u64().parse(pure(args[2]!)),
        });
        break;
      case "option::some":
        values.set(index, value(args[0]!));
        break;
      case "payout::recipient":
        values.set(index, {
          destination: normalizeSuiAddress(bcs.Address.parse(pure(args[0]!))),
          vestingTerms: value(args[1]!) ?? null,
        });
        break;
      case "allocation::recipient_share":
        values.set(index, {
          recipient: value(args[0]!),
          memeBps: BigInt(value(args[1]!) as string),
          quoteBps: BigInt(value(args[2]!) as string),
        });
        break;
      case "fee_split::address_destination":
        values.set(index, { kind: "Address", address: normalizeSuiAddress(bcs.Address.parse(pure(args[0]!))) });
        break;
      case "fee_split::owner_destination":
        values.set(index, { kind: "Owner" });
        break;
      case "fee_split::auto_lp_destination":
        values.set(index, { kind: "AutoLp" });
        break;
      case "fee_split::holder_rewards_destination":
        values.set(index, { kind: "HolderRewards" });
        break;
      case "fee_split::burn_destination":
        values.set(index, { kind: "Burn" });
        break;
      case "fee_split::route":
        values.set(index, { destination: value(args[0]!), bps: BigInt(value(args[1]!) as string) });
        break;
      case "fee_split::new":
        values.set(index, { routes: value(args[0]!) as Route[] });
        break;
      case "allocation::plan":
        values.set(index, {
          curveMemeBps: BigInt(value(args[0]!) as string),
          lpMemeBps: BigInt(value(args[1]!) as string),
          lpQuoteBps: BigInt(value(args[2]!) as string),
          recipients: value(args[3]!),
        });
        break;
      case "launch::set_virtual_quote":
        settings.virtualQuote = BigInt(bcs.u64().parse(pure(args[2]!)));
        break;
      case "launch::set_graduation_target":
        settings.graduationTarget = BigInt(bcs.u64().parse(pure(args[2]!)));
        break;
      case "launch::set_opening_round":
        settings.openingRoundMs = BigInt(bcs.u64().parse(pure(args[2]!)));
        break;
      case "launch::set_allocation_plan":
        settings.plan = value(args[2]!) as typeof settings.plan;
        break;
      case "launch::set_lp_fee_split":
        settings.split = value(args[2]!) as typeof settings.split;
        break;
      default:
        if (call.function === "prepare" && call.module === "bluefin") {
          settings.venue = call.module;
          settings.tickSpacing = bcs.u32().parse(pure(args[4]!));
          settings.feeRate = BigInt(bcs.u64().parse(pure(args[5]!)));
        }
        // `cetus::prepare` takes the tick spacing after the venue objects; Cetus fixes the fee rate.
        if (call.function === "prepare" && call.module === "cetus") {
          settings.venue = call.module;
          settings.tickSpacing = bcs.u32().parse(pure(args[6]!));
          settings.feeRate = BigInt(cetusTiers[String(settings.tickSpacing)] ?? "0");
        }
    }
  });
  return settings;
}

/** An in-memory Sui node that publishes Meme packages, registers currencies, and creates launches. */
export function createLaunchFixtureChain(overrides: Partial<LaunchFixtureState> = {}): LaunchFixtureChain {
  const state: LaunchFixtureState = {
    chainIdentifier: NON_PRODUCTION_MANIFEST.chainIdentifier,
    reads: "available",
    simulation: "success",
    execution: "complete",
    confirmation: "checkpointed",
    registration: "automatic",
    memeDecimals: [6, 9],
    creationFee: 1_000_000_000n,
    quoteFeeBps: 100n,
    memeFeeBps: 0n,
    protocolMemeBps: 100n,
    protocolQuoteBps: 100n,
    epoch: 3n,
    admitsBluefin: true,
    admitsCetus: true,
    venueObjects: { cetus: "observed", bluefin: "observed" },
    cetusTiers: { "60": "2500", "200": "10000" },
    cetusConfigView: null,
    cetusConfigRead: "available",
    quotes: [SUI_TYPE],
    partners: {},
    rejection: null,
    clockMs: null,
    balances: {},
    ...overrides,
  };
  const calls: LaunchFixtureCalls = { simulate: 0, execute: 0, publish: 0, create: 0 };
  const objects = new Map<string, FixtureObject>();
  const landed = new Map<string, Landed>();
  const unregistered = new Map<string, string>();
  // The one gas coin every fixture transaction pays with. Executing consumes its
  // current version; a lost submission leaves it unspent.
  let gasVersion = 7;
  let gasPrevious = GAS_COIN.digest;
  let otherTransactions = 0;

  function requireReads() {
    if (state.reads === "unavailable") throw new Error("The fixture node is not answering reads.");
  }

  function sharedObject(name: string, identity: Readonly<{ objectId: string; initialSharedVersion: string | number }>) {
    const venue = VENUE_OBJECTS[name];
    const type =
      venue && state.venueObjects[venue] === "mismatch" ? SHARED_OBJECTS[name]!.type.replace(/::\w+::\w+$/, "::config::AdminCap") : SHARED_OBJECTS[name]!.type;
    return {
      objectId: identity.objectId,
      version: "90",
      digest: GAS_COIN.digest,
      owner: shared(String(identity.initialSharedVersion)),
      type,
      content:
        name === "launchpad.launchConfig"
          ? launchConfigContent(state)
          : name === "cetus.config"
            ? cetusConfigContent(identity.objectId)
            : fixtureSharedContent(name, identity.objectId),
      previousTransaction: GAS_COIN.digest,
    };
  }

  /** The fixture Cetus `GlobalConfig`'s leading fields, for the tiers it reports. */
  function cetusConfigContent(objectId: string): Uint8Array {
    const tiers = Object.entries(state.cetusConfigView ?? state.cetusTiers);
    return cetusGlobalConfigPrefixBcs
      .serialize({
        id: objectId,
        protocol_fee_rate: 2_000n,
        fee_tiers: {
          contents: tiers.map(([spacing, fee]) => ({ key: Number(spacing), value: { tick_spacing: Number(spacing), fee_rate: BigInt(fee) } })),
        },
      })
      .toBytes();
  }

  function lookupObject(id: string): FixtureObject | null {
    const objectId = normalizeSuiAddress(id);
    const deployment = sharedObjectEntries(LAUNCH_FIXTURE_MANIFEST.sharedObjects as BlastDeployment["sharedObjects"]).find(
      ([, identity]) => identity.objectId === objectId,
    );
    if (deployment) return sharedObject(deployment[0], deployment[1]);
    const partner = state.partners[objectId];
    if (partner) {
      return {
        objectId,
        version: "12",
        digest: GAS_COIN.digest,
        owner: shared(PARTNER_SHARED_VERSION),
        type: `${PARTNERS}::blast_partners::Partner`,
        content: partnerContent(objectId, partner.shareBps),
        previousTransaction: GAS_COIN.digest,
      };
    }
    if (objectId === GAS_COIN.objectId) {
      return {
        objectId,
        version: String(gasVersion),
        digest: GAS_COIN.digest,
        owner: address(`0x${"6c".repeat(32)}`),
        type: `${normalizeSuiAddress("0x2")}::coin::Coin<${SUI_TYPE}>`,
        content: new Uint8Array(),
        previousTransaction: gasPrevious,
      };
    }
    return objects.get(objectId) ?? null;
  }

  function present(object: FixtureObject) {
    return { ...object, json: null, objectBcs: undefined, display: undefined };
  }

  function register(memeType: string, digest: string) {
    const objectId = deriveObjectID(SUI_COIN_REGISTRY_OBJECT_ID, `0x2::coin_registry::CurrencyKey<${memeType}>`, new Uint8Array([0]));
    objects.set(objectId, {
      objectId,
      version: "20",
      digest: GAS_COIN.digest,
      owner: shared("20"),
      type: `${normalizeSuiAddress("0x2")}::coin_registry::Currency<${memeType}>`,
      content: new Uint8Array(),
      previousTransaction: digest,
    });
  }

  function publish(digest: string, sender: string, module: Uint8Array): Landed {
    calls.publish += 1;
    const packageId = idFrom(digest, 1);
    const moduleName = memeModule(module);
    const memeType = normalizeStructTag(`${packageId}::${moduleName}::${moduleName.toUpperCase()}`);
    const ticketId = idFrom(digest, 2);
    const currencyId = idFrom(digest, 3);
    const ticketType = `${LAUNCHPAD}::launch_ticket::LaunchTicket<${memeType}>`;
    const currencyType = `${normalizeSuiAddress("0x2")}::coin_registry::Currency<${memeType}>`;
    objects.set(ticketId, {
      objectId: ticketId,
      version: "1",
      digest: GAS_COIN.digest,
      owner: address(sender),
      type: ticketType,
      content: new Uint8Array(),
      previousTransaction: digest,
    });
    unregistered.set(memeType, digest);
    if (state.registration === "automatic") registerCurrencies();
    return {
      status: { success: true, error: null },
      changedObjects: [
        created(packageId, { $kind: "Immutable", Immutable: true }, "PackageWrite"),
        created(ticketId, address(sender)),
        created(currencyId, address(SUI_COIN_REGISTRY_OBJECT_ID)),
      ],
      objectTypes: { [ticketId]: ticketType, [currencyId]: currencyType },
    };
  }

  function objectInput(data: ReturnType<Transaction["getData"]>, argument: unknown): string | null {
    const index = (argument as { Input?: number } | undefined)?.Input;
    const input = index === undefined ? undefined : data.inputs[index];
    return input?.Object?.ImmOrOwnedObject?.objectId ?? input?.Object?.SharedObject?.objectId ?? null;
  }

  /**
   * The shared launch as `launch::finalize` and `share` leave it, for the
   * settings approval two applied. Fields the fixture does not track (the
   * ticket's sell burn and creator, reserves, and ledgers) are zero or empty.
   */
  function launchContent(launchId: string, applied: ReturnType<typeof appliedSettings>, partner: string | null): Uint8Array {
    const plan = applied.plan ?? { curveMemeBps: 0n, lpMemeBps: 0n, lpQuoteBps: 0n, recipients: [] };
    const split = applied.split ?? { routes: [] };
    const zero = 0n;
    return launchBcs
      .serialize({
        id: { id: { bytes: launchId } },
        lifecycle: applied.openingRoundMs > 0n ? { OpeningRound: true } : { Live: true },
        public_start_ms: state.clockMs ?? BigInt(Date.now()),
        opening_round_ms: applied.openingRoundMs,
        opening_round_bids: 0n,
        opening_round_quote: zero,
        opening_round_meme: zero,
        sell_burn_bps: 0n,
        virtual_quote: applied.virtualQuote,
        graduation_target: applied.graduationTarget,
        quote_fee_bps: state.quoteFeeBps,
        meme_fee_bps: state.memeFeeBps,
        venue: WITNESSES[applied.venue === "cetus" ? "cetus" : "bluefin"],
        lp_fee_split: split,
        atomic_supply: 0n,
        meme_reserve: zero,
        real_quote_reserve: zero,
        pending_burn: zero,
        allocation_plan: { ...plan, protocolMemeBps: state.protocolMemeBps, protocolQuoteBps: state.protocolQuoteBps },
        allocated_meme: zero,
        protocol_fees: { packageWitness: `${LAUNCHPAD}::blast_fun::PackageWitness`, origin: launchId, partnerId: partner, meme: zero, quote: zero, sui: state.creationFee },
        creator_meme_fees: zero,
        creator_quote_fees: zero,
        metadata_cap: { id: { id: { bytes: normalizeSuiAddress(`0x${"4d".repeat(32)}`) } } },
        curve_fee_cap_reassignment: { parent: launchId, key: null, delay_ms: 172_800_000n, pending: null },
        creator_metadata_cap_reassignment: { parent: launchId, key: null, delay_ms: 172_800_000n, pending: null },
        creator: null,
        curve_fee_cap_id: null,
        creator_metadata_cap_id: null,
        partner_id: partner,
      })
      .toBytes();
  }

  /** Whether a creation starts a Cetus launch at a tick spacing the fixture Cetus does not register. */
  function cetusRefuses(data: TransactionData): boolean {
    const applied = appliedSettings(data, state.cetusTiers);
    return applied.venue === "cetus" && state.cetusTiers[String(applied.tickSpacing)] === undefined;
  }

  function create(digest: string, sender: string, data: ReturnType<Transaction["getData"]>): Landed {
    calls.create += 1;
    if (cetusRefuses(data)) return { status: cetusAbort(), changedObjects: [], objectTypes: {} };
    const start = data.commands.find((command) => command.MoveCall?.module === "launch" && command.MoveCall.function === "new")?.MoveCall;
    const ticketId = start ? objectInput(data, start.arguments[0]) : null;
    const ticket = ticketId ? objects.get(normalizeSuiAddress(ticketId)) : undefined;
    const memeType = start?.typeArguments[0];
    const owned = ticket?.owner.$kind === "AddressOwner" && ticket.owner.AddressOwner === normalizeSuiAddress(sender);
    if (!ticket || !owned || !memeType) {
      return { status: abort("The launch ticket is not available (abort 7)."), changedObjects: [], objectTypes: {} };
    }
    const setPartner = data.commands.find((command) => command.MoveCall?.function === "set_partner")?.MoveCall;
    const partner = setPartner ? objectInput(data, setPartner.arguments[3]) : null;
    if (partner !== null) {
      // Mirrors `launch_config::assert_partner` (abort 36, `partner_not_accepted`).
      const until = state.partners[normalizeSuiAddress(partner)]?.acceptedUntilMs;
      if (until === undefined || until === null || (state.clockMs ?? BigInt(Date.now())) >= until) {
        const status = launchpadAbort({ module: "launch_config", functionName: "assert_partner", code: 36 });
        return { status, changedObjects: [], objectTypes: {} };
      }
    }
    objects.delete(ticket.objectId);
    const launchId = idFrom(digest, 4);
    const launchType = `${LAUNCHPAD}::launch::Launch<${normalizeStructTag(memeType)}, ${SUI_TYPE}>`;
    objects.set(launchId, {
      objectId: launchId,
      version: "30",
      digest: GAS_COIN.digest,
      owner: shared("30"),
      type: launchType,
      content: launchContent(launchId, appliedSettings(data, state.cetusTiers), partner),
      previousTransaction: digest,
    });
    return {
      status: { success: true, error: null },
      changedObjects: [
        {
          ...created(ticket.objectId, address(sender)),
          inputState: "Exists",
          outputState: "DoesNotExist",
          outputOwner: null,
          outputVersion: null,
          outputDigest: null,
          idOperation: "Deleted",
        },
        created(launchId, shared("30")),
      ],
      objectTypes: { [launchId]: launchType },
      // The creator's first buy (`launch::buy` before `share`) emits its `Bought` before the launch is shared.
      events: [
        ...(firstBuy(data) ? [launchpadEvent(sender, memeType, "Bought", firstBuyEvent(launchId))] : []),
        launchpadEvent(sender, memeType, "LaunchShared", launchpadEventBcs.LaunchShared.serialize({ launch_id: launchId, public_start_ms: 0n }).toBytes()),
      ],
    };
  }

  /** Whether a creation buys before sharing: the creator's first buy, as the SDK builds it. */
  function firstBuy(data: TransactionData): boolean {
    return data.commands.some((command) => command.MoveCall?.module === "launch" && command.MoveCall.function === "buy");
  }

  /** The fixture `Bought` of a creator's first buy; the amounts are fixture values, not a curve quote. */
  function firstBuyEvent(launchId: string): Uint8Array {
    return launchpadEventBcs.Bought.serialize({
      launch_id: launchId,
      quote_in: 5_000_000_000n,
      meme_out_gross: 2_000_000_000_000n,
      meme_out_net: 2_000_000_000_000n,
      quote_refund: 0n,
      protocol_meme_fee: 0n,
      creator_meme_fee: 0n,
      protocol_quote_fee: 0n,
      creator_quote_fee: 0n,
      meme_reserve: 798_000_000_000_000_000n,
      real_quote_reserve: 5_000_000_000n,
    }).toBytes();
  }

  function launchpadEvent(sender: string, memeType: string, name: string, bcs: Uint8Array): SuiClientTypes.Event {
    return {
      packageId: LAUNCHPAD,
      module: "launch",
      sender: normalizeSuiAddress(sender),
      eventType: `${LAUNCHPAD}::events::${name}<${memeType},${SUI_TYPE}>`,
      bcs,
      json: null,
    };
  }

  /**
   * The `LaunchCreated` event a successful creation emits, for the settings it
   * applies (Cetus's fee rate from the fixture Cetus); null for any other
   * transaction. The fields the fixture does not track are zero.
   */
  function launchCreatedEvent(digest: string, sender: string, data: TransactionData): SuiClientTypes.Event | null {
    const applied = appliedSettings(data, state.cetusTiers);
    if (!applied.venue) return null;
    const plan = applied.plan ?? { curveMemeBps: 0n, lpMemeBps: 0n, lpQuoteBps: 0n, recipients: [] };
    const zero = normalizeSuiAddress("0x0");
    const memeType = data.commands.find((command) => command.MoveCall?.module === "launch" && command.MoveCall.function === "new")?.MoveCall?.typeArguments[0];
    if (!memeType) return null;
    const payload = launchpadEventBcs.LaunchCreated.serialize({
      launch_id: idFrom(digest, 4),
      ticket_id: zero,
      venue: WITNESSES[applied.venue as "bluefin" | "cetus"],
      lp_fee_split: applied.split ?? { routes: [] },
      virtual_quote: applied.virtualQuote,
      graduation_target: applied.graduationTarget,
      quote_fee_bps: state.quoteFeeBps,
      meme_fee_bps: state.memeFeeBps,
      allocation_plan: { ...plan, protocolMemeBps: state.protocolMemeBps, protocolQuoteBps: state.protocolQuoteBps },
      opening_round_ms: applied.openingRoundMs,
      creation_fee: state.creationFee,
      partner_id: null,
    });
    return {
      packageId: MIGRATORS,
      module: applied.venue,
      sender: normalizeSuiAddress(sender),
      eventType: `${LAUNCHPAD}::events::LaunchCreated<${memeType},${SUI_TYPE}>`,
      bcs: payload.toBytes(),
      json: null,
    };
  }

  function result(digest: string, found: Landed, checkpoint: string | null, events: SuiClientTypes.Event[] = []) {
    const transaction = {
      digest,
      signatures: [],
      epoch: "3",
      timestampMs: checkpoint === null ? null : FIXTURE_CHECKPOINT_MS,
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
        changedObjects: found.changedObjects,
        unchangedConsensusObjects: [],
        auxiliaryDataDigest: null,
      },
      events: [...(found.events ?? []), ...events],
      objectTypes: found.objectTypes,
      transaction: undefined,
      bcs: undefined,
    };
    return found.status.success
      ? { $kind: "Transaction" as const, Transaction: transaction }
      : { $kind: "FailedTransaction" as const, FailedTransaction: transaction };
  }

  /** Consumes the gas coin's current version in `digest` and returns its effect entry. */
  function spend(digest: string): SuiClientTypes.ChangedObject {
    const input = String(gasVersion);
    gasVersion += 1;
    gasPrevious = digest;
    return {
      ...created(GAS_COIN.objectId, address(`0x${"6c".repeat(32)}`)),
      inputState: "Exists",
      inputVersion: input,
      inputDigest: GAS_COIN.digest,
      outputVersion: String(gasVersion),
      idOperation: "None",
    };
  }

  function lookupTransaction(digest: string) {
    requireReads();
    const found = landed.get(digest);
    if (!found) throw new Error(`Transaction ${digest} was not found.`);
    if (state.confirmation === "pending") throw new Error(`Transaction ${digest} is not checkpointed yet.`);
    return result(digest, found, FIXTURE_CHECKPOINT);
  }

  function registerCurrencies(): number {
    const pending = [...unregistered];
    for (const [memeType, digest] of pending) register(memeType, digest);
    unregistered.clear();
    return pending.length;
  }

  const core = {
    async getChainIdentifier() {
      requireReads();
      return { chainIdentifier: state.chainIdentifier };
    },
    async getObjects({ objectIds, include }: Readonly<{ objectIds: readonly string[]; include?: { content?: boolean } }>) {
      requireReads();
      const cetusConfig = LAUNCH_FIXTURE_MANIFEST.sharedObjects.cetus?.config.objectId;
      if (state.cetusConfigRead === "failing" && include?.content && cetusConfig && objectIds.length === 1 && normalizeSuiAddress(objectIds[0]!) === cetusConfig) {
        throw new Error("The fixture node timed out reading the Cetus GlobalConfig.");
      }
      return {
        objects: objectIds.map((id) => {
          const object = lookupObject(id);
          return object ? present(object) : new Error(`Object ${id} does not exist.`);
        }),
      };
    },
    async listOwnedObjects({ owner, type }: Readonly<{ owner: string; type?: string }>) {
      requireReads();
      const wanted = normalizeSuiAddress(owner);
      const matches = [...objects.values()].filter(
        (object) =>
          object.owner.$kind === "AddressOwner" &&
          object.owner.AddressOwner === wanted &&
          (!type || object.type === type || object.type.startsWith(`${type}<`)),
      );
      return { objects: matches.map(present), hasNextPage: false, cursor: null };
    },
    async getObject({ objectId }: Readonly<{ objectId: string }>) {
      requireReads();
      const object = lookupObject(objectId);
      if (!object) throw new ObjectError("notFound", `Object ${objectId} does not exist.`, { reason: "notFound" });
      return { object: present(object) };
    },
    async getDynamicField({ parentId, name }: Readonly<{ parentId: string; name: SuiClientTypes.DynamicFieldName }>) {
      requireReads();
      const parent = normalizeSuiAddress(parentId);
      const missing = () => new ObjectError("notFound", "The dynamic field does not exist.", { reason: "notFound" });
      let value: Uint8Array | null = null;
      const valueType = "u64";
      if (parent === PARTNER_TABLE && normalizeStructTag(name.type) === normalizeStructTag("0x2::object::ID")) {
        const until = state.partners[normalizeSuiAddress(bcs.Address.parse(name.bcs))]?.acceptedUntilMs;
        if (until !== undefined && until !== null) value = bcs.u64().serialize(until).toBytes();
      }
      if (!value) throw missing();
      return {
        dynamicField: {
          $kind: "DynamicField" as const,
          fieldId: normalizeSuiAddress(`0x${"7d".repeat(32)}`),
          type: `0x2::dynamic_field::Field<${name.type}, ${valueType}>`,
          name,
          valueType,
          value: { type: valueType, bcs: value },
          version: "90",
          digest: GAS_COIN.digest,
          previousTransaction: null,
        },
      };
    },
    async getCurrentSystemState() {
      requireReads();
      return { systemState: { epoch: String(state.epoch) } };
    },
    async getBalance({ owner }: Readonly<{ owner: string }>) {
      requireReads();
      const balance = String(state.balances[normalizeSuiAddress(owner)] ?? 100_000_000_000n);
      return { balance: { coinType: SUI_TYPE, balance, coinBalance: balance, addressBalance: "0" } };
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
      const status: SuiClientTypes.ExecutionStatus = state.rejection
        ? launchpadAbort(state.rejection)
        : cetusRefuses(data)
          ? cetusAbort()
          : state.simulation === "success"
            ? { success: true, error: null }
            : abort("The launchpad rejected this (abort 7).");
      const created = status.success ? launchCreatedEvent(digest, data.sender ?? normalizeSuiAddress("0x0"), data) : null;
      return { ...result(digest, { status, changedObjects: [], objectTypes: {} }, null, created ? [created] : []), commandResults: undefined };
    },
    async executeTransaction({ transaction, signatures }: Readonly<{ transaction: Uint8Array; signatures: string[] }>) {
      calls.execute += 1;
      const signer = await verifyTransactionSignature(transaction, signatures[0] ?? "", { offline: true });
      const digest = TransactionDataBuilder.getDigestFromBytes(transaction);
      if (state.execution === "dropped") throw new Error("The Sui node closed the connection before answering.");
      const sender = signer.toSuiAddress();
      const data = Transaction.from(transaction).getData();
      const expiration = data.expiration?.$kind === "Epoch" ? BigInt(data.expiration.Epoch) : null;
      if (expiration !== null && state.epoch > expiration) {
        throw new Error("The transaction expired before it could execute.");
      }
      if (data.gasData.payment?.[0]?.version !== String(gasVersion)) {
        throw new Error("The gas coin version this transaction pays with was already used.");
      }
      const gas = spend(digest);
      const publication = data.commands.find((command) => command.Publish)?.Publish;
      const outcome: Landed =
        state.execution === "abort"
          ? { status: abort("The launchpad rejected this (abort 7)."), changedObjects: [], objectTypes: {} }
          : publication
            ? publish(digest, sender, fromBase64(publication.modules[0]!))
            : create(digest, sender, data);
      const executed = { ...outcome, changedObjects: [...outcome.changedObjects, gas] };
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
    registerCurrencies,
    spendGas() {
      otherTransactions += 1;
      const digest = toBase58(Uint8Array.from({ length: 32 }, (_, index) => (index * 31 + otherTransactions * 7) % 256));
      landed.set(digest, { status: { success: true, error: null }, changedObjects: [spend(digest)], objectTypes: {} });
    },
    consumeTicket(ticketId) {
      const ticket = objects.get(normalizeSuiAddress(ticketId));
      if (ticket) objects.delete(ticket.objectId);
    },
    partnerOf(launchId) {
      const launch = objects.get(normalizeSuiAddress(launchId));
      const partnerId = launch ? launchBcs.parse(launch.content).partner_id : null;
      return partnerId ? normalizeSuiAddress(partnerId) : null;
    },
    transactionOf(digest) {
      const found = landed.get(digest);
      if (!found || state.confirmation === "pending") return null;
      return {
        digest,
        success: found.status.success,
        checkpoint: FIXTURE_CHECKPOINT,
        timestampMs: FIXTURE_CHECKPOINT_MS,
        events: found.events ?? [],
      };
    },
    ownedTickets(owner) {
      const wanted = normalizeSuiAddress(owner);
      return [...objects.values()]
        .filter((object) => object.type.includes("::launch_ticket::LaunchTicket<"))
        .filter((object) => object.owner.$kind === "AddressOwner" && object.owner.AddressOwner === wanted)
        .map((object) => object.objectId);
    },
  };
}
