import assert from "node:assert/strict";
import test from "node:test";

import type { Pool } from "pg";

import { migrateDatabase } from "@blast/core/modules/database/migrations.ts";
import { createPool } from "@blast/core/modules/database/pool.ts";
import {
  CHAIN_FIXTURE,
  FIXTURE_CHECKPOINT,
  FIXTURE_FINGERPRINT,
  FIXTURE_NETWORK,
  advanceWatermark,
  urlAs,
} from "../../../../core/test/fixtures/modules/database/role-fixtures.ts";
import { endProcessPools } from "../../../../core/test/fixtures/modules/database/testing.ts";
import { readChainJoin } from "@blast/server/modules/read-routing/chain-join.ts";
import { WORKLOAD_ROUTES } from "@blast/core/modules/read-routing/resources.ts";

// A real primary and hot-standby streaming replica: scripts/with-streaming-replica.sh.
const primaryUrl = process.env.READ_ROUTING_PRIMARY_URL;
const replicaUrl = process.env.READ_ROUTING_REPLICA_URL;
const skip = primaryUrl && replicaUrl ? false : "READ_ROUTING_PRIMARY_URL and READ_ROUTING_REPLICA_URL are not set";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(what: string, check: () => Promise<boolean>, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check().catch(() => false))) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(200);
  }
}

async function replicaCheckpoint(replica: Pool): Promise<number | null> {
  const result = await replica.query<{ checkpoint: string }>("SELECT checkpoint FROM chain_read_v1.watermark");
  return result.rows[0] ? Number(result.rows[0].checkpoint) : null;
}

const identity = async (database: { read: (text: string) => Promise<{ rows: unknown[] }> }) =>
  (await database.read("SELECT current_user::text AS role, count(*)::int AS coins FROM chain_read_v1.coins")).rows;

test("a replica whose WAL receiver stopped is judged by its checkpoint age, not reported fresh", { skip }, async (t) => {
  assert.ok(primaryUrl && replicaUrl);
  const primary = createPool(primaryUrl, { max: 1 });
  const replica = createPool(replicaUrl, { max: 1 });
  const previous = { DATABASE_URL: process.env.DATABASE_URL, DATABASE_REPLICA_URL: process.env.DATABASE_REPLICA_URL };
  t.after(async () => {
    await endProcessPools();
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await Promise.all([primary.end(), replica.end()]);
  });

  await primary.query(CHAIN_FIXTURE);
  await migrateDatabase(primary);
  process.env.DATABASE_URL = urlAs(primaryUrl, "blast_web");
  process.env.DATABASE_REPLICA_URL = urlAs(replicaUrl, "blast_replica");

  // blast-infra commits a checkpoint; the replica streams it.
  const streamed = FIXTURE_CHECKPOINT + 1;
  await primary.query(advanceWatermark(streamed));
  await until("the replica to replay the checkpoint", async () => (await replicaCheckpoint(replica)) === streamed);
  const before = await readChainJoin("search", identity);
  assert.equal(before.status, "fresh");
  assert.deepEqual(
    { ...before.provenance, lagMs: undefined, observedAt: undefined, timestampMs: undefined },
    {
      source: "replica",
      network: FIXTURE_NETWORK,
      deployment: FIXTURE_FINGERPRINT,
      checkpoint: streamed,
      lagMs: undefined,
      observedAt: undefined,
      timestampMs: undefined,
    },
  );

  // Partition the replica: its WAL receiver stops while blast-infra keeps committing.
  await replica.query("ALTER SYSTEM SET primary_conninfo = ''");
  await replica.query("SELECT pg_reload_conf()");
  await until("the WAL receiver to stop", async () =>
    (await replica.query<{ n: number }>("SELECT count(*)::int AS n FROM pg_stat_wal_receiver")).rows[0]?.n === 0);
  await primary.query(
    `INSERT INTO coins (coin_type, decimals, launcher, created_checkpoint, created_at_ms)
     VALUES ('0x2::late::LATE', 9, '0x2', 1, 1)`,
  );
  // What the previous probe trusted: everything received is replayed, so it said lag 0.
  const wal = await replica.query<{ caught_up: boolean }>(
    "SELECT pg_last_wal_receive_lsn() = pg_last_wal_replay_lsn() AS caught_up",
  );
  assert.equal(wal.rows[0]?.caught_up, true);

  let checkpoint = streamed;
  const stalledUntil = Date.now() + WORKLOAD_ROUTES.search.maxLagMs + 1_000;
  while (Date.now() < stalledUntil) {
    checkpoint += 1;
    await primary.query(advanceWatermark(checkpoint));
    await sleep(1_000);
  }
  await primary.query(advanceWatermark(checkpoint));

  const search = await readChainJoin("search", identity);
  assert.equal(search.status, "stale");
  assert.equal(search.provenance.source, "replica");
  assert.equal(search.provenance.checkpoint, streamed);
  assert.equal(search.provenance.reason, "replica-lag", "the primary is ahead, so the replica is to blame");
  assert.ok((search.provenance.lagMs ?? 0) > WORKLOAD_ROUTES.search.maxLagMs, String(search.provenance.lagMs));
  assert.deepEqual("data" in search && search.data, [{ role: "blast_replica", coins: 1 }]);

  const thesis = await readChainJoin("thesis-join", identity);
  assert.equal(thesis.status, "fresh");
  assert.equal(thesis.provenance.source, "primary");
  assert.equal(thesis.provenance.reason, "replica-lag");
  assert.equal(thesis.provenance.checkpoint, checkpoint);
  assert.equal(thesis.provenance.deployment, FIXTURE_FINGERPRINT);
  assert.deepEqual("data" in thesis && thesis.data, [{ role: "blast_web", coins: 2 }]);
});
