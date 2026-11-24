import assert from "node:assert/strict";
import test from "node:test";
import { adminPool, freshDatabase, watcherPool } from "../../../test/fixtures/modules/coin-registration/testing.ts";
import { discoverVaults } from "./infra.ts";
import { recordVaults } from "./repository.ts";

const databaseUrl = process.env.MISSION_CONTROL_TEST_DATABASE_URL;

test("committed vault discovery covers both products and resumes a bounded pass without repeating known vaults", { skip: databaseUrl ? false : "MISSION_CONTROL_TEST_DATABASE_URL is not set" }, async (t) => {
  const database = await freshDatabase();
  const admin = adminPool(database.url);
  const watcher = watcherPool(database.url);
  t.after(async () => {
    await Promise.all([admin.end(), watcher.end()]);
    await database.drop();
  });
  // These columns are the indexer's final lineage-reset views. The application
  // fixture contains an older reduced vault projection, so this suite supplies
  // the final read contract in its disposable database.
  await admin.query(`
    DROP VIEW chain_read_v1.vaults CASCADE;
    DROP VIEW chain_read_v1.watermark CASCADE;
    CREATE TABLE buyback_fixture_vaults (
      vault_id text PRIMARY KEY, origin_id text NOT NULL, origin_kind text NOT NULL,
      package_witness text NOT NULL, venue_type text NOT NULL, meme_type text NOT NULL,
      quote_type text NOT NULL, venue text NOT NULL, pool_id text NOT NULL
    );
    CREATE TABLE buyback_fixture_pool_tiers (
      meme_type text PRIMARY KEY, quote_type text NOT NULL, venue text NOT NULL,
      tick_spacing bigint NOT NULL, fee_rate numeric(20,0)
    );
    CREATE TABLE buyback_fixture_watermark (
      network text NOT NULL, deployment_fingerprint text NOT NULL,
      checkpoint bigint, lag_ms bigint
    );
    CREATE VIEW chain_read_v1.vaults AS SELECT * FROM buyback_fixture_vaults;
    CREATE VIEW chain_read_v1.pool_tiers AS SELECT * FROM buyback_fixture_pool_tiers;
    CREATE VIEW chain_read_v1.watermark AS SELECT * FROM buyback_fixture_watermark;
    GRANT SELECT ON chain_read_v1.vaults,chain_read_v1.pool_tiers,chain_read_v1.watermark TO blast_watcher;
    INSERT INTO buyback_fixture_watermark VALUES ('mainnet','fixture-final',1000,0);
    INSERT INTO buyback_fixture_vaults
      SELECT '0x'||lpad(n::text,64,'0'),'0x'||lpad((n+200)::text,64,'0'),
             CASE WHEN n%2=0 THEN 'launch' ELSE 'presale' END,
             CASE WHEN n%2=0 THEN 'fun::PackageWitness' ELSE 'presale::PackageWitness' END,
             CASE WHEN n%2=0 THEN 'migrators::cetus::Venue' ELSE 'migrators::bluefin::Venue' END,
             'meme-'||n,'quote',CASE WHEN n%2=0 THEN 'cetus' ELSE 'bluefin' END,'0x'||lpad((n+400)::text,64,'0')
      FROM generate_series(1,102) AS n;
    INSERT INTO buyback_fixture_pool_tiers
      SELECT meme_type,quote_type,venue,60,CASE WHEN venue='bluefin' THEN 2500 ELSE NULL END
      FROM buyback_fixture_vaults;
  `);

  assert.deepEqual(await discoverVaults(watcher, "mainnet", "foreign", 60_000, 1), { vaults: [], complete: true });
  const first = await discoverVaults(watcher, "mainnet", "fixture-final", 60_000, 1);
  assert.equal(first.vaults.length, 100);
  assert.equal(first.complete, false);
  assert.deepEqual(new Set(first.vaults.map((vault) => vault.packageWitness)), new Set(["fun::PackageWitness", "presale::PackageWitness"]));
  assert.equal(first.vaults.find((vault) => vault.venue === "cetus")?.poolFeeRate, null);
  assert.equal(first.vaults.find((vault) => vault.venue === "bluefin")?.poolFeeRate, 2500n);
  assert.equal(await recordVaults(watcher, "mainnet", first.vaults), 100);
  const second = await discoverVaults(watcher, "mainnet", "fixture-final", 60_000, 1);
  assert.equal(second.vaults.length, 2);
  assert.equal(second.complete, true);
  assert.ok(second.vaults.every((vault) => !first.vaults.some((known) => known.vaultId === vault.vaultId)));
  await admin.query("UPDATE buyback_fixture_watermark SET lag_ms=60001");
  assert.deepEqual(await discoverVaults(watcher, "mainnet", "fixture-final", 60_000, 1), { vaults: [], complete: true });
  await admin.query("UPDATE buyback_fixture_watermark SET lag_ms=0,checkpoint=NULL");
  assert.deepEqual(await discoverVaults(watcher, "mainnet", "fixture-final", 60_000, 1), { vaults: [], complete: true });
});
