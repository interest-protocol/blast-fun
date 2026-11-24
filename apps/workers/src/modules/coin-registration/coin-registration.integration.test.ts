import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { type TestContext } from "node:test";

import { Transaction } from "@mysten/sui/transactions";
import type { Pool } from "pg";

const FOREIGN_CHAIN_IDENTIFIER = "4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi";
import { resetDatabase } from "@blast/core/modules/database/migrations.ts";
import { workerConfigFromEnvironment } from "../worker-runtime/config.ts";
import { evaluateWorkerAccess } from "../worker-runtime/deployment.ts";
import { createWorker, type FundingAlert, type OperationalWorker } from "../worker-runtime/runtime.ts";
import { loadKeeperSigner } from "../blast-keeper/signer.ts";
import { createFixtureNode, FIXTURE_GAS_COST, type FixtureNode } from "../../../test/fixtures/modules/coin-registration/fixture-node.ts";
import { sharedCurrencyId } from "../blast-keeper/chain.ts";
import { registrationJob } from "./job.ts";
import {
  adminPool,
  DEPLOYMENT,
  elapseBackoff,
  FIXTURE_GAS_KEY,
  FOREIGN_LAUNCHPAD,
  freshDatabase,
  indexCoin,
  CORE,
  LAUNCHPAD,
  MANIFEST,
  manifestFile,
  registrations,
  watcherPool,
  workerEnvironment,
} from "../../../test/fixtures/modules/coin-registration/testing.ts";

const databaseUrl = process.env.MISSION_CONTROL_TEST_DATABASE_URL;
const skip = databaseUrl ? false : "MISSION_CONTROL_TEST_DATABASE_URL is not set";
const FUNDED = 10_000_000_000n;

type Harness = {
  /** Superuser URL of the test's own database. */
  url: string;
  admin: Pool;
  pool: Pool;
  node: FixtureNode;
  manifest: string;
  /**
   * One worker process. By default each pass is a whole process life: it ends
   * with a clean stop that releases the signer lease, so the next `worker()`
   * (a restart) is active at once. `process` returns a long-lived process.
   */
  worker(overrides?: Record<string, string | undefined>, options?: WorkerOptions): Pick<OperationalWorker, "runPass">;
  process(overrides?: Record<string, string | undefined>, options?: WorkerOptions): OperationalWorker;
};

type WorkerOptions = { onFundingAlert?: (alert: FundingAlert) => void; node?: FixtureNode };

async function harness(t: TestContext, checkpoint = 1_000): Promise<Harness> {
  const database = await freshDatabase(checkpoint);
  const { url } = database;
  const admin = adminPool(url);
  const pool = watcherPool(url);
  const started: OperationalWorker[] = [];
  // Long-lived processes stop cleanly (releasing the signer lease) before the pools end and the clone drops.
  t.after(async () => {
    await Promise.all(started.map((worker) => worker.release()));
    await Promise.all([admin.end(), pool.end()]);
    await database.drop();
  });
  const node = createFixtureNode(MANIFEST);
  node.fundAddressBalance(FIXTURE_GAS_KEY.toSuiAddress(), FUNDED);
  const manifest = await manifestFile();
  const process = (overrides: Record<string, string | undefined> = {}, options: WorkerOptions = {}) => {
    const environment = workerEnvironment(url, manifest, overrides);
    const config = workerConfigFromEnvironment(environment);
    const worker = createWorker({
      config,
      pool,
      client: (options.node ?? node).client,
      signer: loadKeeperSigner(environment, { gasBudgetMist: config.gasBudgetMist, creationFeeCapMist: 0n }),
      jobs: [registrationJob()],
      holder: randomUUID(),
      onFundingAlert: options.onFundingAlert,
      access: () => evaluateWorkerAccess(config, (options.node ?? node).client),
    });
    started.push(worker);
    return worker;
  };
  return {
    url,
    admin,
    pool,
    node,
    manifest,
    process,
    worker(overrides = {}, options = {}) {
      const worker = process(overrides, options);
      return {
        async runPass() {
          try {
            return await worker.runPass();
          } finally {
            await worker.release();
          }
        },
      };
    },
  };
}

/** Every transaction the key sent paid gas from its address balance: no gas coin, a one-epoch `ValidDuring` on the node's chain. */
async function assertAddressBalanceGas(admin: Pool, node: FixtureNode): Promise<void> {
  const { rows } = await admin.query<{ transaction_bytes: Buffer; expires_epoch: string }>(
    "SELECT transaction_bytes, expires_epoch FROM mission_control_worker_submissions",
  );
  assert.ok(rows.length > 0);
  for (const row of rows) {
    const data = Transaction.from(new Uint8Array(row.transaction_bytes)).getData();
    assert.deepEqual(data.gasData.payment, []);
    assert.equal(data.expiration?.$kind, "ValidDuring");
    assert.equal(String(data.expiration?.ValidDuring?.minEpoch), row.expires_epoch);
    assert.equal(String(data.expiration?.ValidDuring?.maxEpoch), row.expires_epoch);
    assert.equal(data.expiration?.ValidDuring?.chain, node.behavior.chainIdentifier);
  }
}

async function submissions(admin: Pool) {
  const { rows } = await admin.query<{ digest: string; record_key: string; resolution: string | null }>(
    "SELECT digest, record_keys[1] AS record_key, resolution FROM mission_control_worker_submissions ORDER BY submitted_at",
  );
  return rows;
}

async function jobRow(admin: Pool, network: string) {
  const { rows } = await admin.query<{ blocked_reasons: string[] | null; cursor: unknown }>(
    "SELECT blocked_reasons, cursor FROM mission_control_worker_jobs WHERE job = 'coin-registration' AND network = $1",
    [network],
  );
  return rows[0] ?? null;
}

