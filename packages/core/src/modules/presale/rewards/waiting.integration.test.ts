import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { Pool } from "pg";

import { migrateDatabase } from "@blast/core/modules/database/migrations.ts";
import { withTransaction } from "@blast/core/modules/database/transaction.ts";
import {
  CHAIN_FIXTURE,
  FIXTURE_CHECKPOINT,
  FIXTURE_FINGERPRINT,
  urlAs,
} from "../../../../test/fixtures/modules/database/role-fixtures.ts";
import { postgresPublishedManifests } from "./manifests.ts";
import { waitingRewardsFor } from "./waiting.ts";

const source = process.env.MISSION_CONTROL_TEST_DATABASE_URL;
const address = (n: number) => `0x${n.toString(16).padStart(64, "0")}`;

test("vault reward readers serve verified manifests and only unpaid allocations for either product", { skip: !source }, async (t) => {
  const admin = new Pool({ connectionString: source, max: 1 });
  const database = `vault_reward_reads_${randomUUID().replaceAll("-", "")}`;
  await admin.query(`CREATE DATABASE ${database}`);
  const url = new URL(source!);
  url.pathname = `/${database}`;
  const db = new Pool({ connectionString: String(url), max: 1 });
  const social = new Pool({ connectionString: urlAs(String(url), "blast_social"), max: 1 });
  const previous = { network: process.env.BLAST_NETWORK, fingerprint: process.env.BLAST_DEPLOYMENT_FINGERPRINT };
  t.after(async () => {
    if (previous.network === undefined) delete process.env.BLAST_NETWORK;
    else process.env.BLAST_NETWORK = previous.network;
    if (previous.fingerprint === undefined) delete process.env.BLAST_DEPLOYMENT_FINGERPRINT;
    else process.env.BLAST_DEPLOYMENT_FINGERPRINT = previous.fingerprint;
    await Promise.all([db.end(), social.end()]);
    await admin.query(`DROP DATABASE ${database}`);
    await admin.end();
  });
  process.env.BLAST_NETWORK = "mainnet";
  process.env.BLAST_DEPLOYMENT_FINGERPRINT = FIXTURE_FINGERPRINT;

  await db.query(CHAIN_FIXTURE);
  await migrateDatabase(db);
  // The migration can apply before the replay exposes the new relations.
  await db.query(`
    ALTER TABLE blast_infra_fixture.vault_rounds
      ADD COLUMN start_checkpoint NUMERIC, ADD COLUMN end_checkpoint NUMERIC,
      ADD COLUMN claim_deadline_at_ms NUMERIC, ADD COLUMN root TEXT, ADD COLUMN manifest_digest TEXT,
      ADD COLUMN leaf_count NUMERIC, ADD COLUMN meme_amount NUMERIC, ADD COLUMN quote_amount NUMERIC,
      ADD COLUMN treasury TEXT, ADD COLUMN gas_reserve_amount NUMERIC, ADD COLUMN closed BOOLEAN,
      ADD COLUMN published_checkpoint BIGINT, ADD COLUMN published_timestamp_ms BIGINT;
    CREATE OR REPLACE VIEW chain_read_v1.vault_rounds AS SELECT * FROM blast_infra_fixture.vault_rounds;
    INSERT INTO blast_infra_fixture.checkpoint_headers SELECT checkpoint,digest,timestamp_ms FROM checkpoint_journal;
  `);

  const wallet = address(201);
  const hash = "a".repeat(64);
  const treasury = address(202);
  const deadline = 2_000_000_000_000;
  const meme = `${address(20)}::meme::MEME`;
  const quote = `${address(2)}::sui::SUI`;
  async function publishedRound(kind: "presale" | "launch", id: number) {
    const period = randomUUID();
    const plan = randomUUID();
    const vault = address(id);
    const round = address(id + 1);
    const origin = address(id + 2);
    const manifest = {
      vaultId: vault,
      number: "0",
      startCheckpoint: "1000",
      endCheckpoint: "1001",
      root: hash,
      manifestDigest: hash,
      leafCount: 1,
      memeAmount: "3",
      quoteAmount: "10",
    };
    const storage = `https://fixture.example/${round}`;
    await db.query(`INSERT INTO vault_reward_periods(period_id,network,deployment_fingerprint,vault_id,start_ms,end_ms)
      VALUES($1,'mainnet',$2,$3,0,1000)`, [period, FIXTURE_FINGERPRINT, vault]);
    await db.query(`INSERT INTO vault_reward_plans(plan_id,period_id,number,stage,inputs,manifest,storage_url,storage_hash,storage_verified_at)
      VALUES($1,$2,0,'published',$3,$4,$5,$6,now())`, [
      plan, period, { originId: origin, memeType: meme, quoteType: quote, treasury, reserve: "0" }, manifest, storage, hash,
    ]);
    await db.query(`INSERT INTO vault_reward_allocations(plan_id,leaf_index,beneficiary,meme_amount,quote_amount)
      VALUES($1,0,$2,3,10)`, [plan, wallet]);
    await db.query(`INSERT INTO blast_infra_fixture.vaults(vault_id,origin_kind,origin_id,meme_type,quote_type,venue_type,pool_id,created_checkpoint)
      VALUES($1,$2,$3,$4,$5,'cetus::Venue',$6,1000)`, [vault, kind, origin, meme, quote, address(id + 3)]);
    await db.query(`INSERT INTO blast_infra_fixture.vault_rounds
      VALUES($1,$2,0,1000,1001,$3,$4,$4,1,3,10,$5,0,false,$6,$7)`, [round, vault, deadline, hash, treasury, FIXTURE_CHECKPOINT, deadline - 1_000]);
    return { plan, vault, round, origin, storage };
  }

  const sale = await publishedRound("presale", 100);
  const launch = await publishedRound("launch", 110);
  const manifests = postgresPublishedManifests(social);
  const waiting = (owners: readonly string[] = [wallet]) => withTransaction(
    social,
    (tx) => waitingRewardsFor(tx, "mainnet", owners),
    { isolationLevel: "REPEATABLE READ" },
  );

  assert.equal(await manifests.publishedManifestUrl(sale.round), sale.storage);
  assert.equal(await manifests.publishedManifestUrl(launch.round), launch.storage);
  assert.equal(await manifests.publishedManifestUrl(address(99)), null);
  assert.deepEqual(await waiting([address(99)]), []);
  assert.deepEqual((await waiting()).map(({ presaleId, vaultId, allocations }) => [
    presaleId, vaultId, allocations[0]?.memeAmount, allocations[0]?.quoteAmount, allocations[0]?.reason,
  ]), [[sale.origin, sale.vault, "3", "10", "next"], [address(0), launch.vault, "3", "10", "next"]]);

  await db.query(`INSERT INTO blast_infra_fixture.vault_reward_payouts
    VALUES($1,0,$2,$3,3,10,$4,1,2,$5,$6,NULL)`, [sale.round, sale.vault, wallet, FIXTURE_CHECKPOINT, deadline - 100, hash]);
  assert.deepEqual((await waiting()).map((group) => group.vaultId), [launch.vault]);
  await db.query("UPDATE blast_infra_fixture.vault_rounds SET closed=true WHERE round_id=$1", [launch.round]);
  assert.deepEqual(await waiting(), []);
  assert.equal(await manifests.publishedManifestUrl(launch.round), launch.storage);
  await db.query("UPDATE blast_infra_fixture.vault_rounds SET closed=false,quote_amount=11 WHERE round_id=$1", [launch.round]);
  assert.equal(await manifests.publishedManifestUrl(launch.round), null);
  assert.deepEqual(await waiting(), []);
  await assert.rejects(social.query("SELECT * FROM vault_reward_allocations"), /permission denied/);
  await assert.rejects(social.query("SELECT vault_waiting_rewards($1,$2,$3)", ["mainnet", FIXTURE_FINGERPRINT, Array(51).fill(wallet)]), /invalid.*scope/);
  process.env.BLAST_DEPLOYMENT_FINGERPRINT = "d".repeat(64);
  assert.equal(await manifests.publishedManifestUrl(sale.round), null);
  await assert.rejects(waiting(), /coverage unavailable/);
});
