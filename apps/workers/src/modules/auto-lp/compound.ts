import type { MigratorVenue as Venue } from "@blast/core/modules/launchpad-contract/venues.ts";
import { coreRoleType } from "@interest-protocol/blast-core/roles";
import {
  coreDeployment,
  migratorsDeployment,
  vaultDeployment,
} from "@interest-protocol/blast-deployments-sdk";
import {
  BLUEFIN_MAX_SQRT_PRICE_X64,
  BLUEFIN_MIN_SQRT_PRICE_X64,
  decodeBluefinPoolObject,
  resolveBluefinVenueRoute,
} from "@interest-protocol/blast-deployments-sdk/bluefin-venue";
import {
  CETUS_MAX_SQRT_PRICE_X64,
  CETUS_MIN_SQRT_PRICE_X64,
  decodeCetusPoolObject,
  resolveCetusVenueRoute,
} from "@interest-protocol/blast-deployments-sdk/cetus-venue";
import { MigratorCalls } from "@interest-protocol/blast-migrators-sdk/transactions";
import { vaultEventBcs } from "@interest-protocol/blast-vault-sdk/events";
import { decodeVaultObject, type VaultState } from "@interest-protocol/blast-vault-sdk/state";
import { VAULT_PAUSE_BITS } from "@interest-protocol/blast-vault-sdk/transactions";
import type { ClientWithCoreApi, SuiClientTypes } from "@mysten/sui/client";
import type { GrpcSimulateTransactionOptions } from "@mysten/sui/grpc";
import { Transaction, TransactionDataBuilder } from "@mysten/sui/transactions";
import { normalizeStructTag, normalizeSuiAddress, parseStructTag } from "@mysten/sui/utils";

import { adminCapReference, capRoles } from "../worker-runtime/admin.ts";
import { readDigestOutcome } from "../worker-runtime/outcome.ts";
import type { Provider } from "../worker-runtime/provider.ts";
import { payFromSenderBalance } from "../worker-runtime/address-balance.ts";
import { sendOnce, simulatedGasCostMist, type AttemptBounds } from "../worker-runtime/attempt.ts";
import type { WorkerAccess } from "../worker-runtime/deployment.ts";

const REFERENCE_MAX_AGE_MS = 5 * 60_000;
const SQRT_PRICE_BAND_BPS = 50n;
const BPS = 10_000n;
export const MAX_AUTO_LP_GAS_BUDGET_MIST = 250_000_000n;

export class AutoLpRefusal extends Error {}

type Access = Extract<WorkerAccess, { status: "enabled" }>;
type Target = {
  vaultId: string;
  poolId: string;
  sender: string;
  capId: string;
};
export type AutoLpRequest = Target & {
  referenceSqrtPrice: bigint;
  referenceTimeMs: number;
  gasBudgetMist: bigint;
};

type ReceiptIdentity = { eventType: string; vaultId: string; sender: string };
type Addition = ReturnType<typeof vaultEventBcs.AutoLiquidityAdded.parse>;
export type AutoLpAttempt = ReceiptIdentity & { digest: string; epoch: string };

export function priceBand(venue: Venue, reference: bigint, spot: bigint) {
  const [min, max] =
    venue === "cetus"
      ? [CETUS_MIN_SQRT_PRICE_X64, CETUS_MAX_SQRT_PRICE_X64]
      : [BLUEFIN_MIN_SQRT_PRICE_X64, BLUEFIN_MAX_SQRT_PRICE_X64];
  if (reference < min || reference > max) {
    throw new AutoLpRefusal("Reference sqrt price is outside the venue range.");
  }
  const delta = (reference * SQRT_PRICE_BAND_BPS) / BPS;
  const minSqrtPrice = reference - delta > min ? reference - delta : min;
  const maxSqrtPrice = reference + delta < max ? reference + delta : max;
  if (spot < minSqrtPrice || spot > maxSqrtPrice) {
    throw new AutoLpRefusal("Pool spot is outside the reviewed price band.");
  }
  return { minSqrtPrice, maxSqrtPrice };
}

export function requireFreshReference(referenceTimeMs: number, now = Date.now()): void {
  if (
    !Number.isSafeInteger(referenceTimeMs) ||
    referenceTimeMs > now ||
    now - referenceTimeMs > REFERENCE_MAX_AGE_MS
  ) {
    throw new AutoLpRefusal("The reviewed price reference must be at most five minutes old.");
  }
}

function venueOf(vault: VaultState, access: Access): Venue {
  const tag = parseStructTag(vault.venue);
  if (
    tag.address !== access.deployment.packages.migrators?.originalPackageId ||
    tag.name !== "Venue" ||
    tag.typeParams.length !== 0 ||
    (tag.module !== "cetus" && tag.module !== "bluefin")
  ) {
    throw new AutoLpRefusal("The vault does not belong to a supported migrator venue.");
  }
  if (!access.protocol.venues[tag.module].available) {
    throw new AutoLpRefusal("The vault venue is unavailable for this deployment.");
  }
  return tag.module;
}

