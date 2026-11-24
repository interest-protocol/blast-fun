import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createPool } from "@blast/core/modules/database/pool.ts";
import { seedChainRead } from "../../../../../../packages/core/test/fixtures/modules/database/chain-read-rows.ts";
import { portfolioFixtureConfiguration, portfolioAccountId, portfolioSaleId } from "./configuration.ts";
import { supportedPortfolioAssets } from "./supported-assets.ts";

// One-time additive repair for the already-prepared desktop fixture. No reset/upsert.
const { directory, url } = portfolioFixtureConfiguration();
const { now } = JSON.parse(readFileSync(`${directory}/auth.json`, "utf8"));
const pool = createPool(url, { max: 1 });
const client = await pool.connect();
const signature = async () => (await client.query("SELECT md5(string_agg(owner || ':' || coin_type || ':' || balance::text, ',' ORDER BY owner,coin_type)) AS value FROM blast_infra_fixture.coin_balances")).rows[0].value;
try {
  await client.query("BEGIN");
  assert.equal((await client.query("SELECT current_database() AS name")).rows[0].name, "mission_control_test");
  const accounts = (await client.query("SELECT account_id,privy_did FROM social_accounts ORDER BY account_id")).rows;
  assert.deepEqual(accounts, [1, 2, 3].map(n => ({ account_id: portfolioAccountId(n), privy_did: `did:privy:t020-${n}` })));
  const before = (await client.query("SELECT (SELECT count(*)::int FROM social_account_wallets) AS wallets,(SELECT count(*)::int FROM blast_infra_fixture.coin_balances) AS holdings,(SELECT count(*)::int FROM blast_infra_fixture.presales) AS presales,(SELECT count(*)::int FROM blast_infra_fixture.presale_positions) AS positions")).rows[0];
  assert.deepEqual(before, { wallets: 3, holdings: 28, presales: 1, positions: 1 }, "Only the original prepared fixture may be repaired; a second run refuses");
  assert.equal((await client.query("SELECT presale_id FROM blast_infra_fixture.presales")).rows[0].presale_id, portfolioSaleId);
  const balances = await signature();
  await seedChainRead(client, { presales: supportedPortfolioAssets(now) });
  assert.equal(await signature(), balances);
  assert.equal((await client.query("SELECT count(*)::int AS n FROM blast_infra_fixture.presales")).rows[0].n, 3);
  await client.query("COMMIT");
  console.log(JSON.stringify({ repaired: true, accounts: 3, wallets: 3, holdings: 28, presales_before: 1, presales_after: 3, positions: 1, balances_unchanged: true }));
} catch (error) { await client.query("ROLLBACK"); throw error; }
finally { client.release(); await pool.end(); }
