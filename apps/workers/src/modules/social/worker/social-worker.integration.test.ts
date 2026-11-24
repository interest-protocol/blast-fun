import { withSocialCoverage, seedSocialCheckpoint } from "../../../../test/fixtures/modules/social/worker/shared-evidence-fixture.ts";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import type { Pool } from "pg";

import { createPool, createRuntimePool } from "@blast/core/modules/database/pool.ts";
import { FIXTURE_NETWORK, FIXTURE_FINGERPRINT, FIXTURE_CHECKPOINT, advanceWatermark, urlAs } from "../../../../../../packages/core/test/fixtures/modules/database/role-fixtures.ts";
import { freshTestDatabase } from "../../../../../../packages/core/test/fixtures/modules/database/template.ts";
import { parseReferralAccountingProfile, referralRevenueStep } from "#workers/modules/social/referrals/collect.ts";
import { createSocialAlerts } from "./alerts.ts";
import { runSocialWorker } from "./main.ts";
import { createSocialWorker, LAGGING_GRACE_MS, STALLED_AFTER_MS, type SocialWorker } from "./runtime.ts";
import { readStepCursor, writeStepCursor, type SocialWorkerBounds, type SocialWorkerStep } from "#workers/modules/social/worker/steps.ts";
import { uuid } from "../../../../../../packages/core/test/kit.ts";

/**
 * Social-feed T-025 on a disposable database as `blast_watcher`: the flag,
 * the lease and its takeover, watermark-bounded cursors that survive a
 * restart, the four alerts on a simulated clock, and the per-pass metric.
 */

const databaseUrl = process.env.MISSION_CONTROL_TEST_DATABASE_URL;
const skip = databaseUrl ? false : "MISSION_CONTROL_TEST_DATABASE_URL is not set";
const POOL = { connectionTimeoutMs: 2_000, idleInTransactionMs: 5_000, idleTimeoutMs: 1_000, lockTimeoutMs: 2_000, max: 2, statementTimeoutMs: 5_000 };
const wallet = (n: number) => `0x${n.toString(16).padStart(64, "0")}`;

type Line = Record<string, unknown> & { metric: string };

