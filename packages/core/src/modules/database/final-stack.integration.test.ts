import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import type { Pool } from "pg";
import { migrateDatabase } from "./migrations.ts";
import { TABLE_OWNERSHIP } from "./modules.ts";
import { createPool } from "./pool.ts";
import { CHAIN_FIXTURE, ROLES, resetSharedDatabase, urlAs } from "../../../test/fixtures/modules/database/role-fixtures.ts";

const databaseUrl = process.env.MISSION_CONTROL_TEST_DATABASE_URL;
const skip = databaseUrl ? false : "MISSION_CONTROL_TEST_DATABASE_URL is not set";
const address = `0x${"ab".repeat(32)}`;
const digest = "4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi";

async function fresh(pool: Pool, through?: string): Promise<void> {
  await resetSharedDatabase(pool);
  await pool.query(CHAIN_FIXTURE);
  await migrateDatabase(pool, through ? { through } : undefined);
}

async function snapshot(pool: Pool, tables: readonly string[]): Promise<Record<string, unknown>> {
  const result: Record<string, unknown> = {};
  for (const table of tables) {
    assert.match(table, /^[a-z_]+$/);
    result[table] = (await pool.query(`SELECT jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text) AS rows FROM ${table} t`)).rows[0].rows;
  }
  return result;
}

test("0153 preserves Blast accounts, account-linked data, open transaction custody and human release evidence", { skip }, async (t) => {
  assert.ok(databaseUrl);
  const owner = createPool(databaseUrl, { max: 1 });
  t.after(() => owner.end());
  await fresh(owner, "0152_reward_round_notice");
  const profiles = [randomUUID(), randomUUID()];
  const invitation = randomUUID();
  const social = randomUUID();
  for (const [index, profile] of profiles.entries()) {
    await owner.query(`INSERT INTO mission_control_profiles
      (profile_id,privy_did,x_subject,sui_address,provider_wallet_reference,callsign,disclosure_version,disclosure_accepted_at)
      VALUES ($1,$2,$3,$4,$5,$6,'fixture',now())`,
    [profile, `did:privy:preserve${index}`, `fixture-x-${index}`, `0x${String(index + 1).repeat(64)}`, `fixture-wallet-${index}`, `preserve_${index}`]);
  }
  await owner.query(`INSERT INTO mission_control_account_identities(profile_id,provider,provider_subject,verified_at)
    VALUES ($1,'privy','did:privy:preserve0',now())`, [profiles[0]]);
  await owner.query(`INSERT INTO mission_control_account_wallets(wallet_id,profile_id,wallet_kind,sui_address,provider_wallet_reference,is_primary,verified_at)
    VALUES ($1,$2,'embedded',$3,'fixture-account-wallet',TRUE,now())`, [randomUUID(), profiles[0], address]);
  await owner.query(`INSERT INTO mission_control_invitation_codes
    (code_id,season_id,lookup_key_version,lookup_hmac,encrypted_display,encryption_iv,encryption_tag,encryption_key_version,code_kind,owner_profile_id)
    VALUES ($1,'season-zero','fixture',repeat('a',64),'fixture-display','fixture-iv','fixture-tag','fixture','member',$2)`, [invitation, profiles[0]]);
  await owner.query(`INSERT INTO mission_control_referrals(recruited_profile_id,referrer_profile_id,source_code_id,created_at)
    VALUES ($1,$2,$3,now())`, [profiles[1], profiles[0], invitation]);
  await owner.query(`INSERT INTO social_accounts(account_id,profile_id,privacy) VALUES ($1,$2,'private')`, [social, profiles[0]]);
  await owner.query(`INSERT INTO social_account_wallets(address,account_id,verified_at) VALUES ($1,$2,now())`, [address, social]);
  await owner.query(`INSERT INTO presale_account_settings(privy_did,explorer,theme) VALUES ('did:privy:preserve0','suiscan','dark')`);
  await owner.query(`INSERT INTO mission_control_worker_submissions
    (digest,signer_address,network,job,intent,transaction_bytes,expires_epoch,submitted_at,record_keys)
    VALUES ($1,$2,'mainnet','launch-migration','{"fixture":"pending"}',decode('010203','hex'),42,now(),ARRAY['fixture-origin'])`, [digest, address]);
  await owner.query(`INSERT INTO mission_control_launchpad_release_gate_checks(network,identity_digest,check_name,passed,evidence)
    VALUES ('mainnet',repeat('b',64),'worker-host',TRUE,'fixture owner evidence')`);
  await owner.query(`INSERT INTO presale_worker_alerts(alert_key,condition_since,updated_at)
    VALUES ('fixture_alert',now(),now())`);
  const ownedTables = [...new Set([
    ...TABLE_OWNERSHIP.profile, ...TABLE_OWNERSHIP.account, ...TABLE_OWNERSHIP.invitation,
    ...TABLE_OWNERSHIP.completion, ...TABLE_OWNERSHIP.social, ...TABLE_OWNERSHIP["presale-settings"],
    "mission_control_worker_submissions",
  ])];
  // Ownership lists the current schema. Snapshot only relations present at 0152.
  const { rows: historicalTables } = await owner.query<{ name: string }>(`
    SELECT name FROM unnest($1::text[]) AS names(name)
    WHERE to_regclass(format('public.%I', name)) IS NOT NULL
  `, [ownedTables]);
  const tables = historicalTables.map(({ name }) => name);
  const before = await snapshot(owner, tables);
  const gate = await snapshot(owner, ["mission_control_launchpad_release_gate_checks"]);
  const alerts = await snapshot(owner, ["presale_worker_alerts"]);
  assert.deepEqual(await migrateDatabase(owner, { through: "0153_final_stack_workers" }), ["0153_final_stack_workers"]);
  assert.deepEqual(await snapshot(owner, tables), before);
  assert.deepEqual((await snapshot(owner, ["mission_control_vault_release_gate_checks"])).mission_control_vault_release_gate_checks,
    gate.mission_control_launchpad_release_gate_checks);
  assert.deepEqual((await snapshot(owner, ["blast_worker_alerts"])).blast_worker_alerts, alerts.presale_worker_alerts);
  await migrateDatabase(owner);
  assert.deepEqual(await migrateDatabase(owner), []);
  assert.equal((await owner.query("SELECT count(*)::int AS count FROM vault_reward_actions")).rows[0].count, 0);
});

