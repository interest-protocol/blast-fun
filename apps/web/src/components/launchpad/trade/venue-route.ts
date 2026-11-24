import { diagnosticMessage } from "#web/lib/errors.ts";
// A migrated launch's venue route, derived only from chain records: the fresh
// launch object (its recorded `migration_witness` and tier), the committed
// migration transaction (the launchpad's `Migrated` for this launch and the
// vault's one `VaultCreated`), the LP vault it created, and the venue pool,
// all checked against the deployment's lineage by the SDK. The digest that
// locates the migration is only a locator: every fact it leads to is read and
// checked here. Nobody can choose another venue or pool.
//
// The venue dispatch: the rail trades a venue only through its own SDK
// driver, chosen by the venue the launch recorded: Cetus CLMM through the
// SDK's Cetus adapter (`venue-cetus.ts`) and Bluefin Spot through its Bluefin
// adapter (`venue-bluefin.ts`). Any other recorded venue is refused with a
// specific reason, never routed elsewhere.

import {
  defineBlastDeployment,
  evaluateProtocolAccess,
  vaultDeployment,
  observeDeploymentRuntime,
  type BlastDeployment,
  type VenueAvailability,
} from "@interest-protocol/blast-sdk/deployments";
import { decodeLaunchObject, decodeLaunchpadEvent, memeAtomicSupply, type LaunchState } from "@interest-protocol/blast-sdk/launchpad";
import {
  BluefinVenueError,
  CetusVenueError,
  venueOf,
  type BluefinVenueTrade,
  type CetusVenueRejection,
  type CetusVenueTrade,
  type MigratorVenue,
} from "@interest-protocol/blast-sdk/migrators";
import { decodeVaultEvent, decodeVaultObject, vaultId, type VaultState } from "@interest-protocol/blast-sdk/vault";
import { ObjectError, type ClientWithCoreApi, type SuiClientTypes } from "@mysten/sui/client";
import { normalizeStructTag, normalizeSuiAddress, parseStructTag } from "@mysten/sui/utils";

import { readQuoteAsset, type QuoteAsset } from "./quote-asset.ts";

import { describeError } from "../transaction/errors.ts";
import type { LaunchpadChain, SimulatedTransaction } from "../transaction/preflight.ts";
import { bluefinPoolPrice, BluefinPoolLayoutUnsupported, readBluefinSwap, resolveBluefinRecord, type BluefinRecord } from "./venue-bluefin.ts";
import { cetusPoolPrice, readCetusSwap, resolveCetusRecord, type CetusRecord } from "./venue-cetus.ts";
import { VENUE_PRODUCTS } from "@blast/core/modules/launchpad-contract/venues.ts";


export type VenueRefusal =
  | "not-migrated"
  | "unsupported-venue"
  | "unsupported-route"
  | "unsupported-quote"
  | Extract<CetusVenueRejection, "deployment-mismatch" | "foreign-lineage" | "route-substitution" | "unsupported-tier">;

/** Where the recorded route comes from; the page supplies both, and neither is trusted on its own. */
export type VenueLocator = Readonly<{
  launchId: string;
  /** The launch's migration transaction, as its classified activity names it. */
  migrationDigest: string | null;
  /** The venue pool the page names (`<venue>:<pool id>`); a route that disagrees is refused. */
  poolKey: string | null;
}>;

/** The recorded route and the objects it was read from, at one observation; the pool is the venue driver's. */
export type RecordedVenue = Readonly<{
  launch: LaunchState;
  launchType: string;
  decimals: number;
  quote: QuoteAsset;
  symbol: string;
  vault: VaultState;
  vaultType: string;
  migrationDigest: string;
  observedAtMs: number;
}> &
  (Readonly<{ venue: "cetus"; cetus: CetusRecord }> | Readonly<{ venue: "bluefin"; bluefin: BluefinRecord }>);

export type VenueRouteRead =
  | Readonly<{ status: "ok"; recorded: RecordedVenue }>
  | Readonly<{ status: "refused"; code: VenueRefusal; venue: string | null; message: string }>
  | Readonly<{ status: "unavailable"; message: string }>;


/** The SDK route rejections that are final for a locator; the rest concern quotes and signing. */
const ROUTE_REFUSALS: ReadonlySet<string> = new Set(["deployment-mismatch", "foreign-lineage", "route-substitution", "unsupported-tier"]);

/** The recorded venue pool as last read: its object ID, type, and version. */
export function recordedPool(recorded: RecordedVenue): Readonly<{ objectId: string; type: string; version: string }> {
  const { pool, poolType, poolVersion } = recorded.venue === "cetus" ? recorded.cetus : recorded.bluefin;
  return { objectId: pool.objectId, type: poolType, version: poolVersion };
}

/** The recorded pool's price as last read, in Quote atoms per Meme atom, by its venue's SDK adapter. */
export function recordedPoolPrice(recorded: RecordedVenue) {
  return recorded.venue === "cetus" ? cetusPoolPrice(recorded.cetus) : bluefinPoolPrice(recorded.bluefin);
}