test("a configured-lineage publication is shared by one finalize_registration; an already-registered one closes without submitting", { skip }, async (t) => {
  const { admin, node, worker } = await harness(t);
  const pending = node.publish({ launchpad: LAUNCHPAD, core: CORE, symbol: "PEND" });
  const raced = node.publish({ launchpad: LAUNCHPAD, core: CORE, symbol: "DONE" });
  node.registerExternally(raced.memeType);
  const launched = node.publish({ launchpad: LAUNCHPAD, core: CORE, symbol: "LIVE" });
  await indexCoin(admin, pending.memeType, 10);
  await indexCoin(admin, raced.memeType, 11);
  // A coin whose launch exists has a registered currency and is not a candidate.
  await indexCoin(admin, launched.memeType, 12, "blast_curve:0xlaunch");
  // Above the committed watermark: not yet a candidate.
  const later = node.publish({ launchpad: LAUNCHPAD, core: CORE, symbol: "LATE" });
  await indexCoin(admin, later.memeType, 2_000);

  const report = await worker().runPass();
  assert.deepEqual(report.access, { status: "enabled" });

  const rows = await registrations(admin);
  assert.deepEqual([...rows.keys()], [pending.memeType, raced.memeType]);
  const registered = rows.get(pending.memeType)!;
  assert.equal(registered.state, "registered");
  assert.equal(registered.outcome, "registered-by-worker");
  assert.equal(registered.attempts, 1);
  assert.equal(registered.error_class, null);
  assert.match(registered.latest_digest ?? "", /^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
  assert.equal(registered.pending_currency_id, pending.pendingCurrency.objectId);
  assert.equal(registered.publication_digest, pending.digest);
  assert.equal(registered.ticket_id, pending.ticketId);
  assert.equal(registered.shared_currency_id, node.sharedCurrency(pending.memeType));
  assert.ok(node.sharedCurrency(pending.memeType), "the shared currency is at its derived address");
  assert.equal(node.pendingCurrency(pending.memeType), null);

  const closed = rows.get(raced.memeType)!;
  assert.equal(closed.state, "registered");
  assert.equal(closed.outcome, "already-registered");
  assert.equal(closed.attempts, 0);
  assert.equal(closed.latest_digest, null);

  assert.equal(node.calls.execute, 1, "one submission in total");
  assert.equal(node.calls.registrations[pending.memeType], 1);
  assert.deepEqual((await jobRow(admin, DEPLOYMENT.network))?.cursor, { checkpoint: "11", coinType: raced.memeType });

  // The watermark reaches the later coin; nothing registered is visited again.
  await admin.query("UPDATE watermarks SET checkpoint_hi_inclusive = 3000 WHERE pipeline = 'market'");
  await worker().runPass();
  const after = await registrations(admin);
  assert.equal(after.get(later.memeType)?.state, "registered");
  assert.equal(node.calls.execute, 2);
  assert.equal(node.calls.registrations[pending.memeType], 1);
});

test("foreign-lineage publications are recorded with their error class and never signed", { skip }, async (t) => {
  const { admin, node, worker } = await harness(t);
  const foreign = node.publish({ launchpad: FOREIGN_LAUNCHPAD, core: CORE, symbol: "ALIEN" });
  await indexCoin(admin, foreign.memeType, 10);

  await worker().runPass();
  const row = (await registrations(admin)).get(foreign.memeType)!;
  assert.equal(row.state, "rejected");
  assert.equal(row.error_class, "foreign-lineage");
  assert.equal(row.attempts, 0);
  assert.equal(node.calls.simulate, 0);
  assert.equal(node.calls.execute, 0);
  assert.ok(node.pendingCurrency(foreign.memeType), "its currency stays pending");

  await elapseBackoff(admin);
  await worker().runPass();
  assert.equal(node.calls.simulate, 0, "a rejected record is final");
});

test("an index that serves another network or deployment is refused with its error class; nothing is ingested or signed", { skip }, async (t) => {
  const { url, admin, node, worker } = await harness(t);
  const coin = node.publish({ launchpad: LAUNCHPAD, core: CORE });
  await indexCoin(admin, coin.memeType, 10);

  await admin.query("UPDATE deployment_identity SET network = 'testnet'");
  await worker().runPass();
  assert.equal((await registrations(admin)).size, 0);
  assert.deepEqual((await jobRow(admin, DEPLOYMENT.network))?.blocked_reasons, ["wrong-network"]);

  await admin.query("UPDATE deployment_identity SET network = $1, deployment_fingerprint = $2", [DEPLOYMENT.network, "b".repeat(64)]);
  await worker().runPass();
  assert.equal((await registrations(admin)).size, 0);
  assert.deepEqual((await jobRow(admin, DEPLOYMENT.network))?.blocked_reasons, ["deployment-mismatch"]);
  assert.equal(node.calls.simulate + node.calls.execute, 0);

  // Once the index serves this deployment again the block clears and the coin registers.
  await admin.query("UPDATE deployment_identity SET deployment_fingerprint = $1", [workerEnvironment(url, "").BLAST_DEPLOYMENT_FINGERPRINT]);
  await worker().runPass();
  assert.equal((await jobRow(admin, DEPLOYMENT.network))?.blocked_reasons, null);
  assert.equal((await registrations(admin)).get(coin.memeType)?.state, "registered");
});

test("a missing or mismatched deployment never signs and records a configuration block", { skip }, async (t) => {
  const { admin, node, worker } = await harness(t);
  const coin = node.publish({ launchpad: LAUNCHPAD, core: CORE });
  await indexCoin(admin, coin.memeType, 10);

  const unselected = await worker({ BLAST_NETWORK: undefined, BLAST_DEPLOYMENT_FINGERPRINT: undefined }).runPass();
  assert.deepEqual(unselected.access, { status: "blocked", reasons: ["no-deployment-selected"] });
  assert.deepEqual((await jobRow(admin, "unselected"))?.blocked_reasons, ["no-deployment-selected"]);

  const mismatch = await worker({ BLAST_DEPLOYMENT_FINGERPRINT: "c".repeat(64) }).runPass();
  assert.deepEqual(mismatch.access, { status: "blocked", reasons: ["deployment-mismatch"] });

  // Blast deploys to mainnet only: any other network is refused as configuration, before a worker exists.
  assert.throws(() => worker({ BLAST_NETWORK: "testnet" }), /BLAST_NETWORK \(mainnet\)/);

  const unreadable = await worker({ BLAST_WORKER_DEPLOYMENT_MANIFEST: `${await manifestFile("not a manifest")}` }).runPass();
  assert.equal(unreadable.access.status, "blocked");

  // A node on another chain: the fixture deployment is on mainnet, so testnet's genesis digest.
  node.behavior.chainIdentifier = FOREIGN_CHAIN_IDENTIFIER;
  const wrongChain = await worker().runPass();
  assert.deepEqual(wrongChain.access, { status: "blocked", reasons: ["runtime-mismatch"] });
  assert.deepEqual((await jobRow(admin, DEPLOYMENT.network))?.blocked_reasons, ["runtime-mismatch"]);

  node.behavior.chainIdentifier = MANIFEST.chainIdentifier;
  node.behavior.reads = "unavailable";
  const unreachable = await worker().runPass();
  assert.deepEqual(unreachable.access, { status: "blocked", reasons: ["runtime-unverified"] });

  assert.equal((await registrations(admin)).size, 0, "a blocked worker does not even discover");
  assert.equal(node.calls.simulate + node.calls.execute, 0);
  assert.equal(node.pendingCurrency(coin.memeType)?.objectId, coin.pendingCurrency.objectId);
  void FIXTURE_GAS_COST;
});

test("a failed simulation reconciles, backs off and counts; the record registers once the chain accepts it", { skip }, async (t) => {
  const { admin, node, worker } = await harness(t);
  const coin = node.publish({ launchpad: LAUNCHPAD, core: CORE });
  await indexCoin(admin, coin.memeType, 10);

  node.behavior.simulation = "abort";
  await worker().runPass();
  let row = (await registrations(admin)).get(coin.memeType)!;
  assert.equal(row.state, "pending");
  assert.equal(row.error_class, "simulation-failed");
  assert.equal(row.attempts, 1);
  assert.equal(row.latest_digest, null, "nothing was signed");
  assert.equal(node.calls.execute, 0);

  // Still inside its backoff: not visited.
  await admin.query("UPDATE mission_control_coin_registrations SET next_eligible_at = now() + interval '1 hour'");
  const simulations = node.calls.simulate;
  await worker().runPass();
  assert.equal(node.calls.simulate, simulations);

  node.behavior.simulation = "success";
  await elapseBackoff(admin);
  await worker().runPass();
  row = (await registrations(admin)).get(coin.memeType)!;
  assert.equal(row.state, "registered");
  assert.equal(row.outcome, "registered-by-worker");
  assert.equal(row.attempts, 2);
  assert.equal(node.calls.registrations[coin.memeType], 1);
});

test("a lost submission answer reconciles from chain state; a dropped one stays submitted and settles on a later pass", { skip }, async (t) => {
  const { admin, node, worker } = await harness(t);
  const lost = node.publish({ launchpad: LAUNCHPAD, core: CORE, symbol: "LOST" });
  await indexCoin(admin, lost.memeType, 10);
  node.behavior.execution = "lost-response";
  await worker().runPass();
  const reconciled = (await registrations(admin)).get(lost.memeType)!;
  assert.equal(reconciled.state, "registered");
  assert.equal(reconciled.outcome, "registered-by-worker");
  assert.equal(node.calls.registrations[lost.memeType], 1);

  const dropped = node.publish({ launchpad: LAUNCHPAD, core: CORE, symbol: "DROP" });
  await indexCoin(admin, dropped.memeType, 11);
  node.behavior.execution = "dropped";
  await worker().runPass();
  let row = (await registrations(admin)).get(dropped.memeType)!;
  assert.equal(row.state, "submitted");
  assert.equal(row.error_class, "submission-unknown");
  assert.equal(row.attempts, 1);
  const firstDigest = row.latest_digest;
  assert.ok(firstDigest);

  node.behavior.execution = "complete";
  await elapseBackoff(admin);
  await worker().runPass();
  row = (await registrations(admin)).get(dropped.memeType)!;
  assert.equal(row.state, "registered");
  // The signer gate resent the same bytes (the same transaction, not a new attempt).
  assert.equal(row.attempts, 1);
  assert.equal(row.latest_digest, firstDigest);
  assert.equal(node.calls.registrations[dropped.memeType], 1, "registered exactly once on chain");
});

test("an attempt that lands after its pass, or a registration raced by anyone, closes as success without another submission", { skip }, async (t) => {
  const { admin, node, worker } = await harness(t);
  const late = node.publish({ launchpad: LAUNCHPAD, core: CORE, symbol: "LATE" });
  await indexCoin(admin, late.memeType, 10);

  // The node takes longer than the worker waits: the record stays submitted.
  node.behavior.executeDelayMs = 3_000;
  await worker({ BLAST_WORKER_PROVIDER_TIMEOUT_MS: "300", BLAST_WORKER_CONFIRM_TIMEOUT_MS: "300" }).runPass();
  let rows = await registrations(admin);
  assert.equal(rows.get(late.memeType)?.state, "submitted");
  assert.equal(rows.get(late.memeType)?.error_class, "submission-unknown");
  node.behavior.executeDelayMs = 0;
  await new Promise((resolve) => setTimeout(resolve, 3_500));
  assert.ok(node.sharedCurrency(late.memeType), "the submission landed after all");

  // Meanwhile someone else registers another coin before the worker reaches it.
  const raced = node.publish({ launchpad: LAUNCHPAD, core: CORE, symbol: "RACE" });
  await indexCoin(admin, raced.memeType, 11);
  node.registerExternally(raced.memeType);

  const executions = node.calls.execute;
  await elapseBackoff(admin);
  await worker().runPass();
  rows = await registrations(admin);
  assert.equal(rows.get(late.memeType)?.state, "registered");
  assert.equal(rows.get(late.memeType)?.outcome, "registered-by-worker");
  assert.equal(rows.get(raced.memeType)?.state, "registered");
  assert.equal(rows.get(raced.memeType)?.outcome, "already-registered");
  assert.equal(node.calls.execute, executions, "no new submission");
  assert.equal(node.calls.registrations[late.memeType], 1);
  assert.equal(node.calls.registrations[raced.memeType], 1);
});

test("two workers with one key: one is active, the other an idle standby; every transaction pays from the address balance", { skip }, async (t) => {
  const { admin, node, process } = await harness(t);
  const coins = Array.from({ length: 4 }, (_, index) => node.publish({ launchpad: LAUNCHPAD, core: CORE, symbol: `TWO${index}` }));
  for (const [index, coin] of coins.entries()) await indexCoin(admin, coin.memeType, 10 + index);
  node.behavior.executeDelayMs = 150;

  const [first, second] = [process(), process()];
  const reports = await Promise.all([first.runPass(), second.runPass()]);
  assert.deepEqual(reports.map((report) => report.role).sort(), ["active", "standby"]);
  const standby = reports[0]!.role === "standby" ? first : second;
  const active = standby === first ? second : first;
  await elapseBackoff(admin);
  assert.equal((await standby.runPass()).role, "standby", "the standby stays idle while the active process renews");
  assert.equal((await active.runPass()).role, "active");

  const rows = await registrations(admin);
  for (const coin of coins) {
    assert.equal(rows.get(coin.memeType)?.state, "registered", coin.memeType);
    assert.equal(rows.get(coin.memeType)?.attempts, 1, coin.memeType);
    assert.equal(node.calls.registrations[coin.memeType], 1, coin.memeType);
  }
  await assertAddressBalanceGas(admin, node);
  await Promise.all([first.release(), second.release()]);
  const { rows: leftover } = await admin.query("SELECT count(*)::int AS count FROM mission_control_worker_leases");
  assert.equal(leftover[0]?.count, 0, "a clean stop releases every lease, the signer's included");
});

test("after an unknown outcome the worker signs nothing new until that submission resolves (no second transaction over an in-flight gas version)", { skip }, async (t) => {
  const { admin, node, process } = await harness(t);
  const first = node.publish({ launchpad: LAUNCHPAD, core: CORE, symbol: "SLOW" });
  const second = node.publish({ launchpad: LAUNCHPAD, core: CORE, symbol: "NEXT" });
  await indexCoin(admin, first.memeType, 10);
  await indexCoin(admin, second.memeType, 11);

  // The first submission outlives its bounds: `unknown`, still in flight.
  node.behavior.executeDelayMs = 1_500;
  const worker = process({ BLAST_WORKER_PROVIDER_TIMEOUT_MS: "300", BLAST_WORKER_CONFIRM_TIMEOUT_MS: "300" });
  await worker.runPass();
  let rows = [...(await registrations(admin)).values()];
  assert.deepEqual(rows.map((row) => row.state).sort(), ["pending", "submitted"]);
  const waiting = rows.find((row) => row.state === "pending")!;
  assert.equal(waiting.error_class, "signer-busy");
  assert.equal(waiting.attempts, 0, "nothing was signed for the next record");
  assert.equal(waiting.latest_digest, null);
  await assertAddressBalanceGas(admin, node);

  // Once it lands, the next pass settles it first, then signs the next record over the new gas version.
  await new Promise((resolve) => setTimeout(resolve, 1_700));
  node.behavior.executeDelayMs = 0;
  await elapseBackoff(admin);
  await worker.runPass();
  rows = [...(await registrations(admin)).values()];
  assert.ok(rows.every((row) => row.state === "registered" && row.attempts === 1), JSON.stringify(rows));
  assert.equal(node.calls.registrations[first.memeType], 1);
  assert.equal(node.calls.registrations[second.memeType], 1);
  await assertAddressBalanceGas(admin, node);
  assert.deepEqual((await submissions(admin)).map((row) => row.resolution), ["executed", "executed"]);
});

test("an unresolved submission is resent as the same bytes before anything new is signed; one whose epoch ended is settled as expired", { skip }, async (t) => {
  const { admin, node, process } = await harness(t);
  const lost = node.publish({ launchpad: LAUNCHPAD, core: CORE, symbol: "LOST" });
  const other = node.publish({ launchpad: LAUNCHPAD, core: CORE, symbol: "OTHR" });
  await indexCoin(admin, lost.memeType, 10);
  await indexCoin(admin, other.memeType, 11);
  const worker = process();

  // Never reaches a validator: unknown, and the gate closes.
  node.behavior.execution = "dropped";
  await worker.runPass();
  const submitted = [...(await registrations(admin)).values()].find((row) => row.state === "submitted")!;
  assert.ok(submitted.latest_digest);

  // The node is back: the same bytes are resent (same digest, not a new attempt), then the other record signs.
  node.behavior.execution = "complete";
  await elapseBackoff(admin);
  await worker.runPass();
  let rows = await registrations(admin);
  assert.equal(rows.get(submitted.meme_type)?.state, "registered");
  assert.equal(rows.get(submitted.meme_type)?.outcome, "registered-by-worker");
  assert.equal(rows.get(submitted.meme_type)?.attempts, 1);
  assert.equal(rows.get(submitted.meme_type)?.latest_digest, submitted.latest_digest);
  assert.equal([...rows.values()].filter((row) => row.state === "registered").length, 2);
  await assertAddressBalanceGas(admin, node);

  // Dropped again, then the epoch ends: the expired transaction can never run, so a new one is signed.
  const late = node.publish({ launchpad: LAUNCHPAD, core: CORE, symbol: "EPOC" });
  await indexCoin(admin, late.memeType, 12);
  node.behavior.execution = "dropped";
  await worker.runPass();
  node.behavior.execution = "complete";
  node.resetEpoch();
  await elapseBackoff(admin);
  await worker.runPass();
  rows = await registrations(admin);
  assert.equal(rows.get(late.memeType)?.state, "registered");
  assert.equal(rows.get(late.memeType)?.attempts, 2);
  assert.deepEqual((await submissions(admin)).map((row) => row.resolution), ["executed", "executed", "expired", "executed"]);
  await assertAddressBalanceGas(admin, node);
});

test("a record whose submission is still in flight never stalls; it closes once the submission lands", { skip }, async (t) => {
  const { admin, node, process } = await harness(t);
  const coin = node.publish({ launchpad: LAUNCHPAD, core: CORE });
  await indexCoin(admin, coin.memeType, 10);
  node.behavior.executeDelayMs = 1_500;
  const worker = process({ BLAST_WORKER_MAX_ATTEMPTS: "1", BLAST_WORKER_PROVIDER_TIMEOUT_MS: "300", BLAST_WORKER_CONFIRM_TIMEOUT_MS: "300" });
  await worker.runPass();
  await elapseBackoff(admin);
  await worker.runPass();
  let row = (await registrations(admin)).get(coin.memeType)!;
  assert.notEqual(row.state, "stalled", "an attempt that may still land is not exhausted");
  await new Promise((resolve) => setTimeout(resolve, 1_700));
  await elapseBackoff(admin);
  await worker.runPass();
  row = (await registrations(admin)).get(coin.memeType)!;
  assert.equal(row.state, "registered");
  assert.equal(row.outcome, "registered-by-worker");
  assert.equal(node.calls.registrations[coin.memeType], 1);
  await assertAddressBalanceGas(admin, node);
});

test("a local failure (an unreadable type) is a counted internal-error, not a provider outage", { skip }, async (t) => {
  const { admin, node, worker } = await harness(t);
  const coin = node.publish({ launchpad: LAUNCHPAD, core: CORE });
  await indexCoin(admin, coin.memeType, 10);
  const derived = sharedCurrencyId(coin.memeType);
  const core = node.client.core as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
  const getObjects = core.getObjects!.bind(core);
  core.getObjects = async (...args: unknown[]) => {
    const [options] = args as [{ objectIds: string[] }];
    if (options.objectIds[0] === derived) {
      // The derived currency answers with a type the worker cannot parse.
      return { objects: [{ objectId: derived, version: "1", digest: "11111111111111111111111111111111", owner: { $kind: "Shared", Shared: { initialSharedVersion: "1" } }, type: "not a <type" }] };
    }
    return getObjects(...args);
  };
  await worker().runPass();
  const row = (await registrations(admin)).get(coin.memeType)!;
  assert.equal(row.state, "pending");
  assert.equal(row.error_class, "internal-error");
  assert.equal(row.attempts, 1, "a local failure counts toward the bound");
});

test("a crashed worker's expired lease is taken over; an unexpired one is respected", { skip }, async (t) => {
  const { admin, node, worker } = await harness(t);
  const coin = node.publish({ launchpad: LAUNCHPAD, core: CORE });
  await indexCoin(admin, coin.memeType, 10);
  await worker().runPass();
  await admin.query("UPDATE mission_control_coin_registrations SET state = 'pending', outcome = NULL, registered_at = NULL, shared_currency_id = NULL");
  const other = node.publish({ launchpad: LAUNCHPAD, core: CORE, symbol: "HELD" });
  await indexCoin(admin, other.memeType, 11);

  // Another process holds `other` and has not expired.
  await admin.query(
    `INSERT INTO mission_control_worker_leases (job, lease_key, holder, acquired_at, expires_at)
     VALUES ('coin-registration', $1, $2, now(), now() + interval '1 hour')`,
    [`${DEPLOYMENT.network}:${other.memeType}`, randomUUID()],
  );
  await worker().runPass();
  assert.equal((await registrations(admin)).get(other.memeType)?.state, "pending", "the live lease is respected");
  assert.equal(node.calls.registrations[other.memeType], undefined);

  // The holder crashed: its lease expires and the next worker takes over.
  await admin.query("UPDATE mission_control_worker_leases SET acquired_at = now() - interval '2 hours', expires_at = now() - interval '1 hour'");
  await worker().runPass();
  const rows = await registrations(admin);
  assert.equal(rows.get(other.memeType)?.state, "registered");
  assert.equal(rows.get(coin.memeType)?.state, "registered", "a record already registered on chain closes as success");
  assert.equal(rows.get(coin.memeType)?.outcome, "registered-by-worker", "attributed from its recorded digest");
  assert.equal(node.calls.registrations[coin.memeType], 1);
});

test("restart revisits the cursor and unfinished records without skipping or repeating a publication", { skip }, async (t) => {
  const { admin, node, worker } = await harness(t);
  const coins = Array.from({ length: 5 }, (_, index) => node.publish({ launchpad: LAUNCHPAD, core: CORE, symbol: `PAGE${index}` }));
  // Two coins in one checkpoint: the cursor orders by (checkpoint, coin type).
  for (const [index, coin] of coins.entries()) await indexCoin(admin, coin.memeType, 10 + Math.floor(index / 2));

  // A process with a batch of two stops after one pass, mid-backlog.
  node.behavior.execution = "dropped";
  await worker({ BLAST_WORKER_BATCH_SIZE: "2" }).runPass();
  let rows = await registrations(admin);
  assert.equal(rows.size, 2);
  // The first is unresolved, so the gate signs nothing for the second.
  assert.deepEqual([...rows.values()].map((row) => `${row.state}:${row.error_class}`).sort(), ["pending:signer-busy", "submitted:submission-unknown"]);

  // A new process (a restart) continues from the cursor and the unfinished records.
  node.behavior.execution = "complete";
  for (let pass = 0; pass < 4; pass += 1) {
    await elapseBackoff(admin);
    await worker({ BLAST_WORKER_BATCH_SIZE: "2" }).runPass();
  }
  rows = await registrations(admin);
  assert.deepEqual([...rows.keys()].sort(), coins.map((coin) => coin.memeType).sort(), "every publication, once");
  for (const coin of coins) {
    assert.equal(rows.get(coin.memeType)?.state, "registered", coin.memeType);
    assert.equal(node.calls.registrations[coin.memeType], 1, coin.memeType);
  }
});

test("the funding alert fires while gas can still pay; below the gas budget nothing is submitted", { skip }, async (t) => {
  const { admin, node, worker } = await harness(t);
  const coin = node.publish({ launchpad: LAUNCHPAD, core: CORE });
  await indexCoin(admin, coin.memeType, 10);
  const alerts: FundingAlert[] = [];

  // Below the alert (100,000,000) and above the budget (50,000,000): alert, then register.
  node.fundAddressBalance(FIXTURE_GAS_KEY.toSuiAddress(), 60_000_000n);
  await worker({}, { onFundingAlert: (alert) => alerts.push(alert) }).runPass();
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0]?.balanceMist, 60_000_000n);
  assert.equal(alerts[0]?.thresholdMist, 100_000_000n);
  assert.equal((await registrations(admin)).get(coin.memeType)?.state, "registered");

  const poor = node.publish({ launchpad: LAUNCHPAD, core: CORE, symbol: "POOR" });
  await indexCoin(admin, poor.memeType, 11);
  node.fundAddressBalance(FIXTURE_GAS_KEY.toSuiAddress(), 40_000_000n);
  await worker({}, { onFundingAlert: (alert) => alerts.push(alert) }).runPass();
  const row = (await registrations(admin)).get(poor.memeType)!;
  assert.equal(row.state, "pending");
  assert.equal(row.error_class, "insufficient-gas");
  assert.equal(row.attempts, 0);
  assert.equal(alerts.length, 2);
  assert.equal(node.calls.simulate, 1, "only the first coin was simulated");
});

