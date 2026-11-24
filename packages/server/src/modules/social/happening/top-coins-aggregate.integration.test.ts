import assert from "node:assert/strict";
import test from "node:test";
import { writeFile } from "node:fs/promises";

import { createPool, createRuntimePool } from "@blast/core/modules/database/pool.ts";
import { autocommitReader } from "@blast/core/modules/database/transaction.ts";
import { PORTFOLIO_PRICE_MAX_AGE_MS } from "@blast/core/modules/social/contracts/portfolio.ts";
import { SOCIAL_TRADE_BASE_COINS } from "@blast/core/modules/social/contracts/trades.ts";
import { SHOWN_PRESALES } from "@blast/core/modules/social/read-model/chain-presales.ts";
import { TOP_COINS_SQL, readTopCoins } from "@blast/server/modules/social/happening/top-coins.ts";
import { urlAs } from "../../../../../core/test/fixtures/modules/database/role-fixtures.ts";
import { freshTestDatabase } from "../../../../../core/test/fixtures/modules/database/template.ts";
import { seedChainRead, type ChainPresaleRow } from "../../../../../core/test/fixtures/modules/database/chain-read-rows.ts";

// Reference implementation before set-based aggregation: one count per eligible coin.
const PER_COIN_SQL = `SELECT market.* FROM (WITH coins AS MATERIALIZED (
  SELECT p.sale_token AS coin_type, p.presale_id, p.sale_name AS name, p.sale_symbol AS symbol, p.sale_icon_url AS icon_url,
    coalesce(trust.verified_team, false) AS verified_team
  FROM ${SHOWN_PRESALES} p LEFT JOIN social_sale_trust trust ON trust.presale_id = p.presale_id WHERE p.lifecycle = 'migrated'
  UNION ALL SELECT '${SOCIAL_TRADE_BASE_COINS.sui}', NULL, 'Sui', 'SUI', NULL, false
)
SELECT c.*, trim_scale(pr.usd_price)::text AS price_usd,
  (SELECT trim_scale(ph.usd_price)::text FROM chain_read_v1.price_history ph
    WHERE ph.coin_type = c.coin_type AND ph.resolution = '5m'
      AND ph.bucket_ms > $1::bigint - 90000000 AND ph.bucket_ms <= $1::bigint - 86400000
      AND ph.as_of_ms <= $1::bigint - 86400000
    ORDER BY ph.bucket_ms DESC LIMIT 1) AS price_24h_usd,
  CASE WHEN c.presale_id IS NULL THEN NULL ELSE
    (SELECT count(DISTINCT o.account_id)::int FROM chain_read_v1.activity a
      JOIN social_wallet_owners o ON o.address = a.actor
      WHERE a.coin_type = c.coin_type AND a.kind = 'trade_buy'
        AND a.timestamp_ms > $1::bigint - 86400000 AND a.timestamp_ms <= $1::bigint
        AND a.checkpoint <= $3::bigint) END AS buyers_24h,
  CASE WHEN c.presale_id IS NULL THEN NULL ELSE
    (SELECT count(DISTINCT o.account_id)::int FROM chain_read_v1.coin_balances b
      JOIN social_wallet_owners o ON o.address = b.owner
      WHERE b.coin_type = c.coin_type AND b.balance > 0) END AS holders
FROM coins c JOIN chain_read_v1.prices pr ON pr.coin_type = c.coin_type
WHERE pr.usd_price > 0 AND pr.as_of_ms >= $2::bigint - ${PORTFOLIO_PRICE_MAX_AGE_MS} AND pr.as_of_ms <= $2::bigint) market`;

const databaseUrl = process.env.MISSION_CONTROL_TEST_DATABASE_URL;
const NOW = 1_790_000_000_000;
const CLOCK = NOW - 60_000;
const hex = (n: number) => `0x${n.toString(16).padStart(64, "0")}`;
const coin = (n: number) => `${hex(10_000 + n)}::coin::TEST`;

function sale(n: number): ChainPresaleRow {
  return {
    presale_id: hex(10_000 + n), sale_token: coin(n), quote_type: SOCIAL_TRADE_BASE_COINS.sui,
    sale_symbol: "TEST", sale_name: `Test ${n}`, sale_icon_url: "https://example.test/coin.png", sale_decimals: 9,
    quote_symbol: "SUI", quote_decimals: 9, lifecycle: "migrated", start_ms: 0, end_ms: 1,
    raise_target: "100", min_commitment: "1", wallet_cap: null, total_commitments: "100",
    participants: 1, venue: "cetus", pool_id: null, updated_checkpoint: 1,
  };
}