/** One completed swap seen from the Meme; both venues' SDK adapters state it alike. */
export type VenueTrade = CetusVenueTrade | BluefinVenueTrade;

/** What a completed transaction's one swap in the recorded pool did, by its venue's SDK adapter; null when it holds none. */
export function readRecordedSwap(transaction: SimulatedTransaction, recorded: RecordedVenue): VenueTrade | null {
  return recorded.venue === "cetus" ? readCetusSwap(transaction, recorded.cetus.route) : readBluefinSwap(transaction, recorded.bluefin.route);
}

class Refused extends Error {
  readonly code: VenueRefusal;
  readonly venue: string | null;

  constructor(code: VenueRefusal, message: string, venue: string | null = null) {
    super(message);
    this.code = code;
    this.venue = venue;
  }
}

function decimalsOf(atomicSupply: bigint): number | null {
  for (let decimals = 0; decimals <= 19; decimals += 1) {
    if (memeAtomicSupply(decimals) === atomicSupply) return decimals;
  }
  return null;
}

async function readLaunch(client: ClientWithCoreApi, deployment: BlastDeployment, launchId: string) {
  const { object } = await client.core.getObject({ objectId: launchId, include: { content: true } });
  if (object.owner.$kind !== "Shared") throw new Refused("foreign-lineage", "This object is not a shared Blast launch.");
  let launch: LaunchState;
  try {
    launch = decodeLaunchObject(
      { objectId: object.objectId, initialSharedVersion: object.owner.Shared.initialSharedVersion, mutable: true, type: object.type, content: object.content },
      deployment.packages.launchpad.originalPackageId,
    );
  } catch (error) {
    throw new Refused("foreign-lineage", `This object is not a launch of this Blast deployment: ${describeError(error)}`);
  }
  return { launch, type: object.type };
}

/** The migration's `VaultCreated`, checked to be this launch's migration and its only vault. */
async function readMigration(client: ClientWithCoreApi, deployment: BlastDeployment, launch: LaunchState, digest: string, venue: MigratorVenue) {
  const migrators = deployment.packages.migrators;
  if (!migrators) throw new Refused("deployment-mismatch", "This Blast deployment has no migrators package.");
  const result = await client.core.getTransaction({ digest, include: { events: true } });
  const transaction = result.Transaction;
  if (result.$kind !== "Transaction" || !transaction?.status.success) {
    throw new Refused("route-substitution", `Transaction ${digest} is not a completed migration.`);
  }
  const events = (transaction.events ?? []).map((event, eventIndex) => ({
    ...event,
    checkpoint: transaction.checkpoint,
    transactionDigest: transaction.digest,
    eventIndex,
  })) as unknown as SuiClientTypes.EventEntry[];
  const migrated = events.some((event) => {
    try {
      const decoded = decodeLaunchpadEvent(event as Parameters<typeof decodeLaunchpadEvent>[0], deployment.packages.launchpad);
      return decoded.kind === "Migrated" && normalizeSuiAddress(decoded.payload.launch_id) === launch.objectId;
    } catch {
      return false;
    }
  });
  const witness = normalizeStructTag(`${deployment.packages.launchpad.originalPackageId}::blast_fun::PackageWitness`);
  const configured = vaultDeployment(deployment);
  const expected = vaultId(configured, witness, launch.objectId);
  const vaults = events.flatMap((event) => {
    try {
      const decoded = decodeVaultEvent(event, configured);
      return decoded.kind === "VaultCreated" &&
        decoded.payload.vault_id === expected &&
        decoded.payload.terms.origin === launch.objectId &&
        normalizeStructTag(decoded.payload.terms.packageWitness) === witness &&
        normalizeStructTag(decoded.venue) === normalizeStructTag(launch.venue) &&
        decoded.memeType === normalizeStructTag(launch.memeType) &&
        decoded.quoteType === normalizeStructTag(launch.quoteType)
        ? [decoded.payload]
        : [];
    } catch {
      return [];
    }
  });
  if (!migrated || vaults.length !== 1) {
    throw new Refused("route-substitution", `Transaction ${digest} is not this launch's migration.`, venue);
  }
  return { vaultId: expected, poolId: vaults[0]!.pool_id, witness };
}

/**
 * Reads the launch's recorded venue route. `refused` is final for this
 * locator (an unsupported venue or route, or a record that does not match the
 * launch, the deployment, or the page's pool); `unavailable` may pass.
 */
