import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";

import { createPool } from "@blast/core/modules/database/pool.ts";
import {
  FIXTURE_CHECKPOINT,
  FIXTURE_FINGERPRINT,
  FIXTURE_NETWORK,
  urlAs,
} from "../../../../core/test/fixtures/modules/database/role-fixtures.ts";
import { freshTestDatabase, type TestDatabase } from "../../../../core/test/fixtures/modules/database/template.ts";
import { endProcessPools } from "../../../../core/test/fixtures/modules/database/testing.ts";
import { measureChainPosition, readChainJoin } from "@blast/server/modules/read-routing/chain-join.ts";

const databaseUrl = process.env.MISSION_CONTROL_TEST_DATABASE_URL;
const skip = databaseUrl ? false : "MISSION_CONTROL_TEST_DATABASE_URL is not set";

/** Points the process pools at role-bound connection strings on the test's own database, dropped after them. */
function useEndpoints(t: TestContext, database: TestDatabase, primary: string, replica: string): void {
  const previous = { DATABASE_URL: process.env.DATABASE_URL, DATABASE_REPLICA_URL: process.env.DATABASE_REPLICA_URL };
  process.env.DATABASE_URL = primary;
  process.env.DATABASE_REPLICA_URL = replica;
  t.after(async () => {
    await endProcessPools();
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await database.drop();
  });
}

const identity = async (database: { read: (text: string) => Promise<{ rows: unknown[] }> }) =>
  (await database.read("SELECT current_user::text AS role, symbol FROM chain_read_v1.coins")).rows;

test("the position probe is one pooled statement reading blast-infra's chain_read_v1.watermark", { skip }, async () => {
  const database = await freshTestDatabase();
  const pool = createPool(urlAs(database.url, "blast_replica"), { max: 1 });
  try {
    const position = await measureChainPosition(pool);
    assert.equal(position.inRecovery, false, "a primary reports itself out of recovery");
    assert.equal(position.checkpoint, FIXTURE_CHECKPOINT);
    assert.equal(position.network, FIXTURE_NETWORK);
    assert.equal(position.deployment, FIXTURE_FINGERPRINT);
    assert.ok(position.lagMs !== null && position.lagMs >= 0 && position.lagMs < 5_000, String(position.lagMs));
  } finally {
    await pool.end();
    await database.drop();
  }
});

test("before blast-infra commits a checkpoint the position has none", { skip }, async () => {
  const database = await freshTestDatabase();
  const admin = createPool(database.url, { max: 1 });
  try {
    await admin.query("UPDATE watermarks SET reader_lo = checkpoint_hi_inclusive + 1");
    const { observedAt, ...position } = await measureChainPosition(admin);
    assert.ok(typeof observedAt === "number" && Math.abs(observedAt - Date.now()) < 5_000, String(observedAt));
    assert.deepEqual(position, {
      inRecovery: false,
      network: FIXTURE_NETWORK,
      deployment: FIXTURE_FINGERPRINT,
      checkpoint: null,
      timestampMs: null,
      lagMs: null,
    });

    // blast-infra never started here: no identity, no position at all.
    await admin.query("DELETE FROM deployment_identity");
    assert.deepEqual(await measureChainPosition(admin), {
      inRecovery: false,
      network: null,
      deployment: null,
      checkpoint: null,
      timestampMs: null,
      observedAt: null,
      lagMs: null,
    });
  } finally {
    await admin.end();
    await database.drop();
  }
});

test("chain joins read the chain_read_v1 views as the replica role", { skip }, async (t) => {
  const database = await freshTestDatabase();
  useEndpoints(t, database, urlAs(database.url, "blast_web"), urlAs(database.url, "blast_replica"));
  const result = await readChainJoin("search", identity);
  assert.equal(result.status, "fresh");
  assert.equal(result.provenance.source, "replica");
  assert.equal(result.provenance.checkpoint, FIXTURE_CHECKPOINT);
  assert.equal(result.provenance.network, FIXTURE_NETWORK);
  assert.equal(result.provenance.deployment, FIXTURE_FINGERPRINT);
  assert.deepEqual("data" in result && result.data, [{ role: "blast_replica", symbol: "MEME" }]);
});

test("an unreachable replica makes thesis joins a primary read and search unavailable", { skip }, async (t) => {
  const database = await freshTestDatabase();
  const unreachable = new URL(urlAs(database.url, "blast_replica"));
  unreachable.port = "1";
  useEndpoints(t, database, urlAs(database.url, "blast_web"), unreachable.toString());

  const thesis = await readChainJoin("thesis-join", identity);
  assert.equal(thesis.status, "fresh");
  assert.deepEqual(thesis.provenance.source, "primary");
  assert.equal(thesis.provenance.reason, "replica-unavailable");
  assert.equal(thesis.provenance.checkpoint, FIXTURE_CHECKPOINT);
  assert.equal(thesis.provenance.deployment, FIXTURE_FINGERPRINT);
  assert.deepEqual("data" in thesis && thesis.data, [{ role: "blast_web", symbol: "MEME" }]);

  const search = await readChainJoin("search", identity);
  assert.equal(search.status, "unavailable");
  assert.equal(search.provenance.reason, "replica-unavailable");
  assert.equal("data" in search, false);
});