test("retries are bounded: after the configured attempts the record stalls and is never signed again", { skip }, async (t) => {
  const { admin, node, worker } = await harness(t);
  const coin = node.publish({ launchpad: LAUNCHPAD, core: CORE });
  await indexCoin(admin, coin.memeType, 10);
  node.behavior.simulation = "abort";
  for (let pass = 0; pass < 5; pass += 1) {
    await worker().runPass();
    await elapseBackoff(admin);
  }
  const row = (await registrations(admin)).get(coin.memeType)!;
  assert.equal(row.state, "stalled");
  assert.equal(row.error_class, "attempts-exhausted");
  assert.equal(row.attempts, 3);
  assert.equal(node.calls.simulate, 3);
  assert.equal(node.calls.execute, 0);
});

test("an unreachable node ends a record's pass as provider-unavailable without counting an attempt", { skip }, async (t) => {
  const { admin, node, worker } = await harness(t);
  const coin = node.publish({ launchpad: LAUNCHPAD, core: CORE });
  await indexCoin(admin, coin.memeType, 10);
  await worker().runPass();
  await admin.query("UPDATE mission_control_coin_registrations SET state = 'pending', outcome = NULL, registered_at = NULL, shared_currency_id = NULL, attempts = 0, latest_digest = NULL");

  // The node answers the deployment check, then times out on every record read.
  const slow = createFixtureNode(MANIFEST);
  const client = slow.client.core as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
  const listOwnedObjects = client.getObjects!.bind(client);
  let deploymentChecked = false;
  client.getObjects = async (...args: unknown[]) => {
    if (!deploymentChecked) {
      deploymentChecked = true;
      return listOwnedObjects(...args);
    }
    return new Promise(() => undefined);
  };
  await worker({ BLAST_WORKER_PROVIDER_TIMEOUT_MS: "200", BLAST_WORKER_CONFIRM_TIMEOUT_MS: "200" }, { node: slow }).runPass();
  const row = (await registrations(admin)).get(coin.memeType)!;
  assert.equal(row.state, "pending");
  assert.equal(row.error_class, "provider-unavailable");
  assert.equal(row.attempts, 0);
});

