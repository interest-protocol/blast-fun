import assert from "node:assert/strict";
import test from "node:test";
import type { ClientWithCoreApi } from "@mysten/sui/client";
import { adminPool, freshDatabase, watcherPool, DEPLOYMENT, FINGERPRINT } from "../../../test/fixtures/modules/coin-registration/testing.ts";
import { leases } from "../worker-runtime/lease.ts";
import { boundedProvider } from "../worker-runtime/provider.ts";
import { recordDue, dueCandidates, type KeeperContext } from "./actions.ts";
import { keeperActionJob } from "./jobs.ts";
const url = process.env.MISSION_CONTROL_TEST_DATABASE_URL;
test("hourly vault cadence survives restart and advances failed rows fairly", { skip: !url }, async () => {
  const database = await freshDatabase();
  const admin = adminPool(database.url); const watcher = watcherPool(database.url);
  try {
    // This view is the indexer's public contract; no product data or account rows are reset by the job.
    await admin.query("DROP VIEW chain_read_v1.vaults");
    await admin.query("CREATE VIEW chain_read_v1.vaults AS SELECT * FROM (VALUES ('0x0000000000000000000000000000000000000000000000000000000000000001','0xa::m::M','0x2::sui::SUI','0x11','launch','0xa::blast_fun::PackageWitness','0xb::cetus::Witness','0x21'),('0x0000000000000000000000000000000000000000000000000000000000000002','0xa::m::M','0x2::sui::SUI','0x12','presale','0xc::blast_presale_package::PackageWitness','0xb::cetus::Witness','0x22')) v(vault_id,meme_type,quote_type,origin_id,origin_kind,package_witness,venue_type,pool_id)");
    await admin.query("GRANT SELECT ON chain_read_v1.vaults TO blast_watcher");
    const context = { pool: watcher, deployment: { network: "mainnet" }, fingerprint: FINGERPRINT, config: { batchSize: 1 } } as KeeperContext;
    assert.equal((await dueCandidates(context, "vault-fees"))[0]!.object_id, "0x0000000000000000000000000000000000000000000000000000000000000001");
    await recordDue(watcher, { network: "mainnet", fingerprint: FINGERPRINT, kind: "vault-fees", objectId: "0x0000000000000000000000000000000000000000000000000000000000000001" }, 3600000, "simulation-failed");
    assert.equal((await dueCandidates({ ...context }, "vault-fees"))[0]!.object_id, "0x0000000000000000000000000000000000000000000000000000000000000002");
    assert.equal((await dueCandidates({ ...context, fingerprint: "f".repeat(64) }, "vault-fees"))[0]!.object_id, "0x0000000000000000000000000000000000000000000000000000000000000001");
    const scope = { network: "mainnet", fingerprint: FINGERPRINT, kind: "vault-fees" as const, objectId: "0x0000000000000000000000000000000000000000000000000000000000000001" };
    const attempts = async () => Number((await admin.query("SELECT attempts FROM blast_keeper_actions WHERE object_id=$1", [scope.objectId])).rows[0].attempts);
    assert.equal(await attempts(), 0, "a no-op visit does not count as a failure");
    await recordDue(watcher, scope, 3600000, "awaiting-effects", "digest");
    assert.equal(await attempts(), 0, "beforeSubmit does not count an attempt");
    await recordDue(watcher, scope, 3600000, "simulation-failed", null, "failed");
    assert.equal(await attempts(), 1);
    await recordDue(watcher, scope, 3600000, "simulation-failed", null, "failed");
    assert.equal(await attempts(), 2);
    await recordDue(watcher, scope, 3600000, null, "executed-digest", "executed");
    assert.equal(await attempts(), 0, "confirmed execution resets failure backoff");
    const stored = await admin.query("SELECT next_check_at > now()+interval '59 minutes' AS hourly,error_class FROM blast_keeper_actions");
    assert.equal(stored.rows[0].hourly, true); assert.equal(stored.rows[0].error_class, null);
    await admin.query("DROP VIEW chain_read_v1.presales CASCADE");
    await admin.query("CREATE VIEW chain_read_v1.presales AS SELECT * FROM (VALUES ('0x31','0xa::m::M','0x2::sui::SUI','migrated','0x99'),('0x32','0xa::m::M','0x2::sui::SUI','migrated','0x99')) p(presale_id,sale_token,quote_type,lifecycle,partner_id)");
    await admin.query(`CREATE VIEW chain_read_v1.protocol_fee_ledgers AS SELECT * FROM (VALUES
      ('vault','0x11','0xa::m::M','0x2::sui::SUI','0x99',10::numeric,0::numeric,0::numeric,5::numeric,0::numeric,0::numeric,4::numeric,0::numeric,0::numeric),
      ('vault','0x12','0xa::m::M','0x2::sui::SUI','0x99',10,0,0,5,0,0,5,0,0),
      ('presale','0x31','0xa::m::M','0x2::sui::SUI','0x99',0,10,0,0,5,0,0,4,0),
      ('presale','0x32','0xa::m::M','0x2::sui::SUI','0x99',0,10,0,0,5,0,0,5,0)
      ) l(kind,origin_id,meme_type,quote_type,partner_id,accrued_meme,accrued_quote,accrued_sui,treasury_paid_meme,treasury_paid_quote,treasury_paid_sui,partner_paid_meme,partner_paid_quote,partner_paid_sui)`);
    await admin.query("GRANT SELECT ON chain_read_v1.presales,chain_read_v1.protocol_fee_ledgers TO blast_watcher");
    assert.deepEqual((await dueCandidates(context, "vault-partner")).map((row) => row.object_id), [scope.objectId]);
    assert.deepEqual((await dueCandidates(context, "presale-partner")).map((row) => row.object_id), ["0x31"]);
  } finally { await watcher.end(); await admin.end(); await database.drop(); }
});