async function readMarket(
  client: ClientWithCoreApi,
  access: Access,
  target: Target,
  provider: Provider,
) {
  const { deployment } = access;
  const vault = decodeVaultObject(
    await readShared(client, target.vaultId, provider),
    vaultDeployment(deployment),
  );
  if (vault.objectId !== target.vaultId || vault.poolId !== target.poolId) {
    throw new AutoLpRefusal("The supplied pool does not match the vault's recorded pool.");
  }
  if (vault.autoLpMeme === 0n || vault.autoLpQuote === 0n) {
    throw new AutoLpRefusal("Both pending Auto-LP balances must be positive.");
  }
  const venue = venueOf(vault, access);
  const pair = {
    memeType: vault.memeType,
    quoteType: vault.quoteType,
    venue: vault.venue,
  };
  const poolObject = await readShared(client, target.poolId, provider);
  if (venue === "cetus") {
    const lineage = deployment.packages.cetusClmm;
    if (!lineage) throw new AutoLpRefusal("Cetus is missing from the deployment.");
    const pool = decodeCetusPoolObject(poolObject, lineage.originalPackageId);
    const route = resolveCetusVenueRoute({
      deployment,
      vault,
      pool,
      launch: {
        ...pair,
        poolTickSpacing: pool.tickSpacing,
        poolFeeRate: pool.feeRate,
      },
    });
    if (pool.liquidity === 0n) throw new AutoLpRefusal("The Cetus pool has no active liquidity.");
    return { venue, vault, pool, config: route.cetusConfig } as const;
  }
  const lineage = deployment.packages.bluefinSpot;
  if (!lineage) throw new AutoLpRefusal("Bluefin is missing from the deployment.");
  const pool = decodeBluefinPoolObject(poolObject, lineage.originalPackageId);
  const route = resolveBluefinVenueRoute({
    deployment,
    vault,
    pool,
    launch: {
      ...pair,
      poolTickSpacing: pool.tickSpacing,
      poolFeeRate: pool.feeRate,
    },
  });
  if (pool.isPaused || pool.liquidity === 0n)
    throw new AutoLpRefusal("The Bluefin pool is paused or has no active liquidity.");
  return { venue, vault, pool, config: route.bluefinConfig } as const;
}

async function readShared(client: ClientWithCoreApi, objectId: string, provider: Provider) {
  const { object } = await provider((signal) =>
    client.core.getObject({ objectId, include: { content: true }, signal }),
  );
  if (object.objectId !== objectId || object.owner.$kind !== "Shared") {
    throw new AutoLpRefusal("The node did not return the requested shared object.");
  }
  return {
    ...object,
    initialSharedVersion: object.owner.Shared.initialSharedVersion,
  };
}

function liquidityAdded(
  events: readonly SuiClientTypes.Event[],
  identity: ReceiptIdentity,
): Addition | null {
  const [event, ...duplicates] = events.filter(
    (event) =>
      normalizeStructTag(event.eventType) === identity.eventType &&
      normalizeSuiAddress(event.sender) === identity.sender,
  );
  if (!event || duplicates.length > 0) return null;
  const bcs = vaultEventBcs.AutoLiquidityAdded;
  const addition = bcs.parse(event.bcs);
  if (
    bcs.serialize(addition).toBase64() !== Buffer.from(event.bcs).toString("base64") ||
    addition.vault_id !== identity.vaultId ||
    addition.meme_amount === 0n ||
    addition.quote_amount === 0n
  ) {
    return null;
  }
  return addition;
}