test("a Mission Control reset keeps the worker's cursor, records and submissions", { skip }, async (t) => {
  const { admin, node, worker } = await harness(t);
  const coin = node.publish({ launchpad: LAUNCHPAD, core: CORE });
  await indexCoin(admin, coin.memeType, 10);
  await worker().runPass();
  const before = await registrations(admin);
  await resetDatabase(admin);
  assert.deepEqual(await registrations(admin), before);
  assert.equal((await submissions(admin)).length, 1);
  assert.deepEqual((await jobRow(admin, DEPLOYMENT.network))?.cursor, { checkpoint: "10", coinType: coin.memeType });
});

test("an unreadable epoch keeps the signer gate closed: nothing new is signed, and the next clean pass settles it", { skip }, async (t) => {
  const { admin, node, process } = await harness(t);
  const lost = node.publish({ launchpad: LAUNCHPAD, core: CORE, symbol: "LOST" });
  const next = node.publish({ launchpad: LAUNCHPAD, core: CORE, symbol: "NEXT" });
  await indexCoin(admin, lost.memeType, 10);
  await indexCoin(admin, next.memeType, 11);
  const worker = process();

  // An unresolved submission: the bytes never reached a validator.
  node.behavior.execution = "dropped";
  await worker.runPass();
  const open = await submissions(admin);
  assert.equal(open.length, 1);
  assert.equal(open[0]?.resolution, null);
  // Whichever record the pass reached first holds the open submission; the other waits.
  const waitingType = open[0]!.record_key === lost.memeType ? next.memeType : lost.memeType;
  node.behavior.execution = "complete";

  // The node has no effects for the digest and fails the epoch read: nothing proves the bytes can no longer run.
  const core = node.client.core as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
  const getCurrentSystemState = core.getCurrentSystemState!.bind(core);
  core.getCurrentSystemState = async () => {
    throw new Error("The fixture node fails the epoch read.");
  };
  const executions = node.calls.execute;
  await elapseBackoff(admin);
  await worker.runPass();
  assert.deepEqual((await submissions(admin)).map((row) => row.resolution), [null], "the submission stays open");
  assert.equal(node.calls.execute, executions, "nothing was sent");
  const waiting = (await registrations(admin)).get(waitingType)!;
  assert.equal(waiting.attempts, 0, "nothing new was signed");
  assert.equal(waiting.latest_digest, null);

  // A clean read: the epoch has not ended, so the same bytes are resent.
  core.getCurrentSystemState = getCurrentSystemState;
  await elapseBackoff(admin);
  await worker.runPass();
  const rows = await registrations(admin);
  for (const coin of [lost, next]) {
    assert.equal(rows.get(coin.memeType)?.state, "registered", coin.memeType);
    assert.equal(rows.get(coin.memeType)?.attempts, 1, coin.memeType);
  }
  assert.deepEqual((await submissions(admin)).map((row) => row.resolution), ["executed", "executed"]);
  await assertAddressBalanceGas(admin, node);
});