test("fresh worker tables expose exactly the intended roles, with no public, web, social or replica grants", { skip }, async (t) => {
  assert.ok(databaseUrl);
  const owner = createPool(databaseUrl, { max: 1 });
  t.after(() => owner.end());
  await fresh(owner);
  const planning = ["vault_reward_periods", "vault_reward_plans", "vault_reward_holders", "vault_reward_allocations", "vault_reward_hashes"];
  const expected: Record<string, string[]> = Object.fromEntries(planning.map((table) => [table, ["blast_indexer:INSERT,SELECT,UPDATE", "blast_watcher:INSERT,SELECT,UPDATE"]]));
  for (const table of ["vault_reward_actions", "vault_reward_gas_effects"]) expected[table] = ["blast_indexer:SELECT", "blast_watcher:INSERT,SELECT,UPDATE"];
  for (const table of ["blast_keeper_actions", "mission_control_vault_buybacks"]) expected[table] = ["blast_watcher:INSERT,SELECT,UPDATE"];
  expected.blast_worker_release_gate_checks = ["blast_watcher:SELECT"];
  expected.blast_worker_alerts = ["blast_indexer:DELETE,INSERT,SELECT,UPDATE", "blast_watcher:DELETE,INSERT,SELECT,UPDATE"];
  for (const [table, grants] of Object.entries(expected)) {
    const { rows } = await owner.query(`SELECT grantee||':'||string_agg(privilege_type,',' ORDER BY privilege_type) AS privileges
      FROM information_schema.role_table_grants WHERE table_schema='public' AND table_name=$1
      AND (grantee=ANY($2) OR grantee='PUBLIC') GROUP BY grantee ORDER BY grantee`, [table, ROLES]);
    assert.deepEqual(rows.map((row) => row.privileges), grants, table);
  }
  const indexer = createPool(urlAs(databaseUrl, "blast_indexer"), { max: 1 });
  t.after(() => indexer.end());
  await indexer.query("INSERT INTO blast_worker_alerts(alert_key,condition_since,updated_at) VALUES ('fixture_planner_alert',now(),now())");
  await indexer.query("UPDATE blast_worker_alerts SET condition_since='2026-01-01T00:00:00Z',updated_at=now() WHERE alert_key='fixture_planner_alert'");
  assert.equal((await indexer.query("SELECT condition_since FROM blast_worker_alerts WHERE alert_key='fixture_planner_alert'")).rows[0].condition_since.toISOString(), "2026-01-01T00:00:00.000Z");
  assert.equal((await indexer.query("DELETE FROM blast_worker_alerts WHERE alert_key='fixture_planner_alert'")).rowCount, 1);
  await assert.rejects(indexer.query("TRUNCATE blast_worker_alerts"), { code: "42501" });
});

