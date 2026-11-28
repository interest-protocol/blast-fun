// Social feed trading scale evidence (R3-30-AC-10, R3-31): seed a launch-scale
// disposable database (2,000 presales in the fixture chain_read_v1, a third of
// them migrated, and 50,000 prices; 10k accounts and 1,000,000 trades in
// social_swap_intents, one heavy account at 20,000) and time the statements
// with their plans (EXPLAIN ANALYZE, BUFFERS). The quote's reads run as the
// replica role, where the quote route reads: a quote reads the same two
// statements whatever the route (the aggregator chooses the pools, so a
// two-hop route reads no more rows than a one-hop one; the intermediate coin
// is not read). R3-33's picker list (the migrated sales' coins by ticker, a
// keyset page of 50, a search) runs there too. The swap path's run as the web role on the primary; its
// writes run in rolled-back transactions.
//
//   SOCIAL_SCALE_DATABASE_URL=postgresql://postgres:<pw>@127.0.0.1:<port>/<db> \
//     node --no-warnings --import ./scripts/test-tsx-hooks.mjs --experimental-strip-types loadtest/social-trades-scale.ts seed|bench
//
// The database must be a disposable loopback Postgres (seed resets it). bench
// prints p50/p95 per statement and writes the plans to
// loadtest/results/social-trades-scale-plans.txt.
import fs from "node:fs";

import { migrateDatabase } from "@blast/core/modules/database/migrations.ts";
import { createPool } from "@blast/core/modules/database/pool.ts";
import { CHAIN_FIXTURE, resetSharedDatabase, urlAs } from "../../../packages/core/test/fixtures/modules/database/role-fixtures.ts";
import { likePattern, TRADE_COIN_LIST_SQL } from "@blast/server/modules/social/trades/coin-list.ts";
import { TRADE_PRICES_SQL, TRADE_SALE_COINS_SQL } from "@blast/server/modules/social/trades/coins.ts";
import { TRADE_BY_KEY_SQL, TRADE_COLUMNS, TRADE_INSERT_SQL, TRADE_SETTLE_SQL } from "@blast/server/modules/social/trades/swap.ts";

const URL_ = process.env.SOCIAL_SCALE_DATABASE_URL ?? "";
if (!/^postgres(ql)?:\/\/[^@]+@(127\.0\.0\.1|localhost):\d+\/\w+$/.test(URL_)) {
  throw new Error("SOCIAL_SCALE_DATABASE_URL must name a disposable loopback database (seed resets it).");
}
const PRESALES = 2_000, PRICES = 50_000, RUNS = 50, ACCOUNTS = 10_000, TRADES = 1_000_000, HEAVY_TRADES = 20_000;
const uuid = (n: string) => `('00000000-0000-4000-8000-' || lpad(to_hex(${n}), 12, '0'))::uuid`;
const id = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
const HEAVY = id(1);
const NOW_MS = Date.now();
const hex = (n: number) => `0x${n.toString(16).padStart(64, "0")}`;
const SUI = `0x${"0".repeat(63)}2::sui::SUI`;
const sale = (n: number) => `${hex(n)}::coin::T${n}`;