test("the key pays gas from its address balance: no gas coin, a one-epoch ValidDuring; a lost answer is resent, an ended epoch settles as expired", { skip }, async (t) => {
  const { admin, node, process } = await harness(t);
  const owner = FIXTURE_GAS_KEY.toSuiAddress();
  const first = node.publish({ launchpad: LAUNCHPAD, core: CORE, symbol: "ADDR" });
  await indexCoin(admin, first.memeType, 10);
  const worker = process();

  await worker.runPass();
  assert.equal((await registrations(admin)).get(first.memeType)?.state, "registered");
  const { rows } = await admin.query<{ transaction_bytes: Buffer; expires_epoch: string }>(
    "SELECT transaction_bytes, expires_epoch FROM mission_control_worker_submissions",
  );
  assert.equal(rows.length, 1);
  const data = Transaction.from(new Uint8Array(rows[0]!.transaction_bytes)).getData();
  assert.deepEqual(data.gasData.payment, []);
  assert.equal(data.expiration?.$kind, "ValidDuring");
  assert.equal(String(data.expiration?.ValidDuring?.minEpoch), rows[0]!.expires_epoch);
  assert.equal(String(data.expiration?.ValidDuring?.maxEpoch), rows[0]!.expires_epoch);
  assert.equal(data.expiration?.ValidDuring?.chain, node.behavior.chainIdentifier);
  const { balance } = await node.client.core.getBalance({ owner });
  assert.equal(balance.addressBalance, String(FUNDED - FIXTURE_GAS_COST), "gas came from the address balance");

  // Lost before any validator: the same bytes are resent; then, dropped again and the epoch ends, they settle as expired.
  const lost = node.publish({ launchpad: LAUNCHPAD, core: CORE, symbol: "LOST" });
  await indexCoin(admin, lost.memeType, 11);
  node.behavior.execution = "dropped";
  await worker.runPass();
  const submitted = (await registrations(admin)).get(lost.memeType)!;
  assert.equal(submitted.state, "submitted");
  node.behavior.execution = "complete";
  await elapseBackoff(admin);
  await worker.runPass();
  assert.equal((await registrations(admin)).get(lost.memeType)?.latest_digest, submitted.latest_digest);
  assert.equal((await registrations(admin)).get(lost.memeType)?.state, "registered");

  const late = node.publish({ launchpad: LAUNCHPAD, core: CORE, symbol: "EPOC" });
  await indexCoin(admin, late.memeType, 12);
  node.behavior.execution = "dropped";
  await worker.runPass();
  node.behavior.execution = "complete";
  node.resetEpoch();
  await elapseBackoff(admin);
  await worker.runPass();
  assert.equal((await registrations(admin)).get(late.memeType)?.state, "registered");
  assert.deepEqual((await submissions(admin)).map((row) => row.resolution), ["executed", "executed", "expired", "executed"]);
});