export async function readVenueRoute(
  client: ClientWithCoreApi,
  deployment: BlastDeployment,
  locator: VenueLocator,
  nowMs: number,
): Promise<VenueRouteRead> {
  try {
    const { launch, type: launchType } = await readLaunch(client, deployment, locator.launchId);
    if (launch.lifecycle !== "Migrated") {
      throw new Refused("not-migrated", "This launch has not migrated, so it has no venue pool to trade on.");
    }
    const migrators = deployment.packages.migrators;
    if (!migrators) throw new Refused("deployment-mismatch", "This Blast deployment has no migrators package.");
    const venue = venueOf(migrators, launch.venue);
    if (!venue) throw new Refused("unsupported-route", "This launch records a venue outside the configured migrators.", parseStructTag(launch.venue).module);
    const decimals = decimalsOf(launch.atomicSupply);
    if (decimals === null) throw new Refused("foreign-lineage", "This launch's supply is not a canonical Blast supply.", venue);
    if (!locator.migrationDigest) return { status: "unavailable", message: "The launch's migration record is not available yet, so its venue route cannot be read." };
    const migration = await readMigration(client, deployment, launch, locator.migrationDigest, venue);
    const { object: vaultObject } = await client.core.getObject({ objectId: migration.vaultId, include: { content: true } });
    let vault: VaultState;
    try {
      if (vaultObject.owner.$kind !== "Shared") throw new TypeError("the vault is not shared");
      vault = decodeVaultObject(
        { objectId: vaultObject.objectId, initialSharedVersion: vaultObject.owner.Shared.initialSharedVersion, type: vaultObject.type, content: vaultObject.content },
        vaultDeployment(deployment),
      );
    } catch (error) {
      throw new Refused("foreign-lineage", `The migration's vault is not a vault of this deployment: ${describeError(error)}`, venue);
    }
    if (vault.poolId !== migration.poolId || vault.terms.origin !== launch.objectId ||
      normalizeStructTag(vault.terms.packageWitness) !== migration.witness ||
      normalizeStructTag(vault.venue) !== normalizeStructTag(launch.venue)) {
      throw new Refused("route-substitution", "The vault does not match the launch and pool recorded at migration.", venue);
    }
    const common = {
      launch,
      launchType,
      decimals,
      quote: await readQuoteAsset(client, launch.quoteType),
      symbol: parseStructTag(launch.memeType).name,
      vault,
      vaultType: vaultObject.type,
      migrationDigest: locator.migrationDigest,
      observedAtMs: nowMs,
    };
    const recorded: RecordedVenue =
      venue === "cetus"
        ? { ...common, venue, cetus: await resolveCetusRecord(client, deployment, launch, vault) }
        : { ...common, venue, bluefin: await resolveBluefinRecord(client, deployment, launch, vault) };
    const poolKey = `${venue}:${recordedPool(recorded).objectId}`;
    if (locator.poolKey !== null && locator.poolKey !== poolKey) {
      throw new Refused("route-substitution", `The page names pool ${locator.poolKey}, but this launch recorded ${poolKey}. Nothing can be signed.`, venue);
    }
    return { status: "ok", recorded };
  } catch (error) {
    return venueRouteFailure(error);
  }
}

function venueRouteFailure(error: unknown): VenueRouteRead {
  if (error instanceof Refused) return { status: "refused", code: error.code, venue: error.venue, message: error.message };
  if (error instanceof CetusVenueError && error.code !== "signing-disabled" && error.code !== "venue-unavailable" && error.code !== "expired-quote" && error.code !== "invalid-quote" && error.code !== "effects-mismatch") {
    return { status: "refused", code: error.code, venue: "cetus", message: diagnosticMessage("The recorded Cetus route does not match this launch. Trading is unavailable.", { code: error.code }) };
  }
  if (error instanceof BluefinVenueError && ROUTE_REFUSALS.has(error.code)) {
    return { status: "refused", code: error.code as VenueRefusal, venue: "bluefin", message: diagnosticMessage("The recorded Bluefin Spot route does not match this launch. Nothing can be signed.", { code: error.code }) };
  }
  if (error instanceof BluefinPoolLayoutUnsupported) return { status: "refused", code: "unsupported-route", venue: "bluefin", message: error.message };
  if (error instanceof ObjectError) return { status: "unavailable", message: describeError(error) };
  return { status: "unavailable", message: `The venue route could not be read from Sui: ${describeError(error)}` };
}

/**
 * Whether the confirmed deployment makes `venue` available now, as every
 * venue signature requires (`ProtocolAccess.venues`). It is advisory for the
 * rail: each review checks it again in its preflight.
 */
export async function readVenueAvailability(chain: LaunchpadChain, venue: MigratorVenue): Promise<VenueAvailability> {
  try {
    const deployment = defineBlastDeployment(chain.manifest);
    const runtime = await observeDeploymentRuntime(chain.client, deployment);
    return evaluateProtocolAccess({ manifest: deployment, mode: chain.mode, runtime }).venues[venue];
  } catch (error) {
    return { available: false, reasons: [{ code: "runtime-unverified", message: describeError(error) }] };
  }
}

/** A venue's unavailability in words, with the SDK's reason codes. */
export function describeVenueUnavailable(venue: MigratorVenue, availability: Extract<VenueAvailability, { available: false }>): string {
  const codes = [...new Set(availability.reasons.map((reason) => reason.code))].join(", ");
  return `${VENUE_PRODUCTS[venue]} trading is unavailable for this Blast deployment (venue-unavailable${codes ? `: ${codes}` : ""}). Nothing can be signed.`;
}