test("prepared and signed vault reward custody cannot change, while delivery progress remains writable", { skip }, async (t) => {
  assert.ok(databaseUrl);
  const owner = createPool(databaseUrl, { max: 1 });
  const watcher = createPool(urlAs(databaseUrl, "blast_watcher"), { max: 1 });
  const indexer = createPool(urlAs(databaseUrl, "blast_indexer"), { max: 1 });
  t.after(() => Promise.all([owner.end(), watcher.end(), indexer.end()]));
  await fresh(owner);
  const period = randomUUID();
  const plan = randomUUID();
  const action = randomUUID();
  await indexer.query(`INSERT INTO vault_reward_periods(period_id,network,deployment_fingerprint,vault_id,start_ms,end_ms)
    VALUES ($1,'mainnet',repeat('c',64),$2,0,1000)`, [period, address]);
  await indexer.query(`INSERT INTO vault_reward_plans(plan_id,period_id,number,stage,inputs) VALUES ($1,$2,0,'planned','{}')`, [plan, period]);
  await watcher.query(`INSERT INTO vault_reward_actions(action_id,plan_id,semantic_key,kind,payload,digest,transaction_bytes,signature)
    VALUES ($1,$2,'fixture-action','publish','{"fixture":"bound"}',$3,decode('010203','hex'),'fixture-signature')`, [action, plan, digest]);
  for (const mutation of ["payload='{}'", "digest='changed'", "transaction_bytes=decode('04','hex')", "plan_id=NULL", "kind='replaced'", "semantic_key='changed'", "signature='changed'", "signature=NULL"]) {
    await assert.rejects(watcher.query(`UPDATE vault_reward_actions SET ${mutation} WHERE action_id=$1`, [action]), { code: "P0001" }, mutation);
  }
  await watcher.query("UPDATE vault_reward_actions SET state='delivered' WHERE action_id=$1", [action]);
  assert.equal((await watcher.query("SELECT state FROM vault_reward_actions WHERE action_id=$1", [action])).rows[0].state, "delivered");
  await assert.rejects(watcher.query("DELETE FROM vault_reward_actions WHERE action_id=$1", [action]), { code: "42501" });
  await assert.rejects(indexer.query("UPDATE vault_reward_actions SET state='delivered' WHERE action_id=$1", [action]), { code: "42501" });
  await assert.rejects(watcher.query(`INSERT INTO vault_reward_actions(action_id,plan_id,semantic_key,kind,payload,signature)
    VALUES ($1,$2,'missing-bytes','publish','{}','fixture-signature')`, [randomUUID(), plan]), { code: "23514" });
});