async function seed() {
  const admin = createPool(URL_, { max: 2 });
  await resetSharedDatabase(admin);
  await admin.query(CHAIN_FIXTURE);
  await migrateDatabase(admin);
  await admin.query(
    `INSERT INTO blast_infra_fixture.presales (presale_id, sale_token, quote_type, sale_symbol, sale_name, sale_icon_url, sale_decimals, quote_symbol,
       quote_decimals, lifecycle, start_ms, end_ms, raise_target, min_commitment, wallet_cap, total_commitments, participants, venue, pool_id, updated_checkpoint)
     SELECT '0x' || lpad(to_hex(n), 64, '0'), '0x' || lpad(to_hex(n), 64, '0') || '::coin::T' || n, '${SUI}', 'T' || n, 'Token ' || n,
       'https://i.blast.test/' || n || '.png', 9, 'SUI', 9, CASE WHEN n % 3 = 0 THEN 'migrated' ELSE 'open' END,
       0, 1, 100000000000, 1000000, NULL, 0, 0, CASE WHEN n % 9 = 0 THEN 'cetus' ELSE 'bluefin' END,
       CASE WHEN n % 3 = 0 THEN '0x' || lpad(to_hex(n + 500000), 64, '0') END, 1
     FROM generate_series(1, ${PRESALES}) n`,
  );
  // SUI's Pyth price, every sale coin's pool price, and the rest other coins'.
  await admin.query(
    `INSERT INTO blast_infra_fixture.prices (coin_type, usd_price, as_of_ms, source)
     SELECT CASE WHEN n = 1 THEN '${SUI}'
       WHEN n <= ${PRESALES + 1} THEN '0x' || lpad(to_hex(n - 1), 64, '0') || '::coin::T' || (n - 1)
       ELSE '0x' || lpad(to_hex(n + 100000), 64, '0') || '::coin::P' || n END,
       0.001 * n, ${Date.now()}, CASE WHEN n = 1 THEN 'pyth' ELSE 'pool' END
     FROM generate_series(1, ${PRICES}) n`,
  );
  await admin.query(
    `INSERT INTO social_accounts (account_id, privy_did, callsign, onboarded_at, privacy, sharing_since)
     SELECT ${uuid("n")}, 'did:privy:scale-' || n, 'acct_' || n, now(), 'public', now() FROM generate_series(1, ${ACCOUNTS}) n`,
  );
  // 1M trades over every account (account 1 made 20,000, today's among them), one every ~2.6 s back from now:
  // mostly confirmed, some failed before anything was built, a few still built; most sponsored.
  await admin.query(
    `INSERT INTO social_swap_intents (trade_id, account_id, idempotency_key, quote_digest, side, sender, in_coin, out_coin, amount_in, amount_out,
       min_out, slippage_bps, route, route_label, quote_expires_at_ms, usd_value, fee_payer, reservation_id, tx_bytes, digest, expires_at_ms, state,
       failure_code, amount_out_filled, created_at_ms, settled_at_ms)
     SELECT ${uuid("1000000 + n")},
       CASE WHEN n <= ${HEAVY_TRADES} THEN ${uuid("1")} ELSE ${uuid(`2 + (n % ${ACCOUNTS - 1})`)} END,
       ${uuid("3000000 + n")}::text, sha256(n::text::bytea), CASE WHEN n % 2 = 0 THEN 'buy' ELSE 'sell' END,
       '0x' || lpad(to_hex(n % ${ACCOUNTS}), 64, '0'),
       CASE WHEN n % 2 = 0 THEN '${SUI}' ELSE '0x' || lpad(to_hex(n % ${PRESALES} + 1), 64, '0') || '::coin::T' || (n % ${PRESALES} + 1) END,
       CASE WHEN n % 2 = 0 THEN '0x' || lpad(to_hex(n % ${PRESALES} + 1), 64, '0') || '::coin::T' || (n % ${PRESALES} + 1) ELSE '${SUI}' END,
       1000000 + n, 2000000 + n, 1990000 + n, 50,
       jsonb_build_array(jsonb_build_object('pool_id', '0x' || lpad(to_hex(n % ${PRESALES} + 500000), 64, '0'), 'venue', 'cetus')),
       'SUI → T · Cetus', ${NOW_MS} - n::bigint * 2600 + 20000, 1.19,
       CASE WHEN s.state = 'failed' THEN NULL WHEN n % 5 = 0 THEN 'wallet' ELSE 'blast' END,
       CASE WHEN s.state <> 'failed' AND n % 5 <> 0 THEN ${uuid("5000000 + n")} END,
       CASE WHEN s.state <> 'failed' THEN '\\x0102'::bytea END,
       CASE WHEN s.state <> 'failed' THEN translate(substr(encode(sha256(n::text::bytea), 'base64'), 1, 43), '0OIl+/', '123456') END,
       CASE WHEN s.state <> 'failed' THEN ${NOW_MS} - n::bigint * 2600 + 110000 END,
       s.state, CASE WHEN s.state = 'failed' THEN 'price_moved' END,
       CASE WHEN s.state = 'confirmed' THEN 1995000 + n END,
       ${NOW_MS} - n::bigint * 2600, CASE WHEN s.state <> 'built' THEN ${NOW_MS} - n::bigint * 2600 + 3000 END
     FROM generate_series(1, ${TRADES}) n
     CROSS JOIN LATERAL (SELECT CASE WHEN n % 97 = 0 THEN 'built' WHEN n % 13 = 0 THEN 'failed' ELSE 'confirmed' END AS state) s`,
  );
  await admin.query("ANALYZE");
  const sizes = await admin.query(
    `SELECT (SELECT count(*)::int FROM blast_infra_fixture.presales) AS presales, (SELECT count(*)::int FROM blast_infra_fixture.prices) AS prices,
       (SELECT count(*)::int FROM social_swap_intents) AS trades, pg_size_pretty(pg_total_relation_size('social_swap_intents')) AS trades_size`,
  );
  console.log(JSON.stringify(sizes.rows[0]));
  await admin.end();
}

type Statement = Readonly<{ name: string; sql: string; values: unknown[] }>;

