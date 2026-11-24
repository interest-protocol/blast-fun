import { and, count as countRows, eq, gt, sql } from "drizzle-orm";
import type { Pool } from "pg";

import type { ExpectedDeployment } from "@blast/core/modules/launchpad-contract/provenance.ts";
import { errorLabel } from "@blast/core/lib/metrics.ts";
import { SOCIAL_DEFAULT_ACCOUNT_COUNT } from "@blast/core/modules/social/contracts/onboarding.ts";
import { assertChainReadThroughViews } from "@blast/core/modules/database/modules.ts";
import { autocommitRead, withTransaction, type ReadableDatabase, type TransactionContext } from "@blast/core/modules/database/transaction.ts";
import { workerDatabase, transactionDatabase } from "#workers/lib/database.ts";
import { socialDefaults, workerLeases as lease } from "#workers/lib/database/schema.ts";
import { leases as createLeases, type Leases } from "#workers/modules/worker-runtime/lease.ts";
import { pollUntilAborted } from "#workers/modules/worker-runtime/poll.ts";
import type { WorkerLog } from "#workers/modules/worker-runtime/log.ts";
import type { SocialAlerts } from "./alerts.ts";
import type { SocialWorkerConfig } from "./config.ts";
import {
  readStepCursor,
  SOCIAL_WORKER_COUNTS,
  writeStepCursor,
  type SocialWorkerBounds,
  type SocialWorkerCount,
  type SocialWorkerPipeline,
  type SocialWorkerStep,
} from "#workers/modules/social/worker/steps.ts";

/**
 * The social worker runtime (social-feed T-025): one active instance per
 * deployment through the operational worker's lease table, one pass every
 * `intervalMs`, each step bounded by its pipeline's watermark, per-pass
 * metrics and the four alerts.
 *
 * Lease: job `social-worker`, key `main`, TTL `leaseTtlMs` (30 s), renewed
 * at the start of every pass. A standby tries to acquire it every pass, so it
 * takes over within TTL + interval (35 s) of the holder stopping, inside the
 * 60 s promise. Every step transaction first locks the holder's own lease row
 * (`FOR SHARE`): a holder that lost its lease (paused past the TTL) cannot
 * commit, and a taker's acquire waits for any step transaction in flight, so
 * no two passes' writes overlap.
 *
 * Alerts (`alerts.ts`):
 * - `social_worker_stalled`: no successful pass for 5 minutes;
 * - `indexer_lagging`: the slowest pipeline's watermark more than 60 s behind for 5 minutes;
 * - `wallet_conflict:<address>`: an address two accounts' wallet sources claim, once per newly seen address;
 * - `defaults_incomplete`: fewer than `SOCIAL_DEFAULT_ACCOUNT_COUNT` default accounts (hourly while it holds);
 * - `step_late:<step>`: a step with a deadline of its own (`health`, the daily
 *   portfolio snapshot) is behind it, checked with the others once a minute.
 *
 * Metrics: one `social.worker.pass` line per pass (`outcome` ok, error or
 * standby; `durationMs`; `lagMs`; every `SOCIAL_WORKER_COUNTS` field),
 * `social.worker.step_error` with the step and an error label, and
 * `social.worker.standby` / `social.worker.lease_lost`. No line carries a
 * token, a why, a report reason or any free text from the database.
 */

export const SOCIAL_WORKER_JOB = "social-worker";
export const SOCIAL_WORKER_LEASE_KEY = "main";
export const STALLED_AFTER_MS = 5 * 60 * 1_000;
export const LAGGING_AFTER_MS = 60 * 1_000;
export const LAGGING_GRACE_MS = 5 * 60 * 1_000;
/** Successful checks wait this long before running again; failures retry next pass. */
export const CHECKS_EVERY_MS = 60 * 1_000;
export const MIN_DEFAULT_ACCOUNTS = SOCIAL_DEFAULT_ACCOUNT_COUNT;
const WALLET_CONFLICTS_STATE = "checks.wallet_conflicts";
const STEP_NAME = /^[a-z][a-z0-9-]{0,63}$/;

type WatermarkRow = {
  market_checkpoint: string | null;
  market_timestamp_ms: string | null;
  presale_checkpoint: string | null;
  presale_timestamp_ms: string | null;
  observed_ms: string;
  market_digest: string | null;
  presale_digest: string | null;
};