/** A lease holder is a UUID; tests name theirs. */
function holderId(label: string): string {
  const hex = createHash("sha256").update(label).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/** A step that records its bounds and walks a checkpoint cursor up to them. */
function probeStep(seen: SocialWorkerBounds[]): SocialWorkerStep {
  return {
    name: "probe",
    pipeline: "presale",
    async run(tx, bounds) {
      seen.push(bounds!);
      const cursor = (await readStepCursor<{ c: number }>(tx, "probe"))?.c ?? 0;
      await writeStepCursor(tx, "probe", { c: Math.max(cursor, bounds!.checkpoint), previous: cursor });
      return { milestones_written: 1 };
    },
  };
}

async function withDatabase(run: (admin: Pool, watcher: Pool) => Promise<void>): Promise<void> {
  const database = await freshTestDatabase();
  const admin = createPool(database.url, { max: 4 });
  const watcher = createRuntimePool(urlAs(database.url, "blast_watcher"), POOL, "social-worker-test");
  try {
    await run(admin, watcher);
  } finally {
    await watcher.end();
    await admin.end();
    await database.drop();
  }
}

function workerOn(admin: Pool, pool: Pool, holder: string, lines: Line[], steps: SocialWorkerStep[], options: { now?: () => number; ttlMs?: number; webhook?: typeof fetch } = {}): SocialWorker {
  const log = (metric: string, fields: Record<string, unknown> = {}) => void lines.push({ metric, ...fields, holder });
  return withSocialCoverage(createSocialWorker({
        selection: { network: FIXTURE_NETWORK, deployment: FIXTURE_FINGERPRINT },
    pool,
    steps,
    // The production default: a pass slowed by a busy host must not outlive its lease.
    config: { intervalMs: 50, maxBackoffMs: 400, leaseTtlMs: options.ttlMs ?? 30_000 },
    holder: holderId(holder),
    log,
    now: options.now,
    alerts: createSocialAlerts({
      webhookUrl: options.webhook ? "https://alerts.example/hook" : null,
      log,
      now: options.now,
      fetcher: options.webhook,
    }),
  }), admin);
}

test("T-025-AC-1 (AC-123): with the flag off the worker exits without connecting", async () => {
  // No WATCHER_DATABASE_URL: opening a pool would throw.
  assert.equal(await runSocialWorker({ BLAST_SOCIAL_ENABLED: "false" }, new AbortController().signal), "disabled");
  assert.equal(await runSocialWorker({}, new AbortController().signal), "disabled");
  await assert.rejects(runSocialWorker({ BLAST_SOCIAL_ENABLED: "true" }, new AbortController().signal), /WATCHER_DATABASE_URL/);
});

test("T-025-AC-2 (AC-167): one active instance; a standby takes over after the holder dies, and passes never overlap", { skip }, () =>
  withDatabase(async (admin, watcher) => {
    await admin.query(advanceWatermark(500, 0, "presale"));
    const lines: Line[] = [];
    const seen: SocialWorkerBounds[] = [];
    const one = workerOn(admin, watcher, "instance-1", lines, [probeStep(seen)], { ttlMs: 5_000 });
    const two = workerOn(admin, watcher, "instance-2", lines, [probeStep(seen)], { ttlMs: 5_000 });
    assert.equal((await one.runPass()).outcome, "ok");
    assert.equal((await two.runPass()).outcome, "standby");
    assert.equal((await one.runPass()).outcome, "ok");
    assert.equal((await two.runPass()).outcome, "standby");
    // Instance 1 dies without releasing: instance 2 keeps trying every pass and takes over once the lease expires.
    const killedAt = Date.now();
    let takeover: number | null = null;
    while (Date.now() - killedAt < 60_000) {
      if ((await two.runPass()).outcome === "ok") {
        takeover = Date.now() - killedAt;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.ok(takeover !== null && takeover < 60_000, `took over after ${takeover} ms`);
    // The dead holder cannot write again: its renew fails and its pass is a standby's.
    assert.equal((await one.runPass()).outcome, "standby");
    assert.ok(lines.some((line) => line.metric === "social.worker.lease_lost" && line.holder === "instance-1"));
    // A holder paused past its lease mid-pass cannot commit: the next step transaction's fence refuses it.
    const thief: SocialWorkerStep = {
      name: "thief",
      pipeline: null,
      async run() {
        // Sleeps past the lease whatever the load: the clock runs from before this step's fence.
        await new Promise((resolve) => setTimeout(resolve, 3_200));
        return {};
      },
    };
    await two.release();
    const robbed = workerOn(admin, watcher, "instance-3", lines, [thief, probeStep(seen)], { ttlMs: 3_000 });
    const before = seen.length;
    const robbedPass = await robbed.runPass();
    assert.equal(robbedPass.outcome, "error");
    assert.equal(seen.length, before, "the step after the theft never ran");
    assert.ok(lines.some((line) => line.metric === "social.worker.step_error" && line.step === "probe" && line.error === "LeaseLost"));
    await admin.query("DELETE FROM mission_control_worker_leases WHERE job = 'social-worker'");
    // After a release a standby takes over at once.
    assert.equal((await one.runPass()).outcome, "ok");
    await one.release();
  }));

test("T-025-AC-3 (AC-168): steps never get bounds past their pipeline's watermark, and resume from their cursor", { skip }, () =>
  withDatabase(async (admin, watcher) => {
    const lines: Line[] = [];
    const seen: SocialWorkerBounds[] = [];
    await admin.query(advanceWatermark(700, 0, "presale"));
    await admin.query(advanceWatermark(900, 0, "market"));
    const first = workerOn(admin, watcher, "bounds-1", lines, [probeStep(seen)]);

    await first.runPass();
    await admin.query(advanceWatermark(750, 0, "presale"));

    await first.runPass();
    assert.deepEqual(seen.map((bounds) => [bounds.pipeline, bounds.checkpoint]), [["presale", 700], ["presale", 750]]);
    await first.release();
    // A restart resumes from the stored cursor.
    await admin.query(advanceWatermark(760, 0, "presale"));
    const second = workerOn(admin, watcher, "bounds-2", lines, [probeStep(seen)]);

    await second.runPass();
    const state = (await admin.query<{ value: { c: number; previous: number } }>("SELECT value FROM social_worker_state WHERE name = 'probe'")).rows[0]!.value;
    assert.deepEqual(state, { c: 760, previous: 750 });
    assert.ok(seen.every((bounds) => bounds.checkpoint <= 760));
    // A pipeline without a watermark row: the step does not run at all.
    await admin.query("DELETE FROM watermarks WHERE pipeline = 'presale'");
    const before = seen.length;

    assert.equal((await second.runPass()).bounds.probe, null);
    assert.equal(seen.length, before);
    await second.release();
  }));

test("T-025-AC-4 (AC-129, AC-017, AC-032): lagging, stalled, wallet conflict and defaults alerts", { skip }, () =>
  withDatabase(async (admin, watcher) => {
    let clock = Date.now();
    const now = () => clock;
    const posted: Array<Record<string, unknown>> = [];
    const webhook: typeof fetch = async (_url, init) => {
      posted.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(null, { status: 200 });
    };
    const lines: Line[] = [];
    // The watermark frozen 61 s behind.
    await admin.query(advanceWatermark(800, 61_000, "presale"));
    await admin.query(advanceWatermark(800, 61_000, "market"));
    // Four default accounts and an address two accounts claim.
    for (let n = 1; n <= 5; n += 1) {
      await admin.query("INSERT INTO social_accounts (account_id, privy_did, callsign) VALUES ($1, $2, $3)", [uuid(n), `did:privy:alerts-${n}`, `alerts_${n}`]);
    }
    for (let n = 1; n <= 4; n += 1) await admin.query("INSERT INTO social_default_accounts (position, account_id) VALUES ($1, $2)", [n, uuid(n)]);
    await admin.query("INSERT INTO social_account_wallets (address, account_id, kind, verified_at) VALUES ($1, $2, 'external', now())", [wallet(0xbad), uuid(1)]);
    await admin.query(
      `INSERT INTO presale_embedded_wallets (privy_did, address, resolved_at) VALUES ('did:privy:alerts-2', $1, now())`,
      [wallet(0xbad)],
    );
    const worker = workerOn(admin, watcher, "alerts-1", lines, [], { now, webhook });

    await worker.runPass();
    const sent = () => posted.map((body) => body.alert);
    assert.deepEqual(sent().sort(), ["defaults_incomplete", `wallet_conflict:${wallet(0xbad)}`]);
    // Lagging only after five minutes of lag.
    clock += LAGGING_GRACE_MS - 1_000;
    await admin.query(advanceWatermark(800, 61_000, "presale"));

    await worker.runPass();
    assert.ok(!sent().includes("indexer_lagging"));
    clock += 2_000;

    await worker.runPass();
    assert.ok(sent().includes("indexer_lagging"));
    // The conflict is raised once (not again on the next check), defaults hourly while they hold.
    clock += 61_000;

    await worker.runPass();
    assert.equal(sent().filter((key) => key === `wallet_conflict:${wallet(0xbad)}`).length, 1);
    assert.equal(sent().filter((key) => key === "defaults_incomplete").length, 1);
    // Five defaults clear it.
    await admin.query("INSERT INTO social_default_accounts (position, account_id) VALUES (5, $1)", [uuid(5)]);
    clock += 61_000;

    await worker.runPass();
    assert.ok(lines.some((line) => line.metric === "social.alert" && line.key === "defaults_incomplete" && line.outcome === "cleared"));
    await worker.release();

    // Stalled: passes failing (the database unreachable) for five minutes.
    const broken = createRuntimePool("postgresql://blast_watcher:x@127.0.0.1:9/none", POOL, "social-worker-broken");
    try {
      const failing = workerOn(admin, broken, "stalled-1", lines, [], { now, webhook });
      assert.equal((await failing.runPass()).outcome, "error");
      clock += STALLED_AFTER_MS - 1_000;
      await failing.runPass();
      assert.ok(!sent().includes("social_worker_stalled"));
      clock += 2_000;
      await failing.runPass();
      assert.ok(sent().includes("social_worker_stalled"));
    } finally {
      await broken.end();
    }
  }));

test("failed health checks retry before the minute interval and raise stalled alerts until recovery", { skip }, () =>
  withDatabase(async (admin, watcher) => {
    let clock = Date.now();
    let failing = true;
    let checks = 0;
    const lines: Line[] = [];
    const step: SocialWorkerStep = {
      name: "health-probe",
      pipeline: null,
      run: async () => ({}),
      health: async () => {
        checks += 1;
        if (failing) throw new Error("health unavailable");
        return null;
      },
    };
    const worker = workerOn(admin, watcher, "health-failure", lines, [step], { now: () => clock });
    try {

      assert.equal((await worker.runPass()).outcome, "error");
      clock += 1_000;

      assert.equal((await worker.runPass()).outcome, "error");
      assert.equal(checks, 2, "failed checks are retried without waiting a minute");
      clock += STALLED_AFTER_MS;

      assert.equal((await worker.runPass()).outcome, "error");
      assert.ok(lines.some((line) => line.metric === "social.alert" && line.key === "social_worker_stalled"));
      failing = false;

      assert.equal((await worker.runPass()).outcome, "ok");
      assert.ok(lines.some((line) => line.metric === "social.alert" && line.key === "social_worker_stalled" && line.outcome === "cleared"));
      const recoveredChecks = checks;

      assert.equal((await worker.runPass()).outcome, "ok");
      assert.equal(checks, recoveredChecks, "successful checks retain their interval");
    } finally {
      await worker.release();
    }
  }));

test("T-025-AC-5 (AC-128, AC-130): one metric line per pass with every field; no secret or free text", { skip }, () =>
  withDatabase(async (admin, watcher) => {
    await admin.query(advanceWatermark(800, 0, "presale"));
    const lines: Line[] = [];
    const worker = workerOn(admin, watcher, "metrics-1", lines, [probeStep([])]);

    await worker.runPass();

    await worker.runPass();
    const passes = lines.filter((line) => line.metric === "social.worker.pass");
    assert.equal(passes.length, 2);
    for (const line of passes) {
      for (const field of ["outcome", "durationMs", "lagMs", "intents_resolved", "intents_rejected", "intents_late", "milestones_written", "notifications_written", "notifications_deleted"]) {
        assert.ok(field in line, field);
      }
      assert.equal(line.milestones_written, 1);
    }
    const text = JSON.stringify(lines);
    assert.doesNotMatch(text, /Bearer|eyJ|postgresql:\/\//);
    await worker.release();
  }));


test("shared social: selected deployment and complete native coverage gate outputs and cursor atomically", { skip }, () =>
  withDatabase(async (admin, watcher) => {
    const seen: SocialWorkerBounds[] = [];
    let index = 0;
    const pass = async (selection: { network: typeof FIXTURE_NETWORK; deployment: string } | null) => {
      const log = () => undefined;
      const worker = createSocialWorker({ pool: watcher, selection, steps: [probeStep(seen)],
        config: { intervalMs: 50, maxBackoffMs: 400, leaseTtlMs: 5_000 }, holder: holderId(`coverage-${index++}`), log,
        alerts: createSocialAlerts({ webhookUrl: null, log }) });
      try { return await worker.runPass(); } finally { await worker.release(); }
    };
    const selected: { network: typeof FIXTURE_NETWORK; deployment: string } = { network: FIXTURE_NETWORK, deployment: FIXTURE_FINGERPRINT };
    for (const identity of [null, { ...selected, deployment: "f".repeat(64) }]) {
      assert.equal((await pass(identity)).outcome, "error");
    }
    await admin.query("UPDATE deployment_identity SET network='testnet'");
    assert.equal((await pass(selected)).outcome, "error");
    await admin.query("UPDATE deployment_identity SET network='mainnet'");
    await admin.query("INSERT INTO projection_faults(pipeline,checkpoint,event_type,reason) VALUES('presale',$1,'fixture::unknown','undecodable')", [FIXTURE_CHECKPOINT]);
    assert.equal((await pass(selected)).outcome, "error");
    await admin.query("DELETE FROM projection_faults WHERE pipeline='presale'");
    await admin.query("UPDATE watermarks SET checkpoint_hi_inclusive=0 WHERE pipeline='intake'");
    assert.equal((await pass(selected)).outcome, "error");
    await admin.query("UPDATE watermarks SET checkpoint_hi_inclusive=$1 WHERE pipeline='intake'", [FIXTURE_CHECKPOINT]);
    await admin.query("DELETE FROM checkpoint_journal WHERE checkpoint=$1", [FIXTURE_CHECKPOINT]);
    assert.equal((await pass(selected)).outcome, "ok", "unavailable native header waits without invoking the step");
    assert.equal(seen.length, 0);
    assert.equal((await admin.query("SELECT count(*)::int AS n FROM social_worker_state WHERE name='probe'")).rows[0]?.n, 0);
    await seedSocialCheckpoint(admin, FIXTURE_CHECKPOINT, Date.now());
    assert.equal((await pass(selected)).outcome, "ok");
    assert.equal(seen.length, 1);
    assert.equal(seen[0]?.checkpoint, FIXTURE_CHECKPOINT);
  }));


test("referral accounting supports a presale-only deployment and pins its package profile", { skip }, () =>
  withDatabase(async (admin, watcher) => {
    const timestampMs = Date.now();
    await seedSocialCheckpoint(admin, 200, timestampMs);
    await admin.query("DELETE FROM watermarks WHERE pipeline='market'");
    await admin.query("UPDATE watermarks SET checkpoint_hi_inclusive=200,timestamp_ms_hi_inclusive=$1,reader_lo=100 WHERE pipeline IN ('intake','presale')", [timestampMs]);
    const profile = parseReferralAccountingProfile({ network: "mainnet", deployment_fingerprint: FIXTURE_FINGERPRINT,
      presale_original_package: wallet(100), launchpad_original_package: wallet(101), core_original_package: wallet(102), first_checkpoint: "100" });
    let index = 0;
    async function pass(selected: typeof profile) {
      const log = () => undefined;
      const worker = createSocialWorker({ pool: watcher,
        selection: { network: FIXTURE_NETWORK, deployment: FIXTURE_FINGERPRINT },
        steps: [referralRevenueStep(selected)], config: { intervalMs: 50, maxBackoffMs: 400, leaseTtlMs: 5_000 },
        holder: holderId(`referral-profile-${index++}`), log, alerts: createSocialAlerts({ webhookUrl: null, log }) });
      try { return await worker.runPass(); } finally { await worker.release(); }
    }
    const cursor = async () => (await admin.query("SELECT value AS cursor FROM social_worker_state WHERE name='referral-accounting'")).rows[0]?.cursor;
    assert.equal((await pass(profile)).outcome, "ok");
    assert.equal(await cursor(), undefined, "a configured launchpad waits for market coverage");
    assert.equal((await pass({ ...profile, launchpad_original_package: null })).outcome, "ok");
    assert.equal((await cursor()).complete_checkpoint, "200", "presale-only profile publishes the complete native cut");
    await admin.query("INSERT INTO watermarks SELECT 'market',epoch_hi_inclusive,checkpoint_hi_inclusive,tx_hi,timestamp_ms_hi_inclusive,reader_lo,pruner_timestamp,pruner_hi,chain_id FROM watermarks WHERE pipeline='presale'");
    assert.equal((await pass(profile)).outcome, "error", "adding a launchpad requires an explicit accounting rebuild");
    assert.equal((await cursor()).profile.launchpad_original_package, null);
  }));
