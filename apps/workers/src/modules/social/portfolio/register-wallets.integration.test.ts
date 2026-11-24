import assert from "node:assert/strict";
import test from "node:test";
import { createPool, createRuntimePool } from "@blast/core/modules/database/pool.ts";
import { withTransaction } from "@blast/core/modules/database/transaction.ts";
import { freshTestDatabase } from "../../../../../../packages/core/test/fixtures/modules/database/template.ts";
import { urlAs } from "../../../../../../packages/core/test/fixtures/modules/database/role-fixtures.ts";
import { FEED_STORY_ACCOUNTS, seedFeedStory } from "../../../../../../packages/core/test/fixtures/modules/social/feed/feed-story.ts";
import { hex } from "../../../../../../packages/core/test/kit.ts";
import { registerWalletsStep } from "./register-wallets.ts";

const skip = !process.env.MISSION_CONTROL_TEST_DATABASE_URL;
const NOW = Date.now();
const KAI_SECOND_WALLET = hex("ca2");
const POOL = { connectionTimeoutMs: 5_000, idleInTransactionMs: 5_000, idleTimeoutMs: 1_000, lockTimeoutMs: 2_000, max: 6, statementTimeoutMs: 5_000 };

test("wallet registration is durable during infra failure, bounded and safe for concurrent consumers", { skip }, async () => {
  const database = await freshTestDatabase();
  const { url } = database;
  const admin = createPool(url, { max: 4 });
  try {
    await seedFeedStory(admin, { nowMs: NOW });
    await admin.query("INSERT INTO social_account_wallets (address, account_id, verified_at) VALUES ($1, $2, $3)", [KAI_SECOND_WALLET, FEED_STORY_ACCOUNTS.kai, new Date(NOW - 60 * 86_400_000).toISOString()]);
    const watcher = createRuntimePool(urlAs(url, "blast_watcher"), POOL, "wallet-registration-test");
    const run = () => withTransaction(watcher, (tx) => registerWalletsStep.run(tx.forModule("social"), null, { now: () => NOW }));
    try {
      assert.ok((await admin.query("SELECT owner FROM social_wallet_balance_requests WHERE owner=$1", [KAI_SECOND_WALLET])).rowCount);
      const before = Number((await admin.query("SELECT count(*) FROM social_wallet_balance_requests")).rows[0].count);
      await assert.rejects(run(), { code: "42883" });
      assert.equal(Number((await admin.query("SELECT count(*) FROM social_wallet_balance_requests")).rows[0].count), before);
      await admin.query(`CREATE TABLE blast_infra_fixture.wallet_registrations(owner TEXT PRIMARY KEY);
        CREATE FUNCTION chain_read_v1.track_wallets(addresses TEXT[]) RETURNS VOID LANGUAGE SQL SECURITY DEFINER
        SET search_path=pg_catalog AS 'INSERT INTO blast_infra_fixture.wallet_registrations SELECT unnest(addresses) ON CONFLICT DO NOTHING';
        GRANT EXECUTE ON FUNCTION chain_read_v1.track_wallets(TEXT[]) TO blast_watcher;
        INSERT INTO social_wallet_balance_requests(owner) SELECT '0x' || lpad(to_hex(n),64,'0') FROM generate_series(100000,101049) n`);
      await run();
      assert.equal(Number((await admin.query("SELECT count(*) FROM blast_infra_fixture.wallet_registrations")).rows[0].count), 1000);
      await Promise.all([run(), run()]);
      assert.equal(Number((await admin.query("SELECT count(*) FROM social_wallet_balance_requests")).rows[0].count), 0);
      assert.equal(Number((await admin.query("SELECT count(*) FROM blast_infra_fixture.wallet_registrations")).rows[0].count), before + 1050);
    } finally { await watcher.end(); }
  } finally {
    await admin.end();
    await database.drop();
  }
});