const WATERMARK_SQL = `SELECT market_checkpoint::text AS market_checkpoint, market_timestamp_ms::text AS market_timestamp_ms,
    presale_checkpoint::text AS presale_checkpoint, presale_timestamp_ms::text AS presale_timestamp_ms,
    observed_ms::text AS observed_ms, m.checkpoint_digest AS market_digest, p.checkpoint_digest AS presale_digest
  FROM chain_read_v1.watermark w
  LEFT JOIN chain_read_v1.projection_coverage m ON m.pipeline = 'market'
  LEFT JOIN chain_read_v1.projection_coverage p ON p.pipeline = 'presale'`;
assertChainReadThroughViews(WATERMARK_SQL);

/**
 * Addresses two accounts' wallet sources both claim: the sources behind
 * `social_wallet_owners` (which drops such an address), compared by account.
 */
const WALLET_CONFLICTS_SQL = `
  SELECT address FROM (
    SELECT w.sui_address AS address, a.account_id
    FROM mission_control_account_wallets w JOIN social_accounts a ON a.profile_id = w.profile_id
    UNION
    SELECT e.address, a.account_id FROM presale_embedded_wallets e JOIN social_accounts a ON a.privy_did = e.privy_did
    UNION
    SELECT e.address, a.account_id
    FROM presale_embedded_wallets e
    JOIN mission_control_account_identities i ON i.provider = 'privy' AND i.provider_subject = e.privy_did
    JOIN social_accounts a ON a.profile_id = i.profile_id
    UNION
    SELECT address, account_id FROM social_account_wallets
  ) AS claims
  GROUP BY address HAVING count(DISTINCT account_id) > 1
  ORDER BY address
  LIMIT 500`;

export type SocialPassReport = Readonly<{
  outcome: "ok" | "error" | "standby";
  lagMs: number | null;
  counts: Readonly<Record<SocialWorkerCount, number>>;
  /** Bounds each step ran with (tests check the watermark promise). */
  bounds: Readonly<Record<string, SocialWorkerBounds | null>>;
}>;

export type SocialWorker = Readonly<{
  holder: string;
  steps: readonly string[];
  runPass(): Promise<SocialPassReport>;
  /** Passes until `signal` aborts (the current pass finishes first), then releases the lease. */
  run(signal: AbortSignal): Promise<void>;
  release(): Promise<void>;
}>;

class LeaseLost extends Error {
  override name = "LeaseLost";
}

/** The wait after a pass: the interval, or after `failures` failed passes in a row, the interval doubled per extra failure up to the cap (5, 10, 20, 40, 60 s). */
export function backoffMs(config: Pick<SocialWorkerConfig, "intervalMs" | "maxBackoffMs">, failures: number): number {
  if (failures <= 1) return config.intervalMs;
  return Math.min(config.intervalMs * 2 ** Math.min(failures - 1, 16), config.maxBackoffMs);
}

const zeroCounts = () => Object.fromEntries(SOCIAL_WORKER_COUNTS.map((key) => [key, 0])) as Record<SocialWorkerCount, number>;

function boundsOf(row: WatermarkRow | undefined, pipeline: SocialWorkerPipeline, required: readonly SocialWorkerPipeline[] = [pipeline]): SocialWorkerBounds | null {
  const available = required.map((source) => ({
    checkpoint: row?.[`${source}_checkpoint`], timestamp: row?.[`${source}_timestamp_ms`], digest: row?.[`${source}_digest`],
  }));
  if (available.some((cut) => cut.checkpoint == null || cut.timestamp == null || !cut.digest)) return null;
  const earliest = available.toSorted((a, b) => Number(a.checkpoint) - Number(b.checkpoint) || Number(a.timestamp) - Number(b.timestamp))[0]!;
  return { pipeline, checkpoint: Number(earliest.checkpoint), timestampMs: Number(earliest.timestamp), checkpointDigest: earliest.digest! };
}

