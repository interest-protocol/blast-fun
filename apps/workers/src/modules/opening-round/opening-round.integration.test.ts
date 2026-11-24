// LP-18: the opening-round keeper against a disposable PostgreSQL (blast-infra's
// `chain_read_v1` fixture, the web migrations) and the keepers' fixture node.

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { type TestContext } from "node:test";

import { normalizeSuiAddress } from "@mysten/sui/utils";
import type { Pool } from "pg";

import { createKeeperNode, type KeeperLaunch, type KeeperNode } from "../../../test/fixtures/modules/launchpad-keepers/keeper-node.ts";
import {
  adminPool,
  DEPLOYMENT,
  FINGERPRINT,
  FIXTURE_GAS_KEY,
  freshDatabase,
  watcherPool,
  workerEnvironment,
} from "../../../test/fixtures/modules/coin-registration/testing.ts";
import { workerConfigFromEnvironment } from "../worker-runtime/config.ts";
import type { KeeperMarket } from "../blast-keeper/keepers.ts";
import { createWorker, type ProtocolWorkerAccess } from "../worker-runtime/runtime.ts";
import { loadKeeperSigner } from "../blast-keeper/signer.ts";
import { createWorkerAlerts, type KeeperAlerts } from "../worker-runtime/alerts.ts";
import { alertKey, openingRoundJob } from "./job.ts";

const databaseUrl = process.env.MISSION_CONTROL_TEST_DATABASE_URL;
const skip = databaseUrl ? false : "MISSION_CONTROL_TEST_DATABASE_URL is not set";
const SETTLE = "launch::settle_opening_round";
const DELIVER = "launch::deliver_opening_round";
const bidder = (n: number) => normalizeSuiAddress(`0x${n.toString(16).padStart(2, "0").repeat(32)}`);

type Raised = { key: string; graceMs: number | undefined };

/**
 * blast-infra's bidders list over the node: every bidder in join order, its
 * delivery known once the node no longer holds its bid, unless the index is
 * frozen (lagging) for that launch. Pages of `pageSize`.
 */
function indexOver(node: KeeperNode, pageSize = 3) {
  const joined = new Map<string, string[]>();
  const frozen = new Map<string, Set<string>>();
  const market: KeeperMarket = {
    async bidders(launchId, cursor) {
      const all = joined.get(launchId) ?? [];
      const start = cursor ? Number(cursor.slice(1)) : 0;
      const page = all.slice(start, start + pageSize);
      const delivered = (who: string) => frozen.get(launchId)?.has(who) ?? !node.launch(launchId).bids.has(who);
      return {
        launchId,
        bidders: page.map((who) => ({ bidder: who, delivery: delivered(who) ? {} : null })) as never,
        nextCursor: start + pageSize < all.length ? `p${start + pageSize}` : null,
      };
    },
  };
  return {
    market,
    join(launch: KeeperLaunch) {
      joined.set(launch.objectId, [...launch.bids.keys()]);
    },
    /** The index lags: these bidders show as delivered (or not) as they are now, whatever happens next. */
    freeze(launch: KeeperLaunch, delivered: readonly string[]) {
      frozen.set(launch.objectId, new Set(delivered));
    },
  };
}

/** `alerts` builds the job's alert channel on the test's own database (`url`); by default alerts are only recorded. */
async function harness(t: TestContext, options: { batch?: number; alerts?: (url: string) => KeeperAlerts; alertAfterMs?: number } = {}) {
  const database = await freshDatabase(1_000);
  const { url } = database;
  const admin = adminPool(url);
  const pool = watcherPool(url);
  const node = createKeeperNode(DEPLOYMENT);
  node.fundAddressBalance(FIXTURE_GAS_KEY.toSuiAddress(), 10_000_000_000n);
  const index = indexOver(node);
  const raised: Raised[] = [];
  const cleared: string[] = [];
  const alerts: KeeperAlerts = options.alerts?.(url) ?? {
    raise: async (key, _details, opts) => (raised.push({ key, graceMs: opts?.graceMs }), "held"),
    clear: async (key) => void cleared.push(key),
  };
  const environment = workerEnvironment(url, "/unused/manifest.json");
  const config = workerConfigFromEnvironment(environment);
  const access = async (): Promise<ProtocolWorkerAccess> =>
    ({ status: "enabled", deployment: DEPLOYMENT, fingerprint: FINGERPRINT, protocol: {} }) as unknown as ProtocolWorkerAccess;
  const worker = createWorker({
    config,
    pool,
    client: node.client,
    signer: loadKeeperSigner(environment, { gasBudgetMist: config.gasBudgetMist, creationFeeCapMist: 0n }),
    jobs: [openingRoundJob({ market: index.market, alerts, deliveryBatchSize: options.batch ?? 2, alertAfterMs: options.alertAfterMs ?? 600_000 })],
    holder: randomUUID(),
    access,
  });
  t.after(async () => {
    await worker.release();
    await Promise.all([admin.end(), pool.end()]);
    await database.drop();
  });
  const indexLaunch = async (launch: KeeperLaunch, lifecycle = "opening_round", checkpoint = 900) => {
    await admin.query(
      `INSERT INTO pools (pool_key, venue, coin_type, quote_type, lifecycle, created_checkpoint, created_at_ms)
       VALUES ('blast_curve:' || $1, 'blast_curve', $2, $3, $4, $5, 1790000000000)`,
      [launch.objectId, launch.memeType, launch.quoteType, lifecycle, checkpoint],
    );
    index.join(launch);
  };
  return { admin, node, index, worker, raised, cleared, indexLaunch, passes: async (n: number) => { for (let i = 0; i < n; i++) await worker.runPass(); } };
}