export async function prepareAutoLp({
  client,
  access,
  request,
  provider,
}: {
  client: ClientWithCoreApi;
  access: Access;
  request: AutoLpRequest;
  provider: Provider;
}) {
  requireFreshReference(request.referenceTimeMs);
  if (request.gasBudgetMist <= 0n || request.gasBudgetMist > MAX_AUTO_LP_GAS_BUDGET_MIST) {
    throw new AutoLpRefusal("Gas budget must be positive and at most 0.25 SUI.");
  }
  if ((access.protocol.paused.vault & VAULT_PAUSE_BITS.Admin) !== 0) {
    throw new AutoLpRefusal("Vault administration is paused.");
  }
  const { deployment } = access;
  const role = normalizeStructTag(coreRoleType(coreDeployment(deployment), "AutoLpAdmin"));
  const [cap, roles] = await Promise.all([
    adminCapReference(client, request.capId, request.sender, provider),
    capRoles(client, deployment, request.capId, provider),
  ]);
  if (cap?.objectId !== request.capId || roles?.length !== 1 || roles[0] !== role) {
    throw new AutoLpRefusal("The sender must own a cap holding only AutoLpAdmin.");
  }
  const { venue, vault, pool, config } = await readMarket(client, access, request, provider);
  const band = priceBand(venue, request.referenceSqrtPrice, pool.currentSqrtPrice);
  const { memeType, quoteType } = vault;
  const migrators = new MigratorCalls(migratorsDeployment(deployment));
  const tx = new Transaction();
  const options = {
    memeType,
    quoteType,
    vault,
    pool,
    ...band,
    adminCap: tx.objectRef(cap),
  };
  tx.add(
    venue === "cetus"
      ? migrators.compoundCetusAutoLp({ ...options, cetus: { config } })
      : migrators.compoundBluefinAutoLp({ ...options, bluefinConfig: config }),
  );

  const payment = await payFromSenderBalance(tx, {
    client,
    provider,
    sender: request.sender,
    gasBudgetMist: request.gasBudgetMist,
    chainIdentifier: deployment.chainIdentifier,
  });
  if (payment.kind !== "ready") {
    throw new AutoLpRefusal("Chain identity or sender address gas balance is invalid.");
  }
  const { epoch } = payment;
  const bytes = await tx.build();
  const digest = TransactionDataBuilder.getDigestFromBytes(bytes);
  const eventType = normalizeStructTag(
    `${deployment.packages.vault.originalPackageId}::blast_vault_events::AutoLiquidityAdded<${memeType},${quoteType}>`,
  );
  const attempt = {
    digest,
    epoch,
    eventType,
    vaultId: request.vaultId,
    sender: request.sender,
  };

  const simulation = await provider((signal) => {
    const options = {
      transaction: bytes,
      doGasSelection: false,
      include: { effects: true, events: true },
      signal,
    } satisfies GrpcSimulateTransactionOptions<{ effects: true; events: true }>;
    return client.core.simulateTransaction(options);
  });
  const simulated = simulation.Transaction;
  if (
    simulation.$kind !== "Transaction" ||
    simulation.gasPaymentMocked ||
    !simulated?.effects?.status.success
  ) {
    throw new AutoLpRefusal("The exact compounding transaction failed simulation.");
  }
  const addition = liquidityAdded(simulated.events ?? [], attempt);
  if (
    !addition ||
    addition.meme_amount + addition.auto_lp_meme_pending !== vault.autoLpMeme ||
    addition.quote_amount + addition.auto_lp_quote_pending !== vault.autoLpQuote
  ) {
    throw new AutoLpRefusal(
      "Simulation did not add both assets or pending balances changed. Refresh the inputs.",
    );
  }
  requireFreshReference(request.referenceTimeMs);
  return {
    bytes,
    attempt,
    referenceTimeMs: request.referenceTimeMs,
    preview: {
      venue,
      poolId: pool.objectId,
      memeType,
      quoteType,
      ...band,
      addition,
      coinTypeA: pool.coinTypeA,
      coinTypeB: pool.coinTypeB,
      currentSqrtPrice: pool.currentSqrtPrice,
      gasCostMist: simulatedGasCostMist(simulated.effects.gasUsed),
    },
  };
}

export async function reconcileAutoLp(
  client: ClientWithCoreApi,
  attempt: AutoLpAttempt,
  provider: Provider,
) {
  const outcome = await readDigestOutcome(client, provider, attempt.digest, { effects: true, events: true });
  if (outcome.kind === "unknown") throw outcome.error;
  if (outcome.kind === "failed") return { outcome: "failed" } as const;
  if (outcome.kind !== "executed") return { outcome: "unknown" } as const;
  const tx = outcome.transaction;
  const addition = liquidityAdded(tx.events ?? [], attempt);
  return addition
    ? ({ outcome: "compounded", addition } as const)
    : ({ outcome: "unconfirmed-addition" } as const);
}

export async function executeAutoLp({
  client,
  prepared,
  sign,
  record,
  bounds,
  provider,
}: {
  client: ClientWithCoreApi;
  prepared: Awaited<ReturnType<typeof prepareAutoLp>>;
  sign: (bytes: Uint8Array) => Promise<{ signature: string }>;
  record: (attempt: AutoLpAttempt) => Promise<void>;
  bounds: AttemptBounds;
  provider: Provider;
}) {
  const { bytes, attempt, referenceTimeMs } = prepared;
  requireFreshReference(referenceTimeMs);
  const { signature } = await sign(bytes);
  await record(attempt);
  requireFreshReference(referenceTimeMs);
  await sendOnce(client, bytes, { signature, digest: attempt.digest }, bounds);
  return reconcileAutoLp(client, attempt, provider);
}