async function bench() {
  const replica = createPool(urlAs(URL_, "blast_replica"), { max: 2 });
  const web = createPool(urlAs(URL_, "blast_web"), { max: 2 });
  const built = (await web.query<{ trade_id: string; account_id: string; idempotency_key: string }>(
    "SELECT trade_id::text, account_id::text, idempotency_key FROM social_swap_intents WHERE state = 'built' AND account_id = $1 LIMIT 1",
    [HEAVY],
  )).rows[0]!;
  const swapStatements: Statement[] = [
    { name: "replay: the key's trade (heavy account, 20,000 trades)", sql: TRADE_BY_KEY_SQL, values: [built.account_id, built.idempotency_key] },
    {
      name: "settle: the trade, locked",
      sql: `SELECT ${TRADE_COLUMNS} FROM social_swap_intents WHERE trade_id = $1::uuid AND account_id = $2::uuid FOR UPDATE`,
      values: [built.trade_id, built.account_id],
    },
    { name: "settle: confirmed (rolled back)", sql: TRADE_SETTLE_SQL, values: [built.trade_id, "confirmed", null, "2000000", NOW_MS] },
    {
      name: "record a built trade (insert, rolled back)",
      sql: TRADE_INSERT_SQL,
      values: [
        id(0xfeedbeef), HEAVY, "4a0b7c5e-8f3d-4b2a-9c1e-6d5f4e3a2b1c", Buffer.alloc(32, 7), "buy", hex(1), SUI, sale(3), "100", "1000", "995", 50,
        JSON.stringify([{ pool_id: hex(900), venue: "cetus" }]), "SUI → T3 · Cetus", NOW_MS + 20_000, "0.12", "blast", id(0xfeed), Buffer.from([1]),
        "4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi", NOW_MS + 110_000, "built", null, NOW_MS,
      ],
    },
  ];
  const statements: Statement[] = [
    { name: "one-hop SUI → sale coin: the sale coin", sql: TRADE_SALE_COINS_SQL, values: [[sale(1_998)]] },
    { name: "one-hop SUI → sale coin: both prices", sql: TRADE_PRICES_SQL, values: [[SUI, sale(1_998)]] },
    { name: "two-hop USDC → sale coin: the sale coin", sql: TRADE_SALE_COINS_SQL, values: [[sale(999)]] },
    { name: "two-hop USDC → sale coin: its price (USDC is $1, not read)", sql: TRADE_PRICES_SQL, values: [[sale(999)]] },
    { name: "sale coin → sale coin: both coins", sql: TRADE_SALE_COINS_SQL, values: [[sale(3), sale(1_500)]] },
    { name: "sale coin → sale coin: both prices", sql: TRADE_PRICES_SQL, values: [[sale(3), sale(1_500)]] },
    // R3-33: the picker's "More coins" — every migrated sale's coin by ticker (667 of 2,000), 50 a page, with its price.
    { name: "picker: the first page of tradable coins", sql: TRADE_COIN_LIST_SQL, values: [null, null, null, 51, NOW_MS, false, null] },
    { name: "picker: a later page (keyset after T501)", sql: TRADE_COIN_LIST_SQL, values: [null, "T501", hex(501), 51, NOW_MS, false, null] },
    { name: "picker: a search (\"t19\", ticker or name)", sql: TRADE_COIN_LIST_SQL, values: [likePattern("t19"), null, null, 51, NOW_MS, false, null] },
  ];
  const plans: string[] = [];
  for (const [pool, statement] of [...statements.map((entry) => [replica, entry] as const), ...swapStatements.map((entry) => [web, entry] as const)]) {
    const times: number[] = [];
    let plan = "";
    for (let run = 0; run < RUNS; run += 1) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const result = await client.query<{ "QUERY PLAN": unknown }>(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${statement.sql}`, statement.values);
        const json = (result.rows[0]!["QUERY PLAN"] as { "Planning Time": number; "Execution Time": number }[])[0]!;
        times.push(json["Planning Time"] + json["Execution Time"]);
        if (run === RUNS - 1) {
          // The plan in a transaction of its own: a write the timed run made must not change what it plans.
          await client.query("ROLLBACK");
          await client.query("BEGIN");
          const text = await client.query<Record<string, string>>(`EXPLAIN (ANALYZE, BUFFERS) ${statement.sql}`, statement.values);
          plan = text.rows.map((row) => row["QUERY PLAN"]).join("\n");
        }
      } finally {
        await client.query("ROLLBACK").catch(() => undefined);
        client.release();
      }
    }
    times.sort((a, b) => a - b);
    const pct = (p: number) => times[Math.min(times.length - 1, Math.ceil((p / 100) * times.length) - 1)]!.toFixed(2);
    console.log(`${statement.name}: p50 ${pct(50)} ms, p95 ${pct(95)} ms`);
    plans.push(`== ${statement.name} ==\n${plan}\n`);
  }
  fs.mkdirSync("loadtest/results", { recursive: true });
  fs.writeFileSync("loadtest/results/social-trades-scale-plans.txt", plans.join("\n"));
  await replica.end();
  await web.end();
}

if (process.argv[2] === "seed") await seed();
else if (process.argv[2] === "bench") await bench();
else throw new Error("Usage: social-trades-scale.ts seed|bench");
