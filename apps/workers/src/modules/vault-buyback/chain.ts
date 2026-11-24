// What the chain says about one buyback, read fresh through the canonical SDK
// before every attempt. Only the transport runs inside the provider budget;
// decoding runs outside it, so a decode failure is never reported as a
// provider outage.

import type { BlastDeployment } from "@interest-protocol/blast-deployments-sdk";
import {
  cetusVenuePrice,
  decodeCetusPoolObject,
  resolveCetusVenueRoute,
} from "@interest-protocol/blast-deployments-sdk/cetus-venue";
import { bluefinVenuePrice, decodeBluefinPoolObject, resolveBluefinVenueRoute } from "@interest-protocol/blast-deployments-sdk/bluefin-venue";
import { coreDeployment, vaultDeployment } from "@interest-protocol/blast-deployments-sdk";
import { coreRoleType } from "@interest-protocol/blast-core/roles";
import { decodeVaultObject, type VaultState } from "@interest-protocol/blast-vault-sdk/state";
import { vaultEventBcs } from "@interest-protocol/blast-vault-sdk/events";
import { vaultAbortName } from "@interest-protocol/blast-vault-sdk/aborts";
import type { ClientWithCoreApi, SuiClientTypes } from "@mysten/sui/client";
import { normalizeStructTag, normalizeSuiAddress, normalizeSuiObjectId, parseStructTag } from "@mysten/sui/utils";

import { readDigestOutcome } from "#workers/modules/worker-runtime/outcome.ts";
import type { Provider } from "#workers/modules/worker-runtime/provider.ts";
import { readSharedObject, type SharedObject } from "#workers/modules/worker-runtime/shared-object.ts";
import type { ExactPrice } from "./pricing.ts";
import type { BuybackRow } from "./repository.ts";

async function sharedObject(client: ClientWithCoreApi, objectId: string, provider: Provider): Promise<SharedObject> {
  const object = await readSharedObject(client, objectId, provider);
  if (typeof object === "string") throw new BuybackReadError(object);
  return object;
}

/** A chain fact the buyback needs is missing or not what the deployment says: the vault waits, never signs. */
export class BuybackReadError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(`The buyback's chain read failed: ${code}.`);
    this.name = "BuybackReadError";
    this.code = code;
  }
}

/** The vault, its pool and route as the chain holds them now. */
export type BuybackMarket = Readonly<{
  vault: VaultState;
  /** The pool as the builder takes it. */
  pool: Readonly<{ objectId: string; initialSharedVersion: string; mutable: true }>;
  /** The pool's Quote balance. */
  poolQuote: bigint;
  spot: ExactPrice;
}>;

/**
 * Reads the vault and its pool, and resolves the launch's recorded route with
 * the SDK, which fails closed unless the pool is the vault's and of the
 * launch's venue, coins and tier in this deployment.
 */
export async function readMarket(client: ClientWithCoreApi, deployment: BlastDeployment, row: BuybackRow, provider: Provider): Promise<BuybackMarket> {
  const migrators = deployment.packages.migrators;
  if (!migrators) throw new BuybackReadError("no-migrators-package");
  const [vaultObject, poolObject] = await Promise.all([
    sharedObject(client, row.vaultId, provider),
    sharedObject(client, row.poolId, provider),
  ]);
  let vault: VaultState;
  try {
    vault = decodeVaultObject(vaultObject, vaultDeployment(deployment));
  } catch {
    throw new BuybackReadError("vault-unreadable");
  }
  if (
    normalizeStructTag(vault.memeType) !== normalizeStructTag(row.memeType) ||
    normalizeStructTag(vault.quoteType) !== normalizeStructTag(row.quoteType) ||
    normalizeSuiObjectId(vault.poolId) !== normalizeSuiObjectId(row.poolId) ||
    normalizeSuiObjectId(vault.terms.origin) !== normalizeSuiObjectId(row.originId) ||
    normalizeStructTag(vault.terms.packageWitness) !== normalizeStructTag(row.packageWitness)
  ) {
    throw new BuybackReadError("vault-mismatch");
  }
  const launch = {
    memeType: row.memeType,
    quoteType: row.quoteType,
    venue: row.venueType,
    poolTickSpacing: row.poolTickSpacing,
    poolFeeRate: row.poolFeeRate ?? 0n,
  };
  try {
    if (row.venue === "cetus") {
      const cetus = deployment.packages.cetusClmm;
      if (!cetus) throw new BuybackReadError("venue-unrecorded");
      const pool = decodeCetusPoolObject(poolObject, cetus.originalPackageId);
      const route = resolveCetusVenueRoute({ deployment, launch: { ...launch, poolFeeRate: pool.feeRate }, vault, pool });
      return {
        vault,
        pool: { objectId: route.pool.objectId, initialSharedVersion: String(route.pool.initialSharedVersion), mutable: true },
        poolQuote: route.memeIsCoinA ? pool.balanceB : pool.balanceA,
        spot: cetusVenuePrice(pool.currentSqrtPrice, route.memeIsCoinA),
      };
    }
    const bluefin = deployment.packages.bluefinSpot;
    if (!bluefin) throw new BuybackReadError("venue-unrecorded");
    const pool = decodeBluefinPoolObject(poolObject, bluefin.originalPackageId);
    if (pool.isPaused) throw new BuybackReadError("pool-paused");
    const route = resolveBluefinVenueRoute({ deployment, launch, vault, pool });
    return {
      vault,
      pool: { objectId: route.pool.objectId, initialSharedVersion: String(route.pool.initialSharedVersion), mutable: true },
      poolQuote: pool.balanceB,
      spot: bluefinVenuePrice(pool.currentSqrtPrice),
    };
  } catch (error) {
    if (error instanceof BuybackReadError) throw error;
    throw new BuybackReadError("route-refused");
  }
}

