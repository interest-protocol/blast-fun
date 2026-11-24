import { migratorsDeployment, presaleDeployment } from "@interest-protocol/blast-deployments-sdk";
import { decodeCetusPoolObject, resolveCetusVenueRoute } from "@interest-protocol/blast-deployments-sdk/cetus-venue";
import { decodeBluefinPoolObject, resolveBluefinVenueRoute } from "@interest-protocol/blast-deployments-sdk/bluefin-venue";
import { venueOf } from "@interest-protocol/blast-migrators-sdk";
import { decodePoolCreationObject } from "@interest-protocol/blast-presale-sdk/aftermath-dao";
import { PRESALE_PAUSE_BITS } from "@interest-protocol/blast-presale-sdk/transactions";
import { normalizeStructTag } from "@mysten/sui/utils";
import { errorLabel } from "@blast/core/lib/metrics.ts";
import { checkIndex } from "../worker-runtime/index-identity.ts";
import { WORKER_METRICS } from "../worker-runtime/log.ts";
import type { WorkerJob, ProtocolWorkerAccess } from "../worker-runtime/runtime.ts";
import { dueCandidates, recordDue, type Candidate, type KeeperContext, type KeeperActionKind } from "./actions.ts";
import { readBluefinFee, readPartner, readRegistryCurrency, readSale, readVault, sharedObject } from "./chain.ts";
import { parseKeeperAction, keeperTransaction, type KeeperActionIntent } from "./transactions.ts";
import { kares, karesPoolSimulated, karesReady } from "./kares.ts";
import { BluefinFeeRefusal, requireBluefinFee } from "./bluefin-fee.ts";
import type { KeeperSigner } from "./signer.ts";

const VAULT_FEE_INTERVAL_MS = 60 * 60 * 1000;
const CHECK_INTERVAL_MS = 60_000;
const identity = (object: { objectId: string; initialSharedVersion: string | number }) => ({ objectId: object.objectId, initialSharedVersion: String(object.initialSharedVersion) });
const hasFees = (ledger: { meme: bigint; quote: bigint; sui: bigint }) => ledger.meme > 0n || ledger.quote > 0n || ledger.sui > 0n;

export function presaleAction(sale: Awaited<ReturnType<typeof readSale>>, now: bigint): "settle" | "cancel" | "migrate" | null {
  if (sale.lifecycle === "Open") {
    const filled = sale.hardCap?.closesWhenFilled && sale.hardCapFromMs !== null && now >= sale.hardCapFromMs && sale.totalCommitments >= sale.raiseTarget;
    return now >= sale.endMs || filled ? "settle" : null;
  }
  return sale.lifecycle === "Funded" ? (now >= sale.liquidityDeadlineMs ? "cancel" : "migrate") : null;
}

async function partner(context: KeeperContext, id: string | null) {
  if (!id) return null;
  const value = await readPartner(context.client, id, context.deployment.packages.partners.originalPackageId, context.provider);
  if (!value) throw new Error("partner-unavailable");
  return value;
}
async function currency(context: KeeperContext, type: string) {
  const value = await readRegistryCurrency(context.client, type, context.provider);
  if (!value) throw new Error("currency-unavailable");
  return value;
}