async function record(admin: Pool, launchId: string) {
  const { rows } = await admin.query(
    `SELECT state, settled_by, delivered_bidders, attempts, error_class, round_end_ms::text AS round_end_ms, bidders_cursor
     FROM mission_control_opening_rounds WHERE launch_id = $1`,
    [launchId],
  );
  return rows[0] as { state: string; settled_by: string | null; delivered_bidders: number; attempts: number; error_class: string | null; round_end_ms: string | null; bidders_cursor: string | null };
}

test("LP-18: an ended round is settled within one pass, then every bidder is delivered once, in batches, and the record closes", { skip }, async (t) => {
  const h = await harness(t, { batch: 2 });
  const bids = Object.fromEntries([1, 2, 3, 4, 5].map((n) => [bidder(n), BigInt(n) * 1_000_000n]));
  const launch = h.node.addLaunch({ bids });
  await h.indexLaunch(launch);

  await h.worker.runPass();
  assert.equal(h.node.launch(launch.objectId).lifecycle, "Live", "settled in the first pass");
  assert.deepEqual(h.node.calls.map((call) => call.target), [SETTLE]);
  assert.equal((await record(h.admin, launch.objectId)).state, "delivering");
  assert.equal((await record(h.admin, launch.objectId)).settled_by, "worker");
  assert.ok(h.cleared.includes(alertKey(launch.objectId)), "the settled round clears its alert");

  await h.passes(4);
  const delivered = h.node.calls.filter((call) => call.target === DELIVER);
  assert.deepEqual(delivered.map((call) => call.bidder).sort(), Object.keys(bids).sort(), "each bidder once");
  // Batches of at most two bidders per transaction.
  const perDigest = new Map<string, number>();
  for (const call of delivered) perDigest.set(call.digest, (perDigest.get(call.digest) ?? 0) + 1);
  assert.deepEqual([...perDigest.values()], [2, 2, 1]);
  const closed = await record(h.admin, launch.objectId);
  assert.equal(closed.state, "delivered");
  assert.equal(closed.delivered_bidders, 5);
});

test("LP-18: a round someone else settled moves to delivery without a settle submission; one settled in the race is attributed to them", { skip }, async (t) => {
  const h = await harness(t, { batch: 10 });
  const early = h.node.addLaunch({ bids: { [bidder(1)]: 5n } });
  const raced = h.node.addLaunch({ bids: { [bidder(2)]: 7n } });
  await h.indexLaunch(early, "live", 900);
  await h.indexLaunch(raced, "opening_round", 901);
  // Another wallet settled `early` before the keeper saw it, and settles `raced` between our simulation and execution.
  h.node.launch(early.objectId).lifecycle = "Live";
  h.node.behavior.beforeExecute = () => void (h.node.launch(raced.objectId).lifecycle = "Live");

  await h.worker.runPass();
  assert.equal((await record(h.admin, early.objectId)).settled_by, "external");
  assert.equal((await record(h.admin, early.objectId)).state, "delivering");
  const racedRecord = await record(h.admin, raced.objectId);
  assert.equal(racedRecord.state, "delivering", "the lost race still moves on to delivery");
  assert.equal(racedRecord.settled_by, "external");
  assert.equal(h.node.calls.filter((call) => call.target === SETTLE).length, 0, "no settle of ours landed");

  await h.passes(2);
  assert.deepEqual(h.node.calls.map((call) => call.bidder).sort(), [bidder(1), bidder(2)].sort());
  assert.equal((await record(h.admin, early.objectId)).state, "delivered");
  assert.equal((await record(h.admin, raced.objectId)).state, "delivered");
});