test("failed vault fee visits defer for an hour and a fresh job advances the next vault", { skip: !url }, async () => {
  const database = await freshDatabase();
  const admin = adminPool(database.url);
  const watcher = watcherPool(database.url);
  try {
    await admin.query("DROP VIEW chain_read_v1.vaults");
    await admin.query(`CREATE VIEW chain_read_v1.vaults AS SELECT * FROM (VALUES
      ('0x0000000000000000000000000000000000000000000000000000000000000001','0xa::m::M','0x2::sui::SUI','0x11','launch','0xa::blast_fun::PackageWitness','0xb::cetus::Witness','0x21'),
      ('0x0000000000000000000000000000000000000000000000000000000000000002','0xa::m::M','0x2::sui::SUI','0x12','presale','0xc::blast_presale_package::PackageWitness','0xb::cetus::Witness','0x22')
      ) v(vault_id,meme_type,quote_type,origin_id,origin_kind,package_witness,venue_type,pool_id)`);
    await admin.query("GRANT SELECT ON chain_read_v1.vaults TO blast_watcher");

    const reads: string[][] = [];
    const client = { core: { getObjects: async ({ objectIds }: { objectIds: string[] }) => {
      reads.push([...objectIds]);
      return { objects: [] };
    } } } as unknown as ClientWithCoreApi;
    const context = (holder: string): KeeperContext => {
      const fixture = {
        pool: watcher,
        deployment: DEPLOYMENT,
        fingerprint: FINGERPRINT,
        config: { batchSize: 1 },
        client,
        leases: leases(watcher, holder, 8000),
        provider: boundedProvider(1000),
        canSign: () => true,
        backoffMs: () => 1,
        log: () => {},
        submit: async () => assert.fail("an unreadable vault must never submit a transaction"),
      } satisfies Partial<Omit<KeeperContext, "config" | "deployment">> & {
        config: Pick<KeeperContext["config"], "batchSize">;
        deployment: typeof DEPLOYMENT;
      };
      // Missing objects stop before signing; assert the RPC IDs below so an
      // unrelated error from this partial context cannot satisfy the test.
      return fixture as unknown as KeeperContext;
    };
    const schedule = async () => (await admin.query(`
      SELECT object_id,attempts,error_class,
        extract(epoch FROM (next_check_at-updated_at))::text AS delay_seconds
      FROM blast_keeper_actions ORDER BY object_id`)).rows;

    assert.deepEqual(await keeperActionJob("vault-fees").run(context("00000000-0000-4000-8000-000000000001")), { blocked: null });
    assert.deepEqual(reads, [["0x0000000000000000000000000000000000000000000000000000000000000001"]]);
    const first = {
      object_id: "0x0000000000000000000000000000000000000000000000000000000000000001",
      attempts: 1,
      error_class: "keeper-action-unavailable",
      delay_seconds: "3600.000000",
    };
    assert.deepEqual(await schedule(), [first]);

    assert.deepEqual(await keeperActionJob("vault-fees").run(context("00000000-0000-4000-8000-000000000002")), { blocked: null });
    assert.deepEqual(reads, [
      ["0x0000000000000000000000000000000000000000000000000000000000000001"],
      ["0x0000000000000000000000000000000000000000000000000000000000000002"],
    ]);
    assert.deepEqual(await schedule(), [first, {
      object_id: "0x0000000000000000000000000000000000000000000000000000000000000002",
      attempts: 1,
      error_class: "keeper-action-unavailable",
      delay_seconds: "3600.000000",
    }]);
  } finally {
    await watcher.end();
    await admin.end();
    await database.drop();
  }
});
