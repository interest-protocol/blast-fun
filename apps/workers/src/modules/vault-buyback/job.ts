// Both products' vaults share one randomized buyback schedule and one guarded
// BuybackAdmin signer. Each attempt reads custody and venue state fresh;
// committed indexer candles supply the price reference, never the balance.

import { adminDeployment, coreDeployment, migratorsDeployment, resolveVenueObjects, VenueUnavailableError } from "@interest-protocol/blast-deployments-sdk";
import { AdminCalls } from "@interest-protocol/blast-admin-sdk/transactions";
import { coreRoleType } from "@interest-protocol/blast-core/roles";
import { VAULT_PAUSE_BITS } from "@interest-protocol/blast-vault-sdk/transactions";
import { MigratorCalls } from "@interest-protocol/blast-migrators-sdk";
import { Transaction } from "@mysten/sui/transactions";
import { normalizeSuiObjectId } from "@mysten/sui/utils";

import { errorLabel } from "@blast/core/lib/metrics.ts";
import { isDatabaseUnavailableError } from "@blast/core/modules/database/availability.ts";
import type { MarketDataDependencies } from "@blast/core/modules/read-routing/market-data.ts";
import { WORKER_METRICS } from "#workers/modules/worker-runtime/log.ts";
import { readRegistryCurrency } from "#workers/modules/blast-keeper/chain.ts";
import { ProviderUnavailable } from "#workers/modules/worker-runtime/provider.ts";
import type { JobContext, JobPass, WorkerJob } from "#workers/modules/worker-runtime/runtime.ts";
import { SignerRefusal } from "#workers/modules/worker-runtime/signer.ts";
import { adminCapReference } from "#workers/modules/worker-runtime/admin.ts";
import type { BuybackAccess } from "./access.ts";
import {
  BuybackReadError,
  digestOutcome,
  isMinOutAbort,
  readMarket,
  type DigestOutcome,
} from "./chain.ts";
import { discoverVaults, readQuoteUsd, readReference } from "./infra.ts";
import { decideBuyback, type BuybackDecision } from "./pricing.ts";
import {
  BUYBACK_JOB,
  dueRows,
  planDay,
  recordExecuted,
  recordVaults,
  recordSubmitted,
  recordVisit,
  unplanned,
  type BuybackRow,
} from "./repository.ts";
import { drawAmount, drawRunTime, nextPieceTime, retryDelay, secureRandom, shuffled, utcDay, type RandomSource } from "./schedule.ts";
import type { BuybackSettings } from "./settings.ts";
import type { BuybackIntent, BuybackSigner } from "./signer.ts";

export const BUYBACK_METRICS = Object.freeze({
  /** One discovery sweep: vaults seen, new ones recorded, whether it read every page. */
  discovered: "buyback.discovered",
  /** Vaults given today's run time this pass. */
  planned: "buyback.planned",
  /** One vault's visit: outcome (a skip reason, `submitted`, `executed`, …) and venue. */
  visit: "buyback.visit",
  /** A piece of ours landed: per vault, the Quote spent and the Meme burned, and the next piece's plan. */
  burned: "buyback.burned",
  /** A `min_meme_out` abort: the vault's consecutive count. */
  minOutAbort: "buyback.min_out_abort",
  /** One pass: vaults visited, executed, and duration. */
  pass: "buyback.pass",
});

/** The worker alert channel, or a test's. */
export type BuybackAlerts = Readonly<{
  raise(key: string, details?: Readonly<Record<string, string | number | boolean | null>>): Promise<unknown>;
  clear(key: string): Promise<void>;
}>;

/** The job's reads, replaceable in tests. */
export type BuybackReads = Readonly<{
  discoverVaults: typeof discoverVaults;
  readReference: typeof readReference;
  readQuoteUsd: typeof readQuoteUsd;
  readMarket: typeof readMarket;
  readRegistryCurrency: typeof readRegistryCurrency;
  adminCapReference: typeof adminCapReference;
  digestOutcome: typeof digestOutcome;
}>;

export type BuybackSetup = Readonly<{
  settings: BuybackSettings;
  market: MarketDataDependencies;
  alerts: BuybackAlerts;
  /** The CSPRNG by default; tests inject their own. */
  random?: RandomSource;
  now?: () => number;
  reads?: Partial<BuybackReads>;
}>;

type Context = JobContext<BuybackAccess, BuybackSigner>;

