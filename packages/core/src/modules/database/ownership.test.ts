import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import type { Pool } from "pg";

import {
  BLAST_INFRA_TABLES,
  CHAIN_READ_VIEWS,
  TABLE_OWNERSHIP,
  assertChainReadThroughViews,
  assertTableOwnership,
} from "./modules.ts";
import { autocommitRead, autocommitWrite, batchedRead, withTransaction } from "./transaction.ts";

test("every web table has exactly one owning module, and no module owns a blast-infra table", () => {
  const owners = new Map<string, string[]>();
  for (const [module, tables] of Object.entries(TABLE_OWNERSHIP)) {
    for (const table of tables) owners.set(table, [...(owners.get(table) ?? []), module]);
  }
  assert.deepEqual([...owners].filter(([, modules]) => modules.length > 1), [], "a table owned twice");
  for (const table of [...BLAST_INFRA_TABLES, ...CHAIN_READ_VIEWS]) {
    assert.equal(owners.has(table), false, table);
    assert.throws(() => assertTableOwnership("chain-read", table), /cannot write table/, table);
  }
  assert.deepEqual(TABLE_OWNERSHIP["chain-read"], [], "chain reads own nothing");
});

test("only the sponsor module owns sponsor reservations", () => {
  assert.doesNotThrow(() => assertTableOwnership("presale-sponsor", "presale_sponsor_reservations"));
  assert.throws(
    () => assertTableOwnership("social", "presale_sponsor_reservations"),
    /cannot write table/,
  );
});

test("chain reads name only blast-infra's versioned views, never its tables or a retired contract", () => {
  for (const allowed of [
    "SELECT symbol FROM chain_read_v1.coins",
    "SELECT checkpoint, tx_slot, event_slot FROM chain_read_v1.defillama_events",
    "SELECT * FROM chain_read_v1.blast_pnl_activity",
    "SELECT * FROM chain_read_v1.blast_pnl_period",
    "SELECT * FROM chain_read_v1.dex_swap_volume",
    "SELECT coin_type, symbol, decimals FROM chain_read_v1.coin_metadata",
    "SELECT coin_type FROM chain_read_v1.coin_unavailable",
    `SELECT c.coin_type, p.lifecycle FROM chain_read_v1.coins AS c
       JOIN chain_read_v1.pools p ON p.pool_key = c.pool_key
       WHERE c.coin_type = ANY($1)`,
    "SELECT checkpoint, lag_ms FROM (SELECT 1) AS probe LEFT JOIN chain_read_v1.watermark AS w ON TRUE",
    "SELECT profile_id FROM mission_control_profiles JOIN chain_read_v1.coins USING (coin_type)",
  ]) {
    assert.doesNotThrow(() => assertChainReadThroughViews(allowed), allowed);
  }
  for (const refused of [
    "SELECT symbol FROM coins",
    "SELECT * FROM public.pools",
    "SELECT * FROM blast_infra.dex_swap_volume",
    'SELECT * FROM "trades"',
    "SELECT * FROM chain_read_v1.coins JOIN watermarks ON TRUE",
    "SELECT * FROM chain_read_v1.coins c, balances b",
    "SELECT * FROM chain_v1.coin_identity",
    "SELECT * FROM chain_read_v1.trades",
  ]) {
    assert.throws(() => assertChainReadThroughViews(refused), /chain_read_v1/, refused);
  }
});

