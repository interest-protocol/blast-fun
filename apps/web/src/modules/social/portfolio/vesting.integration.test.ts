import assert from "node:assert/strict";
import test from "node:test";
import pg from "pg";
import { migrateDatabase } from "@blast/core/modules/database/migrations.ts";
import { createPool } from "@blast/core/modules/database/pool.ts";
import type { ReadableDatabase } from "@blast/core/modules/database/transaction.ts";
import { assemblePortfolio } from "@blast/server/modules/social/portfolio/route.ts";
import { createSocialValidator } from "@blast/core/modules/social/contracts/validate.ts";
import { isSocialPortfolio } from "#web/components/social/portfolio-client.ts";
import { readPortfolioVesting } from "@blast/server/modules/social/portfolio/holdings.ts";
import { createVestingReads } from "@blast/server/modules/vesting/read.ts";

const databaseUrl = process.env.MISSION_CONTROL_TEST_DATABASE_URL;
const address = (n: number) => `0x${n.toString(16).padStart(64, "0")}`;

test("portfolio discovers the active wallet's covered receiving and created schedules without claiming another wallet's receipts", { skip: !databaseUrl }, async t => {
  assert.ok(databaseUrl);
  const pool = createPool(databaseUrl, { max: 1 });
  try {
    await migrateDatabase(pool);
  } finally {
    await pool.end();
  }

  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  await client.query("BEGIN");
  t.after(async () => { await client.query("ROLLBACK"); await client.end(); });
  await client.query(`CREATE TABLE chain_read_v1.audit_vesting_coverage (
    pipeline text, network text, fault_checkpoint bigint, checkpoint bigint
  )`);
  await client.query(`CREATE TABLE chain_read_v1.utility_vesting_schedules (
    schedule_id text PRIMARY KEY, coin_type text, beneficiary text, creator text,
    total numeric, released numeric, refunded numeric, refund_recipient text,
    cancel_cap_id text, terms jsonb, kind text, status text,
    created_timestamp_ms bigint, created_digest text, coin_name text,
    coin_symbol text, coin_decimals int, coin_icon_url text,
    applied_checkpoint bigint, created_checkpoint bigint
  )`);
  await client.query("GRANT SELECT ON chain_read_v1.audit_vesting_coverage TO PUBLIC");
  await client.query(`CREATE OR REPLACE VIEW chain_read_v1.projection_coverage AS SELECT
    pipeline, network, 'fixture'::text AS deployment_fingerprint, checkpoint,
    1::bigint AS timestamp_ms, 'fixture'::text AS checkpoint_digest,
    1::bigint AS first_checkpoint, fault_checkpoint, NULL::text AS fault_event_type,
    NULL::text AS fault_reason FROM chain_read_v1.audit_vesting_coverage`);
  await client.query("INSERT INTO chain_read_v1.audit_vesting_coverage VALUES ('vesting','mainnet',NULL,100)");
  const db: ReadableDatabase = { read: (sql, values) => client.query(sql, values ? [...values] : []) };
  const reads = createVestingReads({ database: () => db,
    client: { getVesting: async () => { throw new Error("No chain access in indexed fixture"); } },
    metadata: async () => { throw new Error("No metadata access in indexed fixture"); }, now: () => 10_001 });
  const active = address(2002);
  const linked = address(2003);
  const other = address(2004);
  const terms = { action: "create", start_ms: "1", cliff_ms: "0", period_ms: "1000", periods: "10" };
  const summary = () => readPortfolioVesting(db, [active, linked], () => reads.walletVestings(active));
  const seed = (id: number, beneficiary: string, creator: string, checkpoint = 100) => client.query(`
    INSERT INTO chain_read_v1.utility_vesting_schedules VALUES
    ($1,'0x2::aftest::AFTEST',$2,$3,81297878320681999,0,0,NULL,NULL,$4,'linear','active',1,'fixture','AFTEST','AFTEST',9,NULL,$5,1)`,
  [address(id), beneficiary, creator, JSON.stringify(terms), checkpoint]);
  await t.test("receiving-only is discoverable through the portfolio schedule link", async () => {
    await seed(2010, active, other);
    assert.deepEqual(await summary(), { has_schedule: true, href: "/portfolio/vestings" });
    assert.equal((await reads.walletVestings(active)).length, 1);
    const response = await assemblePortfolio({ db, accountId: "00000000-0000-0000-0000-000000002002",
      addresses: [active, linked], now: () => 10_001, view: "summary", utilityVestings: () => reads.walletVestings(active) });
    assert.deepEqual(response.vesting, { has_schedule: true, href: "/portfolio/vestings" });
    assert.deepEqual(createSocialValidator().validate("portfolio-response", response).errors, []);
    assert.equal(isSocialPortfolio(response), true);
  });
  await t.test("created-only is discoverable without becoming a receivable", async () => {
    await client.query("DELETE FROM chain_read_v1.utility_vesting_schedules");
    await seed(2011, other, active);
    assert.deepEqual(await summary(), { has_schedule: true, href: "/portfolio/vestings" });
    assert.equal((await reads.walletVestings(active)).filter(row => row.beneficiary === active).length, 0);
  });
  await t.test("overlapping created and receiving membership yields one schedule", async () => {
    await client.query("DELETE FROM chain_read_v1.utility_vesting_schedules");
    await seed(2012, active, active);
    assert.equal((await reads.walletVestings(active)).length, 1);
    assert.deepEqual(await summary(), { has_schedule: true, href: "/portfolio/vestings" });
  });
  await t.test("another linked wallet and uncovered rows do not widen the active wallet list", async () => {
    await client.query("DELETE FROM chain_read_v1.utility_vesting_schedules");
    await seed(2013, linked, linked);
    await seed(2014, active, active, 101);
    assert.equal((await reads.walletVestings(active)).length, 0);
    assert.deepEqual(await summary(), { has_schedule: false, href: null });
  });
  await t.test("unavailable coverage remains an error rather than a false empty summary", async () => {
    await client.query("DELETE FROM chain_read_v1.audit_vesting_coverage");
    await assert.rejects(summary(), { reason: "index_unavailable" });
  });
});