test("set-based Top coins preserves per-coin counts, boundaries and price eligibility as the replica role", {
  skip: databaseUrl ? false : "MISSION_CONTROL_TEST_DATABASE_URL is not set",
  timeout: 120_000,
}, async () => {
  const database = await freshTestDatabase();
  const admin = createPool(database.url, { max: 1 });
  const replica = createRuntimePool(urlAs(database.url, "blast_replica"), {
    max: 1, connectionTimeoutMs: 5000, idleInTransactionMs: 5000, idleTimeoutMs: 1000, lockTimeoutMs: 2000, statementTimeoutMs: 30_000,
  }, "top-coins-aggregate-test");
  try {
    await seedChainRead(admin, {
      presales: Array.from({ length: 67 }, (_, n) => sale(n)),
      prices: [
        ...Array.from({ length: 67 }, (_, n) => ({ coin_type: coin(n), usd_price: n === 64 ? "0" : "2", as_of_ms: n === 65 ? NOW - PORTFOLIO_PRICE_MAX_AGE_MS - 1 : n === 66 ? NOW + 1 : NOW, source: "pool" as const })),
        { coin_type: SOCIAL_TRADE_BASE_COINS.sui, usd_price: "3", as_of_ms: NOW, source: "pyth" },
      ],
    });
    await admin.query(`INSERT INTO social_accounts (account_id, privy_did, callsign, privacy)
      SELECT md5('aggregate-' || i)::uuid, 'did:privy:aggregate-' || i, 'aggregate_' || i, 'private'
      FROM generate_series(1, 1000) i`);
    await admin.query(`INSERT INTO social_account_wallets (address, account_id, verified_at)
      SELECT '0x' || lpad(to_hex(i), 64, '0'), md5('aggregate-' || (1 + (i - 1) % 1000))::uuid, now()
      FROM generate_series(1, 2000) i`);
    await admin.query(`INSERT INTO blast_infra_fixture.activity
      (checkpoint, tx_slot, event_slot, part, timestamp_ms, digest, kind, product, actor, tx_sender, presale_id, coin_type, quote_type, quote_amount)
      SELECT c * 1000 + i, 0, 0, 0, $1::bigint - 1, 'aggregate', 'trade_buy', 'market',
        '0x' || lpad(to_hex(CASE WHEN i <= 256 THEN i ELSE i + 744 END), 64, '0'), '0x0',
        '0x' || lpad(to_hex(10000 + c), 64, '0'), '0x' || lpad(to_hex(10000 + c), 64, '0') || '::coin::TEST', 'sui', 1
      FROM generate_series(1, 63) c CROSS JOIN generate_series(1, 512) i`, [CLOCK]);
    await admin.query(`INSERT INTO blast_infra_fixture.coin_balances (coin_type, owner, balance, updated_checkpoint)
      SELECT '0x' || lpad(to_hex(10000 + c), 64, '0') || '::coin::TEST',
        '0x' || lpad(to_hex(CASE WHEN i <= 256 THEN i ELSE i + 744 END), 64, '0'), CASE WHEN i = 1 OR i = 257 THEN 0 ELSE 1 END, 1
      FROM generate_series(0, 63) c CROSS JOIN generate_series(1, 512) i`);
    await admin.query(`INSERT INTO blast_infra_fixture.activity
      (checkpoint, tx_slot, event_slot, part, timestamp_ms, digest, kind, product, actor, tx_sender, presale_id, coin_type, quote_type, quote_amount)
      SELECT checkpoint, 0, 0, 0, at, 'boundary', kind, 'market', '0x' || lpad(to_hex(actor), 64, '0'), '0x0', $1, $2, 'sui', 1
      FROM (VALUES (900000::bigint, $3::bigint - 1, 1, 'trade_buy'), (900001, $3::bigint - 1, 1001, 'trade_buy'),
        (900002, $3::bigint - 86400000, 2, 'trade_buy'), (900003, $3::bigint, 3, 'trade_buy'),
        (900004, $3::bigint + 1, 4, 'trade_buy'), (1000001, $3::bigint - 1, 5, 'trade_buy'),
        (900006, $3::bigint - 1, 6, 'trade_sell')) AS edge(checkpoint, at, actor, kind)`, [hex(10_000), coin(0), CLOCK]);
    // Match the production coin/time access path; fixture otherwise has only its primary key.
    await admin.query("CREATE INDEX aggregate_activity_coin ON blast_infra_fixture.activity (coin_type, timestamp_ms DESC)");
    await admin.query("ANALYZE");
    const values = [CLOCK, NOW, 1_000_000];
    const expected = (await replica.query(PER_COIN_SQL, values)).rows.sort((a, b) => a.coin_type.localeCompare(b.coin_type));
    const actual = (await replica.query(TOP_COINS_SQL, values)).rows.sort((a, b) => a.coin_type.localeCompare(b.coin_type));
    assert.deepEqual(actual, expected);
    assert.equal(actual.length, 65, "fresh positive coins plus SUI, excluding zero/stale/future prices");
    assert.equal(actual.find((row) => row.coin_type === coin(0))?.buyers_24h, 2);
    assert.equal(actual.find((row) => row.coin_type === coin(0))?.holders, 255, "two wallets of one account count once; zero balances do not count");
    const sui = actual.find((row) => row.coin_type === SOCIAL_TRADE_BASE_COINS.sui);
    assert.equal(sui?.buyers_24h, null);
    assert.equal(sui?.holders, null);
    assert.equal((await readTopCoins(autocommitReader(replica, "social"), CLOCK, NOW, 1_000_000))?.trending.length, 50);
    const plans: Record<string, unknown> = {};
    for (const [name, sql] of [["per_coin", PER_COIN_SQL], ["set_based", TOP_COINS_SQL]]) {
      const result = await replica.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${sql}`, values);
      plans[name!] = result.rows[0]["QUERY PLAN"][0];
    }
    await admin.query("UPDATE blast_infra_fixture.prices SET usd_price = 0 WHERE coin_type <> $1", [coin(0)]);
    assert.deepEqual((await replica.query(TOP_COINS_SQL, values)).rows, (await replica.query(PER_COIN_SQL, values)).rows);
    for (const [name, sql] of [["per_coin_one", PER_COIN_SQL], ["set_based_one", TOP_COINS_SQL]]) {
      const result = await replica.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${sql}`, values);
      plans[name!] = result.rows[0]["QUERY PLAN"][0];
    }
    if (process.env.TOP_COINS_PLAN_OUTPUT) await writeFile(process.env.TOP_COINS_PLAN_OUTPUT, JSON.stringify({ fixture: { coins: 64, accounts: 1000, wallets: 2000, activities: 32263, balances: 32768 }, plans }, null, 2) + "\n");
  } finally {
    await Promise.all([admin.end(), replica.end()]);
    await database.drop();
  }
});