async function preparePresale(context: KeeperContext, row: Candidate, creationFeeCapMist: bigint): Promise<KeeperActionIntent | null> {
  const sale = await readSale(context, row);
  const action = presaleAction(sale, BigInt(Date.now()));
  const base = { object: identity(sale), memeType: sale.saleTokenType, quoteType: sale.quoteType };
  if (!action) return null;
  if ((action === "settle" || action === "migrate") && karesReady(sale, row.pool_creation_id)) {
    if ((context.protocol.paused.presale & PRESALE_PAUSE_BITS.Migrate) !== 0) throw new Error("migration-paused");
    return { kind: "kares-migrate", object: kares.object, memeType: kares.memeType, quoteType: kares.quoteType, settle: action === "settle" };
  }
  if (action === "settle") return { kind: "presale-settle", ...base };
  if (action === "cancel") return { kind: "presale-cancel", ...base };
  if ((context.protocol.paused.presale & PRESALE_PAUSE_BITS.Migrate) !== 0) throw new Error("migration-paused");
  const venue = venueOf(migratorsDeployment(context.deployment), sale.venue);
  if (venue) {
    if (!context.protocol.venues[venue].available) throw new Error("venue-unavailable");
    const memeCurrency = await currency(context, sale.saleTokenType);
    if (venue === "bluefin") {
      const fee = requireBluefinFee(await readBluefinFee(context.client, context.deployment, context.provider), creationFeeCapMist);
      return { kind: "presale-migrate", ...base, venue, creationFeeMist: String(fee), currency: memeCurrency, quoteCurrency: await currency(context, sale.quoteType) };
    }
    return { kind: "presale-migrate", ...base, venue, creationFeeMist: "0", currency: memeCurrency };
  }
  const vendor = presaleDeployment(context.deployment).aftermathDaoPresale;
  if (!vendor || normalizeStructTag(sale.venue) !== normalizeStructTag(`${vendor.originalPackageId}::blast_aftermath_dao_presale::Venue`) || !context.protocol.venues.aftermathDao.available || !row.pool_creation_id) throw new Error("unsupported-presale-venue");
  const poolCreation = await sharedObject(context, row.pool_creation_id);
  const reservation = decodePoolCreationObject(poolCreation, vendor);
  const witness = `${context.deployment.packages.presale.originalPackageId}::blast_presale_package::PackageWitness`;
  if (normalizeStructTag(reservation.saleTokenType) !== normalizeStructTag(sale.saleTokenType) || normalizeStructTag(reservation.packageWitness) !== normalizeStructTag(witness)) throw new Error("pool-creation-binding-mismatch");
  return { kind: "presale-vendor-migrate", ...base, lpType: reservation.lpType, poolCreation: identity(poolCreation) };
}

async function preparePresalePartner(context: KeeperContext, row: Candidate): Promise<KeeperActionIntent | null> {
  const sale = await readSale(context, row);
  if (sale.lifecycle !== "Migrated" || !hasFees(sale.feeLedger)) return null;
  const receiver = await partner(context, sale.partnerId);
  return receiver ? { kind: "presale-partner", object: identity(sale), memeType: sale.saleTokenType, quoteType: sale.quoteType, partner: receiver } : null;
}

async function prepareVaultPartner(context: KeeperContext, row: Candidate): Promise<KeeperActionIntent | null> {
  const vault = await readVault(context, row);
  if (!hasFees(vault.protocol)) return null;
  const receiver = await partner(context, vault.terms.partnerId);
  return receiver ? { kind: "vault-partner", object: identity(vault), memeType: vault.memeType, quoteType: vault.quoteType, partner: receiver } : null;
}

async function prepareVaultFees(context: KeeperContext, row: Candidate): Promise<KeeperActionIntent> {
  const vault = await readVault(context, row);
  const base = { object: identity(vault), memeType: vault.memeType, quoteType: vault.quoteType };
  const venue = venueOf(migratorsDeployment(context.deployment), row.venue_type!);
  if (!venue || !context.protocol.venues[venue].available) throw new Error("venue-unavailable");
  const pool = await sharedObject(context, vault.poolId);
  if (venue === "cetus") {
    const lineage = context.deployment.packages.cetusClmm;
    if (!lineage) throw new Error("venue-unrecorded");
    const state = decodeCetusPoolObject(pool, lineage.originalPackageId);
    resolveCetusVenueRoute({ deployment: context.deployment, vault, pool: state, launch: { memeType: vault.memeType, quoteType: vault.quoteType, venue: row.venue_type!, poolTickSpacing: state.tickSpacing, poolFeeRate: state.feeRate } });
  } else {
    const lineage = context.deployment.packages.bluefinSpot;
    if (!lineage) throw new Error("venue-unrecorded");
    const state = decodeBluefinPoolObject(pool, lineage.originalPackageId);
    if (state.isPaused) throw new Error("pool-paused");
    resolveBluefinVenueRoute({ deployment: context.deployment, vault, pool: state, launch: { memeType: vault.memeType, quoteType: vault.quoteType, venue: row.venue_type!, poolTickSpacing: state.tickSpacing, poolFeeRate: state.feeRate } });
  }
  return { kind: "vault-fees", ...base, venue, currency: await currency(context, vault.memeType), pool: identity(pool), settleFeeSplit: vault.pendingFeeSplit !== null && BigInt(Date.now()) >= vault.pendingFeeSplit.ready_at_ms };
}

