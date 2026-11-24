import type { Pool } from "pg";
import { migrateDatabase } from "../../../../packages/core/src/modules/database/migrations.ts";
import { seedFeedStory, FEED_STORY_PRESALES } from "../../../../packages/core/test/fixtures/modules/social/feed/feed-story.ts";
import { advanceWatermark } from "../../../../packages/core/test/fixtures/modules/database/role-fixtures.ts";
import { PORTFOLIO_COIN_TYPES } from "../../../../packages/core/src/modules/social/portfolio/read.ts";

export const accountId = (n: number) => `10000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
export const address = (n: number) => `0x${(0xca110000 + n).toString(16).padStart(64, "0")}`;
export const cashAtoms = (n: number) => String(1_000_000_000 + n);

/** Only called after the runner verifies a fresh disposable loopback database. */
export async function seedActiveUsers(admin: Pool, accounts: number, historyPerTrader: number) {
  const existing = await admin.query("SELECT to_regclass('public.social_accounts') AS relation");
  if (existing.rows[0]?.relation) throw new Error("Refusing to overwrite an existing application database");
  await migrateDatabase(admin);
  await seedFeedStory(admin, { nowMs: Date.now() });
  for (let first = 1; first <= accounts; first += 500) {
    await admin.query(`INSERT INTO social_accounts(account_id,privy_did,callsign,privacy,sharing_since,portfolio_public,portfolio_public_since)
      SELECT ('10000000-0000-4000-8000-'||lpad(to_hex(n),12,'0'))::uuid,
        'did:privy:capacity-'||n,'capacity'||n,'public',now(),n<=100,CASE WHEN n<=100 THEN now() END
      FROM generate_series($1::int,$2::int) n`, [first, Math.min(accounts, first + 499)]);
  }
  await admin.query(`INSERT INTO social_account_wallets(address,account_id,kind,verified_at)
    SELECT '0x'||lpad(to_hex(3390111744::bigint+n),64,'0'),
      ('10000000-0000-4000-8000-'||lpad(to_hex(n),12,'0'))::uuid,'embedded',now()
    FROM generate_series(1,$1::int) n`, [accounts]);
  const wallets = Array.from({ length: accounts }, (_, n) => address(n + 1));
  // Distinct cash balances expose account-crossing cache or authorization bugs.
  await admin.query(`INSERT INTO blast_infra_fixture.coin_balances
    SELECT $1,owner,1000000000+ord,80001 FROM unnest($3::text[]) WITH ORDINALITY t(owner,ord)
    UNION ALL SELECT $2,owner,10000000,80001 FROM unnest($3::text[]) t(owner)`,
    [PORTFOLIO_COIN_TYPES.sui, PORTFOLIO_COIN_TYPES.usdc, wallets]);
  await admin.query(`INSERT INTO blast_infra_fixture.wallet_sync(owner,timestamp_ms)
    SELECT owner,$2 FROM unnest($1::text[]) t(owner)`, [wallets, Date.now()]);
  await admin.query(`INSERT INTO blast_infra_fixture.coin_balances
    SELECT p.sale_token,w.owner,$2::numeric*1000000000,80001
    FROM blast_infra_fixture.presales p CROSS JOIN unnest($1::text[]) w(owner)`, [wallets, historyPerTrader]);
  const sale = FEED_STORY_PRESALES.migratedRecently;
  await admin.query(`INSERT INTO blast_infra_fixture.activity
    (checkpoint,tx_slot,event_slot,part,timestamp_ms,digest,kind,product,actor,tx_sender,presale_id,coin_type,quote_type,quote_amount,coin_amount,usd_value)
    SELECT 1000000+g,0,0,0,$1::bigint-g,'capacity-'||g,'trade_buy','presale',w.owner,w.owner,
      p.presale_id,p.sale_token,p.quote_type,1000000,1000000000,1
    FROM generate_series(1,$2::int) g
    JOIN unnest($3::text[]) WITH ORDINALITY w(owner,ord) ON w.ord=1+(g-1)%100
    CROSS JOIN blast_infra_fixture.presales p WHERE p.presale_id=$4`,
    [Date.now(), Math.min(100, accounts) * historyPerTrader, wallets.slice(0, 100), sale]);
  await admin.query("CREATE INDEX capacity_activity_actor_time ON blast_infra_fixture.activity(actor,timestamp_ms DESC)");
  await admin.query("CREATE INDEX capacity_balances_owner ON blast_infra_fixture.coin_balances(owner,coin_type)");
  await refreshFixture(admin, accounts * historyPerTrader + 2_000_000);
  await admin.query("ANALYZE");
  return { accounts, public_traders: Math.min(100, accounts), history_per_trader: historyPerTrader, wallets: accounts };
}

/** Simulate fresh indexed data, never a mainnet RPC call. */
export async function refreshFixture(admin: Pool, checkpoint: number) {
  await admin.query(advanceWatermark(checkpoint, 0, "market"));
  await admin.query(advanceWatermark(checkpoint, 0, "presale"));
  await admin.query("UPDATE blast_infra_fixture.prices SET as_of_ms=$1", [Date.now()]);
  await admin.query(`INSERT INTO blast_infra_fixture.prices(coin_type,usd_price,as_of_ms,source)
    VALUES($1,3,$3,'pyth'),($2,1,$3,'pyth') ON CONFLICT(coin_type) DO UPDATE SET as_of_ms=excluded.as_of_ms`,
    [PORTFOLIO_COIN_TYPES.sui, PORTFOLIO_COIN_TYPES.usdc, Date.now()]);
}