test("fresh workers own their tables and shared alerts belong to the runtime alone", () => {
  assert.doesNotThrow(() => assertTableOwnership("worker-runtime", "blast_worker_alerts"));
  assert.doesNotThrow(() => assertTableOwnership("worker-runtime", "blast_worker_release_gate_checks"));
  assert.doesNotThrow(() => assertTableOwnership("blast-keeper", "blast_keeper_actions"));
  assert.doesNotThrow(() => assertTableOwnership("vault-rewards", "vault_reward_actions"));
  assert.doesNotThrow(() => assertTableOwnership("rewards-planner", "vault_reward_plans"));
  assert.doesNotThrow(() => assertTableOwnership("vault-buyback", "mission_control_vault_buybacks"));
  assert.throws(() => assertTableOwnership("presale-worker", "blast_worker_alerts"), /cannot write table/);
  assert.throws(() => assertTableOwnership("presale-worker", "presale_worker_alerts"), /cannot write table/);
  assert.throws(() => assertTableOwnership("rewards-planner", "vault_reward_actions"), /cannot write table/);
  assert.throws(() => assertTableOwnership("vault-rewards", "vault_reward_plans"), /cannot write table/);
});

const RETIRED_VIEW = "SELECT * FROM chain_read_v1.presale_reward_rounds";

test("every core read and write refuses chain data outside the published views before it connects", async () => {
  const pool = { connect() { throw new Error("must not connect"); } } as unknown as Pool;
  await assert.rejects(autocommitRead(pool, "worker-runtime", RETIRED_VIEW), /chain_read_v1/);
  await assert.rejects(autocommitRead(pool, "worker-runtime", "SELECT * FROM public.vaults"), /chain_read_v1/);
  await assert.rejects(batchedRead(pool, "worker-runtime", RETIRED_VIEW), /chain_read_v1/);
  await assert.rejects(
    autocommitWrite(pool, "rewards-planner", "vault_reward_plans", "UPDATE vault_reward_plans SET inputs=(SELECT row_to_json(v) FROM trades v)"),
    /chain_read_v1/,
  );
});

test("transaction and module queries share the published-view boundary", async () => {
  const sent: string[] = [];
  const pool = { connect: async () => Object.assign(new EventEmitter(), {
    query: async (text: string) => { sent.push(text); return { rows: [], rowCount: 0, command: text === "COMMIT" ? "COMMIT" : "SELECT" }; },
    release() {},
  }) } as unknown as Pool;
  await withTransaction(pool, async (transaction) => {
    assert.throws(() => transaction.read(RETIRED_VIEW), /chain_read_v1/);
    assert.throws(() => transaction.forModule("rewards-planner").read(RETIRED_VIEW), /chain_read_v1/);
    assert.throws(
      () => transaction.forModule("rewards-planner").write("vault_reward_plans", "UPDATE vault_reward_plans SET inputs=(SELECT row_to_json(v) FROM chain_read_v1.reward_sources v)"),
      /chain_read_v1/,
    );
    await transaction.read("SELECT * FROM chain_read_v1.vault_rounds");
    await transaction.read("SELECT * FROM chain_read_v1.reward_holder_window_since($1,$2,$3,$4,$5,$6,$7,$8,$9)");
    await transaction.read("SELECT owner FROM chain_read_v1.reward_identity_gaps($1,$2,$3,$4,$5,$6,$7,$8,$9)");
    assert.throws(() => transaction.read("SELECT * FROM address_identity"), /chain_read_v1/);
    // A writing function is owned like a table: only the planner saves identity answers.
    const save = "SELECT chain_read_v1.record_address_identities($1::jsonb)";
    await transaction.forModule("rewards-planner").write("chain_read_v1.record_address_identities", save, ["[]"]);
    assert.throws(() => transaction.forModule("vault-rewards").write("chain_read_v1.record_address_identities" as "vault_reward_actions", save), /cannot write table/);
    assert.throws(() => transaction.forModule("rewards-planner").write("vault_reward_plans", save), /targets "chain_read_v1.record_address_identities"/);
    assert.throws(() => transaction.read(save), /Reads cannot call chain_read_v1.record_address_identities/);
    await transaction.read("SELECT * FROM chain_read_v1.utility_vesting_schedules s JOIN chain_read_v1.utility_vesting_events e USING (schedule_id)");
  });
  assert.ok(sent.includes("SELECT * FROM chain_read_v1.vault_rounds"));
  assert.ok(!sent.includes(RETIRED_VIEW));
});