export function createSocialWorker({
  pool,
  steps,
  config,
  holder,
  log,
  alerts,
  now = Date.now,
  leases = createLeases(pool, holder, config.leaseTtlMs),
  selection = null,
}: Readonly<{
  pool: Pool;
  steps: readonly SocialWorkerStep[];
  config: Pick<SocialWorkerConfig, "intervalMs" | "maxBackoffMs" | "leaseTtlMs">;
  holder: string;
  log: WorkerLog;
  alerts: SocialAlerts;
  /** The process clock (alerts, checks, retention); simulated in tests. */
  now?: () => number;
  leases?: Leases;
  selection?: ExpectedDeployment | null;
}>): SocialWorker {
  const names = steps.map((step) => step.name);
  for (const [index, name] of names.entries()) {
    if (!STEP_NAME.test(name) || names.indexOf(name) !== index) throw new Error(`Social worker step names are unique, ^[a-z][a-z0-9-]*$: ${name}.`);
  }
  let holding = false;
  let lastSuccessMs = now();
  let lastChecksMs = Number.NEGATIVE_INFINITY;

  const db: ReadableDatabase = { read: (text, values) => autocommitRead(pool, "social", text, values) };

  /** Locks this holder's live lease row for the transaction, or throws `LeaseLost`. */
  async function fence(tx: TransactionContext): Promise<void> {
    const rows = await transactionDatabase(tx.forModule("worker-runtime")).select({ present: sql`1` }).from(lease).where(and(
      eq(lease.job, SOCIAL_WORKER_JOB), eq(lease.leaseKey, SOCIAL_WORKER_LEASE_KEY),
      eq(lease.holder, holder), gt(lease.expiresAt, sql`now()`),
    )).for("share");
    if (rows.length !== 1) throw new LeaseLost("The social worker lease was lost.");
  }

  async function holdLease(): Promise<boolean> {
    if (holding && (await leases.renew(SOCIAL_WORKER_JOB, SOCIAL_WORKER_LEASE_KEY))) return true;
    if (holding) log("social.worker.lease_lost", { holder });
    holding = await leases.acquire(SOCIAL_WORKER_JOB, SOCIAL_WORKER_LEASE_KEY);
    return holding;
  }

  /** Wallet-conflict, defaults and step health checks; only successes start the interval. */
  async function checks(): Promise<void> {
    if (now() - lastChecksMs < CHECKS_EVERY_MS) return;
    const [{ rows: conflicts }, defaults] = await Promise.all([
      db.read<{ address: string }>(WALLET_CONFLICTS_SQL),
      workerDatabase(pool, "social").select({ count: countRows() }).from(socialDefaults),
    ]);
    const current = conflicts.map((row) => row.address);
    const fresh = await withTransaction(pool, async (transaction) => {
      await fence(transaction);
      const social = transaction.forModule("social");
      const seen = new Set((await readStepCursor<{ addresses: string[] }>(social, WALLET_CONFLICTS_STATE))?.addresses ?? []);
      await writeStepCursor(social, WALLET_CONFLICTS_STATE, { addresses: current });
      return current.filter((address) => !seen.has(address));
    }, { label: "social.worker_checks" });
    for (const address of fresh) await alerts.raise(`wallet_conflict:${address}`, { address });
    const count = defaults[0]?.count ?? 0;
    if (count < MIN_DEFAULT_ACCOUNTS) await alerts.raise("defaults_incomplete", { count, required: MIN_DEFAULT_ACCOUNTS });
    else alerts.clear("defaults_incomplete");
    for (const step of steps) {
      if (!step.health) continue;
      const late = await step.health(db, now());
      if (late) await alerts.raise(`step_late:${step.name}`, late);
      else alerts.clear(`step_late:${step.name}`);
    }
    lastChecksMs = now();
  }

  async function runSteps(
    watermark: WatermarkRow | undefined,
    counts: Record<SocialWorkerCount, number>,
    bounds: Record<string, SocialWorkerBounds | null>,
  ): Promise<boolean> {
    let failed = false;
    for (const step of steps) {
      const stepBounds = step.pipeline === null ? null : boundsOf(watermark, step.pipeline, step.requiredPipelines);
      bounds[step.name] = stepBounds;
      if (step.pipeline !== null && stepBounds === null) continue;
      try {
        const requireCut = async (transaction: TransactionContext) => {
          if (stepBounds === null) return;
          if (selection === null || !stepBounds.checkpointDigest) throw new Error("Social shared evidence deployment is not selected.");
          await transaction.read("SELECT chain_read_v1.require_cut($1, $2, $3, $4, $5::text[])", [
            selection.network, selection.deployment, stepBounds.checkpoint, stepBounds.checkpointDigest, step.requiredPipelines ?? [stepBounds.pipeline],
          ]);
        };
        const prepared = step.prepare ? await step.prepare(async (read) => withTransaction(pool, async (transaction) => {
          await fence(transaction);
          await requireCut(transaction);
          return read(transaction.forModule("social"));
        }, { label: `social.worker.${step.name}.prepare`, isolationLevel: "REPEATABLE READ" }), stepBounds, { now }) : null;
        const report = await withTransaction(pool, async (transaction) => {
          await fence(transaction);
          await requireCut(transaction);
          return prepared ? prepared(transaction.forModule("social")) : step.run(transaction.forModule("social"), stepBounds, { now });
        }, { label: `social.worker.${step.name}`, isolationLevel: "REPEATABLE READ", retry: true });
        for (const key of SOCIAL_WORKER_COUNTS) counts[key] += report[key] ?? 0;
      } catch (error) {
        failed = true;
        log("social.worker.step_error", { step: step.name, error: errorLabel(error) });
        if (error instanceof LeaseLost) {
          holding = false;
          break;
        }
      }
    }
    return failed;
  }

  async function updateHealth(outcome: SocialPassReport["outcome"], lagMs: number | null): Promise<void> {
    if (outcome !== "error") lastSuccessMs = now();
    if (outcome !== "standby") {
      if (now() - lastSuccessMs >= STALLED_AFTER_MS) {
        await alerts.raise("social_worker_stalled", { since_ms: lastSuccessMs });
      } else {
        alerts.clear("social_worker_stalled");
      }
      if (lagMs !== null && lagMs > LAGGING_AFTER_MS) await alerts.raise("indexer_lagging", { lag_ms: lagMs }, { graceMs: LAGGING_GRACE_MS });
      else if (lagMs !== null) alerts.clear("indexer_lagging");
    }
  }

  async function runPass(): Promise<SocialPassReport> {
    const started = now();
    const startedAt = performance.now();
    const counts = zeroCounts();
    const bounds: Record<string, SocialWorkerBounds | null> = {};
    let lagMs: number | null = null;
    let outcome: SocialPassReport["outcome"] = "ok";
    try {
      if (!(await holdLease())) {
        log("social.worker.standby", { holder });
        outcome = "standby";
      } else {
        const { rows } = await db.read<WatermarkRow>(WATERMARK_SQL);
        const watermark = rows[0];
        if (watermark) {
          const times = [watermark.market_timestamp_ms, watermark.presale_timestamp_ms].filter((value) => value !== null).map(Number);
          lagMs = times.length === 2 ? Math.max(0, Number(watermark.observed_ms) - Math.min(...times)) : null;
        }
        let failed = await runSteps(watermark, counts, bounds);
        if (holding) {
          try {
            await checks();
          } catch (error) {
            failed = true;
            log("social.worker.step_error", { step: "checks", error: errorLabel(error) });
          }
        }
        outcome = failed ? "error" : "ok";
      }
    } catch (error) {
      outcome = "error";
      log("social.worker.step_error", { step: "pass", error: errorLabel(error) });
    }
    await updateHealth(outcome, lagMs);
    log("social.worker.pass", {
      outcome,
      holder,
      durationMs: Math.round(performance.now() - startedAt),
      lagMs,
      ...counts,
      startedAtMs: started,
    });
    return { outcome, lagMs, counts, bounds };
  }

  async function release(): Promise<void> {
    if (!holding) return;
    holding = false;
    await leases.release(SOCIAL_WORKER_JOB, SOCIAL_WORKER_LEASE_KEY);
  }

  return Object.freeze({
    holder,
    steps: names,
    runPass,
    async run(signal: AbortSignal) {
      let failures = 0;
      try {
        await pollUntilAborted(signal, async () => {
          const report = await runPass();
          failures = report.outcome === "error" ? failures + 1 : 0;
          return backoffMs(config, failures);
        });
      } finally {
        await release().catch((error: unknown) => log("social.worker.step_error", { step: "release", error: errorLabel(error) }));
      }
    },
    release,
  });
}
