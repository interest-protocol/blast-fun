import assert from "node:assert/strict";
import test from "node:test";
import { createPool } from "@blast/core/modules/database/pool.ts";
import { readBondingFeatures } from "@blast/core/modules/launchpad-discovery/feature.ts";
import { urlAs } from "../../../../core/test/fixtures/modules/database/role-fixtures.ts";
import { freshTestDatabase } from "../../../../core/test/fixtures/modules/database/template.ts";
import { createAdminBondingFeatureRoute } from "./admin-feature.ts";

const databaseUrl = process.env.MISSION_CONTROL_TEST_DATABASE_URL;
test("multiple banner pins: eligible lifecycles, idempotence, stable ordering, independent removal and replica permissions", {
  skip: !databaseUrl,
}, async () => {
  assert.ok(databaseUrl);
  assert.ok(["localhost", "127.0.0.1"].includes(new URL(databaseUrl).hostname));
  const database = await freshTestDatabase();
  const admin = createPool(database.url, { max: 1 });
  const web = createPool(urlAs(database.url, "blast_web"), {
    max: 1,
  });
  const replica = createPool(
    urlAs(database.url, "blast_replica"),
    { max: 1 },
  );
  const route = createAdminBondingFeatureRoute(() => web);
  const id = (n: number) => `0x${n.toString(16).padStart(64, "0")}`;
  const headers = { "content-type": "application/json" };
  const change = (launch_id: string, pinned: boolean) =>
    route(
      new Request("https://backend.test/api/admin/bonding-feature", {
        method: "POST",
        headers,
        body: JSON.stringify({ launch_id, pinned }),
      }),
    );
  const list = (query = "") =>
    route(
      new Request(`https://backend.test/api/admin/bonding-feature${query}`, {
        headers,
      }),
    );
  try {
    for (const n of [1, 2]) {
      const coin = `${id(n + 10)}::curve::CURVE`;
      await admin.query(
        `INSERT INTO coins (coin_type, decimals, launcher, metadata, pool_key, created_checkpoint, created_at_ms)
        VALUES ($1, 9, 'blast', '{"name":"Curve","symbol":"CURVE"}', $2, 1, 1000)`,
        [coin, `blast_curve:${id(n)}`],
      );
      await admin.query(
        `INSERT INTO pools (pool_key, venue, coin_type, quote_type, lifecycle, created_checkpoint, created_at_ms)
        VALUES ($1, 'blast_curve', $2, '0x2::sui::SUI', 'live', 1, 1000)`,
        [`blast_curve:${id(n)}`, coin],
      );
    }
    assert.equal((await list()).status, 200);
    const candidates = (await (await list()).json()).curves;
    assert.ok(
      [1, 2].every((n) =>
        candidates.some(
          (row: { launch_id: string }) => row.launch_id === id(n),
        ),
      ),
    );
    assert.equal((await change(id(99), true)).status, 404);
    for (const lifecycle of ["opening_round", "live", "migration_ready"]) {
      await admin.query("UPDATE pools SET lifecycle = $1 WHERE pool_key = $2", [
        lifecycle,
        `blast_curve:${id(1)}`,
      ]);
      assert.equal((await change(id(1), true)).status, 200);
      assert.deepEqual(await readBondingFeatures(replica), [id(1)]);
    }
    assert.equal((await change(id(2), true)).status, 200);
    assert.deepEqual(await readBondingFeatures(replica), [id(2), id(1)]);
    assert.equal(
      (await change(id(1), true)).status,
      200,
      "repinning is idempotent",
    );
    assert.deepEqual(
      await readBondingFeatures(replica),
      [id(2), id(1)],
      "repinning keeps editorial order",
    );
    const found = await (await list(`?id=${id(1)}`)).json();
    assert.equal(found.curves[0].launch_id, id(1));
    assert.deepEqual(
      found.featured_launch_ids,
      [id(2), id(1)],
      "search preserves all saved pins",
    );
    assert.equal(
      (
        await admin.query(
          "SELECT count(*)::int AS n FROM mission_control_bonding_feature",
        )
      ).rows[0].n,
      2,
    );
    assert.equal(
      (await change(id(1), false)).status,
      200,
      "removing one pin preserves the other",
    );
    assert.deepEqual(await readBondingFeatures(replica), [id(2)]);
    await admin.query(
      "UPDATE pools SET lifecycle = 'migrated' WHERE pool_key = $1",
      [`blast_curve:${id(2)}`],
    );
    assert.deepEqual(
      await readBondingFeatures(replica, true),
      [id(2)],
      "public reads keep a pin after graduation",
    );
    assert.equal((await change(id(2), false)).status, 200);
    const graduated = await (await list(`?id=${id(2)}`)).json();
    assert.equal(graduated.curves[0]?.launch_id, id(2));
    assert.equal(graduated.curves[0]?.lifecycle, "migrated");
    assert.equal((await change(id(2), true)).status, 200);
    assert.deepEqual(
      await readBondingFeatures(replica, true),
      [id(2)],
      "an already graduated curve can be pinned",
    );
    assert.equal((await change(id(2), false)).status, 200);
    assert.deepEqual(await readBondingFeatures(replica), []);
    await assert.rejects(
      replica.query("DELETE FROM mission_control_bonding_feature"),
      /permission denied/,
    );
  } finally {
    await Promise.all([admin.end(), web.end(), replica.end()]);
    await database.drop();
  }
});