type Visit = Readonly<{ outcome: string; executed?: boolean }>;

/** At most this many vaults get today's run time in one pass. */
const PLANS_PER_PASS = 1_000;

const DEFAULT_READS: BuybackReads = {
  discoverVaults,
  readReference,
  readQuoteUsd,
  readMarket,
  readRegistryCurrency,
  adminCapReference,
  digestOutcome,
};

export function buybackJob(setup: BuybackSetup): WorkerJob<BuybackAccess, BuybackSigner> {
  const { settings, market, alerts } = setup;
  const random = setup.random ?? secureRandom;
  const now = setup.now ?? Date.now;
  const reads: BuybackReads = { ...DEFAULT_READS, ...setup.reads };
  async function discover(context: Context): Promise<void> {
    const {vaults,complete}=await reads.discoverVaults(context.pool,context.deployment.network,context.fingerprint,
      settings.referenceMaxLagMs,settings.discoveryMaxPages);
    const recorded=await recordVaults(context.pool,context.deployment.network,vaults);
    context.log(BUYBACK_METRICS.discovered,{seen:vaults.length,recorded,complete});
  }

  async function plan(context: Context, day: string): Promise<void> {
    const network = context.deployment.network;
    let planned = 0;
    for (const vaultId of await unplanned(context.pool, network, day, PLANS_PER_PASS)) {
      if (await planDay(context.pool, network, vaultId, day, new Date(drawRunTime(now(), random)))) planned += 1;
    }
    if (planned > 0) context.log(BUYBACK_METRICS.planned, { count: planned });
  }

  /** Waits a random delay within today, or ends today's plan when the day is over first. */
  async function later(context: Context, row: BuybackRow, outcome: string, minOutAbort = false): Promise<number> {
    const at = now() + retryDelay(context.config.timings.retryMaxMs, random);
    const done = at >= utcDay(now()).endMs;
    return recordVisit(context.pool, row, { outcome, done, nextEligibleAt: done ? null : new Date(at), minOutAbort });
  }

  async function minOutAborted(context: Context, row: BuybackRow): Promise<Visit> {
    const streak = await later(context, row, "min-out-abort", true);
    context.log(BUYBACK_METRICS.minOutAbort, { vaultId: row.vaultId, venue: row.venue, consecutive: streak });
    if (streak >= settings.abortAlertAfter) {
      await alerts.raise(`buyback_min_out:${row.vaultId}`, {
        vaultId: row.vaultId,
        originId: row.originId,
        venue: row.venue,
        consecutive: streak,
        slippageBps: Number(settings.slippageBps),
      });
    }
    return { outcome: "min-out-abort" };
  }

  async function settleDigest(context: Context, row: BuybackRow, outcome: DigestOutcome): Promise<Visit> {
    if (outcome.kind === "executed") {
      // Quote is left and today allows more: the next piece runs at a random later time today.
      const next =
        outcome.quotePending > 0n && row.piecesToday + 1 < settings.maxPiecesPerDay
          ? nextPieceTime(now(), settings.minPieceGapMs, random)
          : null;
      await recordExecuted(context.pool, row, outcome, next === null ? null : new Date(next));
      context.log(BUYBACK_METRICS.burned, {
        vaultId: row.vaultId,
        originId: row.originId,
        venue: row.venue,
        quoteSpent: outcome.quoteSpent.toString(),
        memeBurned: outcome.memeBurned.toString(),
        quotePending: outcome.quotePending.toString(),
        piece: row.piecesToday + 1,
        nextPiece: next !== null,
        digest: row.latestDigest,
      });
      await alerts.clear(`buyback_min_out:${row.vaultId}`);
      return { outcome: "executed", executed: true };
    }
    if (outcome.kind === "failed") {
      if (isMinOutAbort(outcome.error, [context.deployment.packages.vault.packageId, context.deployment.packages.vault.originalPackageId])) return minOutAborted(context, row);
      await later(context, row, "execution-failed");
      return { outcome: "execution-failed" };
    }
    if (outcome.kind === "unreadable") return { outcome: "awaiting-effects" };
    // The node has no such transaction. Once the signer gate settled every open submission
    // (gas superseded or expired), it can never run: plan the vault again.
    if (context.canSign()) {
      await later(context, row, "submission-dropped");
      return { outcome: "submission-dropped" };
    }
    return { outcome: "awaiting-effects" };
  }

  async function skip(context: Context, row: BuybackRow, decision: Extract<BuybackDecision, { kind: "skip" }>): Promise<Visit> {
    if (decision.until === "tomorrow") await recordVisit(context.pool, row, { outcome: decision.reason, done: true, nextEligibleAt: null });
    else await later(context, row, decision.reason);
    return { outcome: decision.reason };
  }

  async function attempt(context: Context, row: BuybackRow): Promise<Visit> {
    const { client, provider, deployment, protocol, pool, leases } = context;
    const marketState = await reads.readMarket(client, deployment, row, provider);
    const held = marketState.vault.burnQuote;
    if (held === 0n) {
      await recordVisit(pool, row, { outcome: "nothing-held", done: true, nextEligibleAt: null });
      return { outcome: "nothing-held" };
    }
    const [quoteUsd, reference] = await Promise.all([
      reads.readQuoteUsd(row.venue, row.poolId, settings.usdPriceMaxAgeMs, settings.referenceMaxLagMs, market),
      reads.readReference(row.venue, row.poolId, settings.twapWindowMs, settings.referenceMaxLagMs, market),
    ]);
    const decision = decideBuyback(
      { heldQuote: held, poolQuote: marketState.poolQuote, spot: marketState.spot, reference, quoteUsd },
      settings,
      (low, high) => drawAmount(low, high, random),
    );
    if (decision.kind === "skip") return skip(context, row, decision);

    if (!context.canSign()) return { outcome: "signer-busy" };
    if (!(await context.gasAvailable())) {
      await later(context, row, "insufficient-gas");
      return { outcome: "insufficient-gas" };
    }
    const currency = await reads.readRegistryCurrency(client, row.memeType, provider);
    if (!currency) {
      await later(context, row, "currency-unavailable");
      return { outcome: "currency-unavailable" };
    }
    const cap = await reads.adminCapReference(client, settings.adminCapId, context.signer.address, provider);
    if (!cap) {
      await later(context, row, "admin-cap-not-owned");
      return { outcome: "admin-cap-not-owned" };
    }
    const calls = new MigratorCalls(migratorsDeployment(deployment));
    const transaction = new Transaction();
    const admin = new AdminCalls(adminDeployment(deployment));
    const adminWitness = transaction.add(admin.signIn({ adminCap: transaction.objectRef(cap), role: coreRoleType(coreDeployment(deployment), "BuybackAdmin") }));
    const common = {
      memeType: row.memeType,
      quoteType: row.quoteType,
      vault: { objectId: marketState.vault.objectId, initialSharedVersion: marketState.vault.initialSharedVersion, mutable: true as const },
      adminWitness,
      currency: { ...currency, mutable: true as const },
      pool: marketState.pool,
      quoteIn: decision.quoteIn,
      minMemeOut: decision.minMemeOut,
    };
    try {
      // The venue's objects come from the lineage-checked manifest only, and only while the venue is available.
      transaction.add(
        row.venue === "cetus"
          ? calls.buybackAndBurnCetus({
              ...common,
              ...resolveVenueObjects(protocol, "cetus").buyback,
            })
          : calls.buybackAndBurnBluefin({ ...common, ...resolveVenueObjects(protocol, "bluefin").buyback }),
      );
    } catch (error) {
      if (!(error instanceof VenueUnavailableError)) throw error;
      await later(context, row, "venue-unavailable");
      return { outcome: "venue-unavailable" };
    }
    const intent: BuybackIntent = {
      venue: row.venue,
      vaultId: normalizeSuiObjectId(row.vaultId),
      poolId: normalizeSuiObjectId(row.poolId),
      memeType: row.memeType,
      quoteType: row.quoteType,
      quoteIn: decision.quoteIn.toString(),
      heldQuote: held.toString(),
      minMemeOut: decision.minMemeOut.toString(),
    };
    const leaseKey = `${row.network}:${row.vaultId}`;
    let digest: string | null = null;
    const result = await context.submit({
      recordKeys: [row.vaultId],
      intent,
      transaction,
      beforeSubmit: async (submittedDigest) => {
        digest = submittedDigest;
        return (await leases.renew(BUYBACK_JOB, leaseKey)) && (await recordSubmitted(pool, row, submittedDigest));
      },
      reconcile: async () => null,
    });
    context.log(BUYBACK_METRICS.visit, {
      vaultId: row.vaultId,
      venue: row.venue,
      step: "submitted",
      outcome: result.outcome,
      digest: result.digest,
      quoteIn: decision.quoteIn.toString(),
      heldQuote: held.toString(),
      minPiece: decision.minPiece.toString(),
      maxPiece: decision.maxPiece.toString(),
      minMemeOut: decision.minMemeOut.toString(),
    });
    if (result.outcome === "not-submitted") return { outcome: result.reason ?? "not-submitted" };
    if (result.outcome === "simulation-failed") {
      if (isMinOutAbort(result.simulationError, [deployment.packages.vault.packageId, deployment.packages.vault.originalPackageId])) return minOutAborted(context, row);
      await later(context, row, "simulation-failed");
      return { outcome: "simulation-failed" };
    }
    if (result.outcome === "unknown" || !digest) return { outcome: "submission-unknown" };
    const submitted: BuybackRow = { ...row, state: "submitted", latestDigest: digest };
    return settleDigest(context, submitted, await reads.digestOutcome(client, digest, row.vaultId, deployment.packages.vault.originalPackageId, provider));
  }

  async function settle(context: Context, row: BuybackRow): Promise<Visit> {
    if (row.state === "submitted" && row.latestDigest) {
        const outcome = await reads.digestOutcome(context.client, row.latestDigest, row.vaultId, context.deployment.packages.vault.originalPackageId, context.provider);
      return settleDigest(context, row, outcome);
    }
    return attempt(context, row);
  }

  /** How a visit that threw ends: outages retry later, a signer refusal ends the day, anything else is ours. */
  async function failed(context: Context, row: BuybackRow, error: unknown): Promise<Visit> {
    if (isDatabaseUnavailableError(error)) return { outcome: "database-unavailable" };
    if (error instanceof SignerRefusal) {
      // Never retried today: a refusal means the bytes were not what this job builds.
      context.log(WORKER_METRICS.jobError, { job: BUYBACK_JOB, error: "signer-refused", reason: error.reason });
      await recordVisit(context.pool, row, { outcome: "signer-refused", done: true, nextEligibleAt: null });
      return { outcome: "signer-refused" };
    }
    const outcome = error instanceof ProviderUnavailable ? "provider-unavailable" : error instanceof BuybackReadError ? error.code : "internal-error";
    if (outcome === "internal-error") context.log(WORKER_METRICS.jobError, { job: BUYBACK_JOB, error: errorLabel(error) });
    if (row.state !== "submitted") await later(context, row, outcome);
    return { outcome };
  }

  async function visit(context: Context, row: BuybackRow): Promise<Visit | null> {
    const leaseKey = `${row.network}:${row.vaultId}`;
    if (!(await context.leases.acquire(BUYBACK_JOB, leaseKey))) return null;
    let result: Visit;
    try {
      result = await settle(context, row).catch((error: unknown) => failed(context, row, error));
    } finally {
      await context.leases.release(BUYBACK_JOB, leaseKey);
    }
    context.log(BUYBACK_METRICS.visit, { vaultId: row.vaultId, originId: row.originId, venue: row.venue, step: "visited", outcome: result.outcome });
    return result;
  }

  async function run(context: Context): Promise<JobPass> {
    const started = performance.now();
    if (!context.deployment.packages.migrators) return { blocked: ["no-migrators-package"] };
    const day = utcDay(now()).date;
    if ((context.protocol.paused.vault & VAULT_PAUSE_BITS.Admin) !== 0) return { blocked: ["vault-admin-paused"] };
    await discover(context);
    await plan(context, day);
    const due = await dueRows(context.pool, context.deployment.network, day, new Date(now()), context.config.batchSize * 4);
    let visited = 0;
    let executed = 0;
    for (const row of shuffled(due, random).slice(0, context.config.batchSize)) {
      const result = await visit(context, row);
      if (!result) continue;
      visited += 1;
      if (result.executed) executed += 1;
    }
    context.log(BUYBACK_METRICS.pass, { due: due.length, visited, executed, durationMs: Math.round(performance.now() - started) });
    return { blocked: null };
  }

  return Object.freeze({
    name: BUYBACK_JOB,
    run,
    sign: (signer: BuybackSigner, bytes: Uint8Array, intent: unknown, deployment: BuybackAccess["deployment"]) =>
      signer.signBuyback(bytes, intent, deployment),
  });
}