/** Records per transaction raised to the default, 8. */
const BATCHED = { BLAST_WORKER_RECORDS_PER_TRANSACTION: undefined };

async function submissionKeys(admin: Pool) {
  const { rows } = await admin.query<{ digest: string; record_keys: string[]; intent: { records: Array<{ memeType: string }> } }>(
    "SELECT digest, record_keys, intent FROM mission_control_worker_submissions ORDER BY submitted_at",
  );
  return rows;
}

test("several pending currencies register in one transaction: one digest on every record, one submission naming them all", { skip }, async (t) => {
  const { admin, node, worker } = await harness(t);
  const coins = ["ONE", "TWO", "THREE"].map((symbol) => node.publish({ launchpad: LAUNCHPAD, core: CORE, symbol }));
  for (const [index, coin] of coins.entries()) await indexCoin(admin, coin.memeType, 10 + index);

  await worker(BATCHED).runPass();

  assert.equal(node.calls.execute, 1);
  assert.deepEqual(node.calls.registrationBatches, [3]);
  const rows = await registrations(admin);
  const digests = new Set(coins.map((coin) => rows.get(coin.memeType)?.latest_digest));
  assert.equal(digests.size, 1);
  for (const coin of coins) {
    const row = rows.get(coin.memeType)!;
    assert.equal(row.state, "registered", coin.memeType);
    assert.equal(row.outcome, "registered-by-worker", coin.memeType);
    assert.equal(row.attempts, 1, coin.memeType);
    assert.equal(row.shared_currency_id, node.sharedCurrency(coin.memeType), coin.memeType);
  }
  const [submission, ...others] = await submissionKeys(admin);
  assert.equal(others.length, 0);
  assert.equal(submission?.digest, [...digests][0]);
  // Due records come in Meme type order; the keys and the intent share the command order.
  assert.deepEqual([...submission!.record_keys].sort(), coins.map((coin) => coin.memeType).sort());
  assert.deepEqual(submission?.intent.records.map((record) => record.memeType), submission?.record_keys);
  await assertAddressBalanceGas(admin, node);
});