test("LP-18: a partially delivered round, and a bidder delivered meanwhile while the index lags, are skipped from fresh reads, never aborted on", { skip }, async (t) => {
  const h = await harness(t, { batch: 3 });
  const launch = h.node.addLaunch({ lifecycle: "Live", bids: Object.fromEntries([1, 2, 3, 4].map((n) => [bidder(n), 1_000n])) });
  await h.indexLaunch(launch, "live");
  // Bidder 1 was delivered before (the index knows); bidder 2 by another wallet just now (the index does not know yet).
  h.node.launch(launch.objectId).bids.delete(bidder(1));
  h.index.freeze(launch, [bidder(1)]);
  h.node.launch(launch.objectId).bids.delete(bidder(2));

  await h.passes(3);
  const delivered = h.node.calls.filter((call) => call.target === DELIVER).map((call) => call.bidder).sort();
  assert.deepEqual(delivered, [bidder(3), bidder(4)].sort());
  const closed = await record(h.admin, launch.objectId);
  assert.equal(closed.state, "delivered");
  assert.equal(closed.attempts, 0, "no failed attempt");
});

test("LP-18: a running round waits for its end, and a launch without an opening round closes without a call", { skip }, async (t) => {
  const h = await harness(t);
  const running = h.node.addLaunch({ publicStartMs: BigInt(Date.now()), openingRoundMs: 300_000n, bids: { [bidder(1)]: 1n } });
  const none = h.node.addLaunch({ lifecycle: "Live", openingRoundMs: 0n });
  await h.indexLaunch(running);
  await h.indexLaunch(none, "live");
  await h.worker.runPass();
  const waiting = await record(h.admin, running.objectId);
  assert.equal(waiting.state, "settling");
  assert.equal(waiting.round_end_ms, String(h.node.launch(running.objectId).publicStartMs! + 300_000n));
  assert.equal((await record(h.admin, none.objectId)).state, "no-round");
  assert.deepEqual(h.node.calls, []);
  assert.deepEqual(h.raised, [], "no alert before the round ends");
});

test("LP-18: a round left unsettled raises opening_round_unsettled with what is left of its ten minutes, and Discord gets it once they pass", { skip }, async (t) => {
  const h = await harness(t, { batch: 2 });
  h.node.behavior.simulationAborts = true;
  const recent = h.node.addLaunch({ publicStartMs: BigInt(Date.now() - 62_000), openingRoundMs: 60_000n, bids: { [bidder(1)]: 1n } });
  await h.indexLaunch(recent);
  await h.worker.runPass();
  assert.equal((await record(h.admin, recent.objectId)).error_class, "simulation-failed");
  const [first] = h.raised;
  assert.equal(first?.key, alertKey(recent.objectId));
  assert.ok(first!.graceMs! > 590_000 && first!.graceMs! < 600_000, `grace ${first!.graceMs}`);

  // With the presale workers' alert channel: a round that ended eleven minutes ago is sent at once.
  const posted: string[] = [];
  const alerts = (url: string) => {
    const pool = watcherPool(url);
    // Registered before the harness's own cleanup, so this pool ends before its database drops.
    t.after(() => pool.end());
    return createWorkerAlerts({
      pool,
      role: "blast-keeper",
      network: () => "mainnet",
      webhookUrl: "https://discord.invalid/api/webhooks/fixture",
      timeoutMs: 1_000,
      log: () => undefined,
      fetcher: (async (_url: string, init: RequestInit) => (posted.push(String(init.body)), new Response(null, { status: 204 }))) as typeof fetch,
    });
  };
  const late = await harness(t, { alerts });
  late.node.behavior.simulationAborts = true;
  const stale = late.node.addLaunch({ publicStartMs: BigInt(Date.now() - 720_000), openingRoundMs: 60_000n, bids: { [bidder(1)]: 1n } });
  await late.indexLaunch(stale);
  await late.worker.runPass();
  assert.equal(posted.length, 1);
  assert.match(posted[0]!, /Opening round is not settled/);
  assert.match(posted[0]!, new RegExp(`opening_round_unsettled:${stale.objectId}`));
  // Held within the hour while it holds; cleared once settled.
  await late.worker.runPass();
  assert.equal(posted.length, 1);
  late.node.behavior.simulationAborts = false;
  await late.worker.runPass();
  assert.equal(late.node.launch(stale.objectId).lifecycle, "Live");
  const { rows } = await late.admin.query("SELECT count(*)::int AS n FROM blast_worker_alerts WHERE alert_key = $1", [alertKey(stale.objectId)]);
  assert.equal(rows[0].n, 0);
});