/** The core `BuybackAdmin` role type: the only role the buyback cap may hold. */
export function buybackRole(deployment: BlastDeployment): string {
  return normalizeStructTag(coreRoleType(coreDeployment(deployment), "BuybackAdmin"));
}

/** What one of our digests did: its `BuybackBurned` when it succeeded, its error when it failed, or nothing the node knows. */
export type DigestOutcome =
  | Readonly<{ kind: "executed"; quoteSpent: bigint; memeBurned: bigint; quotePending: bigint }>
  | Readonly<{ kind: "failed"; error: SuiClientTypes.ExecutionError | null }>
  | Readonly<{ kind: "missing" }>
  | Readonly<{ kind: "unreadable" }>;

export async function digestOutcome(
  client: ClientWithCoreApi,
  digest: string,
  vaultId: string,
  vaultOriginalPackageId: string,
  provider: Provider,
): Promise<DigestOutcome> {
  const outcome = await readDigestOutcome(client, provider, digest, { effects: true, events: true });
  if (outcome.kind === "unknown") throw outcome.error;
  if (outcome.kind === "not-found" || outcome.kind === "no-effects" || outcome.kind === "other-transaction") return { kind: "missing" };
  // Our transaction with effects of another digest, a node fault: wait for readable effects rather than replan.
  if (outcome.kind === "other-effects") return { kind: "unreadable" };
  const { transaction } = outcome;
  const status = transaction.effects.status;
  if (!status.success) return { kind: "failed", error: status.error ?? null };
  for (const event of transaction.events ?? []) {
    let payload: ReturnType<(typeof vaultEventBcs)["BuybackBurned"]["parse"]>;
    try {
      const tag = parseStructTag(event.eventType);
      if (tag.address !== normalizeSuiAddress(vaultOriginalPackageId) || tag.module !== "blast_vault_events" || tag.name !== "BuybackBurned" || tag.typeParams.length !== 2) continue;
      payload = vaultEventBcs.BuybackBurned.parse(event.bcs);
    } catch {
      continue;
    }
    if (normalizeSuiObjectId(payload.vault_id) === normalizeSuiObjectId(vaultId)) {
      return { kind: "executed", quoteSpent: payload.quote_spent, memeBurned: payload.meme_burned, quotePending: payload.burn_quote_pending };
    }
  }
  return { kind: "unreadable" };
}

/**
 * Whether a failure is the contract's `min_meme_out` refusal:
 * `vault::burn_buyback`'s `EBuybackBelowMinimum` in this deployment's
 * vault package (its clever error constant or package-wide numeric code).
 */
export function isMinOutAbort(error: SuiClientTypes.ExecutionError | null | undefined, vaultPackages: readonly string[]): boolean {
  if (!error || error.$kind !== "MoveAbort") return false;
  const abort = error.MoveAbort;
  const location = abort.location;
  if (!location?.package || location.module !== "vault") return false;
  if (!vaultPackages.some((id) => normalizeSuiAddress(id) === normalizeSuiAddress(location.package!))) return false;
  return abort.cleverError?.constantName === "EBuybackBelowMinimum" || vaultAbortName(Number(abort.abortCode)) === "EBuybackBelowMinimum";
}