const preparers = {
  presale: preparePresale,
  "presale-partner": preparePresalePartner,
  "vault-partner": prepareVaultPartner,
  "vault-fees": prepareVaultFees,
};

function migrationAdmission(intent: KeeperActionIntent) {
  return intent.kind === "kares-migrate" ? karesPoolSimulated : undefined;
}

async function visitCandidate(context: KeeperContext, kind: KeeperActionKind, row: Candidate, name: string, interval: number, creationFeeCapMist: bigint): Promise<void> {
  const scope = { network: context.deployment.network, fingerprint: context.fingerprint, kind, objectId: row.object_id };
  const key = `${scope.network}:${scope.fingerprint}:${kind}:${row.object_id}`;
  if (!await context.leases.acquire(name, key)) return;
  let delay = interval;
  let error: string | null = null;
  let digest: string | null = null;
  let outcome: "failed" | "executed" | "unchanged" = "unchanged";
  try {
    const intent = await preparers[kind](context, row, creationFeeCapMist);
    if (intent && await context.gasAvailable()) {
      const result = await context.submit({
        recordKeys: [key], intent, transaction: keeperTransaction(context.deployment, intent),
        admit: migrationAdmission(intent),
        async beforeSubmit(txDigest) {
          if (!await context.leases.renew(name, key)) return false;
          await recordDue(context.pool, scope, interval, "awaiting-effects", txDigest);
          return true;
        },
        async reconcile() { return kind.startsWith("vault-") ? readVault(context, row) : readSale(context, row); },
      });
      digest = result.digest;
      outcome = result.outcome === "executed" ? "executed" : "failed";
      if (result.outcome !== "executed") {
        error = result.outcome;
        delay = kind === "vault-fees" ? interval : context.backoffMs(row.attempts + 1);
      }
    }
  } catch (failure) {
    context.log(WORKER_METRICS.handledError, { job: name, error: errorLabel(failure) });
    outcome = "failed";
    error = failure instanceof BluefinFeeRefusal ? failure.message : "keeper-action-unavailable";
    delay = kind === "vault-fees" ? interval : Math.max(CHECK_INTERVAL_MS, context.backoffMs(row.attempts + 1));
  } finally {
    try { await recordDue(context.pool, scope, delay, error, digest, outcome); }
    finally { await context.leases.release(name, key); }
  }
}

/** A bounded, fair pass. Failed/no-op objects advance too; custody lives in the shared runtime journal. */
export function keeperActionJob(kind: KeeperActionKind, creationFeeCapMist = 0n): WorkerJob<ProtocolWorkerAccess, KeeperSigner> {
  const name = `keeper-${kind}`;
  const interval = kind === "vault-fees" ? VAULT_FEE_INTERVAL_MS : CHECK_INTERVAL_MS;
  return {
    name,
    sign(signer, bytes, raw, deployment, beforeCrypto) {
      return signer.signActions(bytes, [parseKeeperAction(raw)], deployment, beforeCrypto);
    },
    async run(context) {
      // Any index this deployment cannot use, or one with no committed checkpoint yet, blocks with one reason.
      const index = await checkIndex(context.pool, context.deployment.network, context.fingerprint);
      if (index.blocked || index.checkpoint === null) return { blocked: ["index-identity-mismatch"] };
      for (const row of await dueCandidates(context, kind)) {
        if (!context.canSign()) break;
        // Recheck this one hard-capped sale on each pass until it leaves the open/funded feed.
        const cadence = kind === "presale" && row.object_id === kares.object.objectId ? context.config.timings.pollIntervalMs : interval;
        await visitCandidate(context, kind, row, name, cadence, creationFeeCapMist);
      }
      return { blocked: null };
    },
  };
}