test("a record whose registration fails simulation is dropped from the batch; the others register together", { skip }, async (t) => {
  const { admin, node, worker } = await harness(t);
  const [first, refused, last] = ["ONE", "TWO", "THREE"].map((symbol) => node.publish({ launchpad: LAUNCHPAD, core: CORE, symbol }));
  for (const [index, coin] of [first!, refused!, last!].entries()) await indexCoin(admin, coin.memeType, 10 + index);
  node.behavior.refuseRegistrations = [refused!.memeType];

  await worker(BATCHED).runPass();

  assert.deepEqual(node.calls.registrationBatches, [2]);
  const rows = await registrations(admin);
  for (const coin of [first!, last!]) assert.equal(rows.get(coin.memeType)?.state, "registered", coin.memeType);
  const dropped = rows.get(refused!.memeType)!;
  assert.equal(dropped.state, "pending");
  assert.equal(dropped.error_class, "simulation-failed");
  assert.equal(dropped.attempts, 1);
  assert.equal(dropped.latest_digest, null);

  // Its next attempt goes alone, so it cannot sink a batch twice.
  node.behavior.refuseRegistrations = [];
  await elapseBackoff(admin);
  await worker(BATCHED).runPass();
  assert.deepEqual(node.calls.registrationBatches, [2, 1]);
  assert.equal((await registrations(admin)).get(refused!.memeType)?.state, "registered");
});