test("generic worker release evidence is append-only for its owner and read-only for workers", { skip }, async (t) => {
  assert.ok(databaseUrl);
  const owner = createPool(databaseUrl, { max: 1 });
  const watcher = createPool(urlAs(databaseUrl, "blast_watcher"), { max: 1 });
  t.after(() => Promise.all([owner.end(), watcher.end()]));
  await fresh(owner);
  await owner.query(`INSERT INTO blast_worker_release_gate_checks(network,identity_digest,check_name,passed,evidence)
    VALUES ('mainnet',repeat('d',64),'worker-host',TRUE,'fixture approval')`);
  assert.equal((await watcher.query("SELECT passed FROM blast_worker_release_gate_checks")).rows[0].passed, true);
  for (const statement of ["UPDATE blast_worker_release_gate_checks SET passed=FALSE", "DELETE FROM blast_worker_release_gate_checks", "TRUNCATE blast_worker_release_gate_checks"]) {
    await assert.rejects(owner.query(statement), { code: "23514" });
    await assert.rejects(watcher.query(statement), { code: "42501" });
  }
  await assert.rejects(watcher.query(`INSERT INTO blast_worker_release_gate_checks(network,identity_digest,check_name,passed,evidence)
    VALUES ('mainnet',repeat('d',64),'worker-host',FALSE,'fixture revoke')`), { code: "42501" });
  await owner.query(`INSERT INTO blast_worker_release_gate_checks(network,identity_digest,check_name,passed,evidence)
    VALUES ('mainnet',repeat('d',64),'worker-host',FALSE,'fixture revocation')`);
  assert.equal((await watcher.query("SELECT passed FROM blast_worker_release_gate_checks ORDER BY id DESC LIMIT 1")).rows[0].passed, false);
});

test("0158 moves the buyback release records into the worker table in order, and refuses to land behind newer records", { skip }, async (t) => {
  assert.ok(databaseUrl);
  const owner = createPool(databaseUrl, { max: 1 });
  t.after(() => owner.end());
  const record = (table: string, digest: string, check: string, passed: boolean, at: string) =>
    owner.query(`INSERT INTO ${table}(network,identity_digest,check_name,passed,evidence,recorded_at) VALUES ('mainnet',$1,$2,$3,$4,$5)`,
      [digest, check, passed, `${check} ${passed ? "passed" : "revoked"}`, at]);
  const [buyback, rotated, keeper] = ["a", "b", "c"].map((letter) => letter.repeat(64));
  const ordered = (where: string) => owner.query(`SELECT network,identity_digest,check_name,passed,evidence,recorded_at
    FROM blast_worker_release_gate_checks WHERE ${where} ORDER BY id`);

  await fresh(owner, "0157_drop_retired_reward_readers");
  await record("blast_worker_release_gate_checks", keeper, "alerts", true, "2026-11-09T10:00:00Z");
  // A revocation, a pass recorded at the same instant as an older one, and a second identity in between.
  for (const [digest, check, passed, at] of [
    [buyback, "buyback-key", true, "2026-11-09T11:00:00Z"],
    [rotated, "buyback-key", true, "2026-11-09T11:00:00Z"],
    [buyback, "buyback-key", false, "2026-11-09T12:00:00Z"],
    [buyback, "buyback-alerts", true, "2026-11-09T12:00:00Z"],
    [buyback, "buyback-key", true, "2026-11-09T12:00:00Z"],
  ] as const) await record("mission_control_vault_release_gate_checks", digest, check, passed, at);
  const moved = (await owner.query(`SELECT network,identity_digest,check_name,passed,evidence,recorded_at
    FROM mission_control_vault_release_gate_checks ORDER BY id`)).rows;
  assert.deepEqual(await migrateDatabase(owner, { through: "0158_one_worker_release_gate" }), ["0158_one_worker_release_gate"]);
  assert.deepEqual((await ordered(`identity_digest <> '${keeper}'`)).rows, moved);
  assert.equal((await ordered(`identity_digest = '${keeper}'`)).rows.length, 1);
  assert.equal((await owner.query("SELECT to_regclass('mission_control_vault_release_gate_checks') AS name")).rows[0].name, null);

  await fresh(owner, "0157_drop_retired_reward_readers");
  await record("mission_control_vault_release_gate_checks", buyback, "buyback-key", true, "2026-11-09T11:00:00Z");
  await record("blast_worker_release_gate_checks", buyback, "buyback-key", false, "2026-11-09T12:00:00Z");
  await assert.rejects(migrateDatabase(owner), /already holds records for a buyback identity/);
  assert.equal((await owner.query("SELECT count(*)::int AS count FROM mission_control_vault_release_gate_checks")).rows[0].count, 1);
});