test("a registration raced on chain fails the batch: its record closes as already registered, the others get their attempt back", { skip }, async (t) => {
  const { admin, node, worker } = await harness(t);
  const [first, raced, last] = ["ONE", "TWO", "THREE"].map((symbol) => node.publish({ launchpad: LAUNCHPAD, core: CORE, symbol }));
  for (const [index, coin] of [first!, raced!, last!].entries()) await indexCoin(admin, coin.memeType, 10 + index);
  // Someone else's registration lands after our simulation and before our execution.
  node.behavior.registerBeforeExecution = [raced!.memeType];

  await worker(BATCHED).runPass();

  assert.equal(node.calls.execute, 1);
  assert.deepEqual(node.calls.registrationBatches, [], "the transaction aborted");
  const rows = await registrations(admin);
  const closed = rows.get(raced!.memeType)!;
  assert.equal(closed.state, "registered");
  assert.equal(closed.outcome, "already-registered");
  for (const coin of [first!, last!]) {
    const row = rows.get(coin.memeType)!;
    assert.equal(row.state, "submitted", coin.memeType);
    assert.equal(row.error_class, "batch-failed", coin.memeType);
    assert.equal(row.attempts, 0, `${coin.memeType}: the attempt is refunded`);
  }

  await elapseBackoff(admin);
  await worker(BATCHED).runPass();
  assert.deepEqual(node.calls.registrationBatches, [2]);
  const after = await registrations(admin);
  for (const coin of [first!, last!]) {
    assert.equal(after.get(coin.memeType)?.state, "registered", coin.memeType);
    assert.equal(after.get(coin.memeType)?.outcome, "registered-by-worker", coin.memeType);
    assert.equal(after.get(coin.memeType)?.attempts, 1, coin.memeType);
  }
});
