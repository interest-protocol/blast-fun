// Social feed coins sheet scale evidence (UI-14): seed a launch-scale
// disposable database (10k accounts, 250k withdrawal records with one heavy
// account, 2,000 presales and 50,000 prices in the fixture chain_read_v1) and
// time the coins routes' statements with their plans (EXPLAIN ANALYZE,
// BUFFERS), running as the web role. Writes run in rolled-back transactions.
//
//   SOCIAL_SCALE_DATABASE_URL=postgresql://postgres:<pw>@127.0.0.1:<port>/<db> \
//     node --no-warnings --import ./scripts/test-tsx-hooks.mjs --experimental-strip-types loadtest/social-coins-scale.ts seed|bench
//
// The database must be a disposable loopback Postgres (seed resets it). bench
// prints p50/p95 per statement and writes the plans to
// loadtest/results/social-coins-scale-plans.txt.
import fs from "node:fs";

import { migrateDatabase } from "@blast/core/modules/database/migrations.ts";
import { createPool } from "@blast/core/modules/database/pool.ts";
import { CHAIN_FIXTURE, resetSharedDatabase, urlAs } from "../../../packages/core/test/fixtures/modules/database/role-fixtures.ts";

const URL_ = process.env.SOCIAL_SCALE_DATABASE_URL ?? "";
if (!/^postgres(ql)?:\/\/[^@]+@(127\.0\.0\.1|localhost):\d+\/\w+$/.test(URL_)) {
  throw new Error("SOCIAL_SCALE_DATABASE_URL must name a disposable loopback database (seed resets it).");
}
const ACCOUNTS = 10_000, TRANSFERS = 250_000, HEAVY_TRANSFERS = 5_000, PRESALES = 2_000, PRICES = 50_000, RUNS = 30;
const uuid = (n: string) => `('00000000-0000-4000-8000-' || lpad(to_hex(${n}), 12, '0'))::uuid`;
const id = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
const hex = (n: number) => `0x${n.toString(16).padStart(64, "0")}`;
const USDC = "0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC";
const SUI = `0x${"0".repeat(63)}2::sui::SUI`;
const HEAVY = id(1);

async function seed() {
  const admin = createPool(URL_, { max: 2 });
  await resetSharedDatabase(admin);
  await admin.query(CHAIN_FIXTURE);
  await migrateDatabase(admin);
  await admin.query(
    `INSERT INTO social_accounts (account_id, privy_did, callsign, onboarded_at, privacy, sharing_since)
     SELECT ${uuid("n")}, 'did:privy:scale-' || n, 'acct_' || n, now(), 'public', now() FROM generate_series(1, ${ACCOUNTS}) n`,
  );
  // 250k withdrawals over every account; account 1 made 5,000. Most settled, a few pending or waiting.
  await admin.query(
    `INSERT INTO social_coin_transfers (request_id, account_id, sender, recipient, coin_type, amount, fee, status, digest, failure, created_at, updated_at, settled_at)
     SELECT ${uuid("1000000 + n")},
       CASE WHEN n <= ${HEAVY_TRANSFERS} THEN ${uuid("1")} ELSE ${uuid(`2 + (n % ${ACCOUNTS - 1})`)} END,
       '0x' || lpad(to_hex(n % ${ACCOUNTS}), 64, '0'), '0x' || lpad(to_hex(900000 + n), 64, '0'),
       CASE WHEN n % 3 = 0 THEN '${SUI}' ELSE '${USDC}' END, (1000000 + n)::numeric,
       CASE WHEN n % 4 = 0 THEN 'wallet' ELSE 'sponsored' END,
       s.status,
       -- A base58-shaped digest: base64 of a hash with its non-base58 characters mapped.
       CASE WHEN s.status = 'pending' THEN NULL ELSE translate(substr(encode(sha256(n::text::bytea), 'base64'), 1, 43), '0OIl+/', '123456') END,
       CASE WHEN s.status = 'failed' THEN 'execution_failed' END,
       now() - (n || ' seconds')::interval, now() - (n || ' seconds')::interval,
       CASE WHEN s.status IN ('confirmed', 'failed') THEN now() - (n || ' seconds')::interval END
     FROM generate_series(1, ${TRANSFERS}) n
     CROSS JOIN LATERAL (SELECT CASE WHEN n % 97 = 0 THEN 'pending' WHEN n % 89 = 0 THEN 'submitted' WHEN n % 83 = 0 THEN 'failed' ELSE 'confirmed' END AS status) s`,
  );
  await admin.query(
    `INSERT INTO blast_infra_fixture.presales (presale_id, sale_token, quote_type, sale_symbol, sale_name, sale_icon_url, sale_decimals, quote_symbol,
       quote_decimals, lifecycle, start_ms, end_ms, raise_target, min_commitment, wallet_cap, total_commitments, participants, venue, pool_id, updated_checkpoint)
     SELECT '0x' || lpad(to_hex(n), 64, '0'), '0x' || lpad(to_hex(n), 64, '0') || '::coin::T' || n, '${USDC}', 'T' || n, 'Token ' || n,
       'https://i.blast.test/' || n || '.png', 9, 'USDC', 6, CASE WHEN n % 3 = 0 THEN 'migrated' ELSE 'open' END,
       0, 1, 100000000000, 1000000, NULL, 0, 0, 'cetus', NULL, 1
     FROM generate_series(1, ${PRESALES}) n`,
  );
  await admin.query(
    `INSERT INTO blast_infra_fixture.prices (coin_type, usd_price, as_of_ms, source)
     SELECT CASE WHEN n = 1 THEN '${SUI}' ELSE '0x' || lpad(to_hex(n + 100000), 64, '0') || '::coin::P' || n END, 0.001 * n, ${Date.now()}, 'pool'
     FROM generate_series(1, ${PRICES}) n`,
  );
  await admin.query("ANALYZE");
  const sizes = await admin.query("SELECT count(*)::int AS transfers, pg_size_pretty(pg_total_relation_size('social_coin_transfers')) AS size FROM social_coin_transfers");
  console.log(JSON.stringify(sizes.rows[0]));
  await admin.end();
}

type Statement = Readonly<{ name: string; sql: string; values: unknown[] }>;

const COLUMNS = `request_id::text AS request_id, account_id::text AS account_id, sender, recipient, coin_type,
  amount::text AS amount, fee, status, digest, failure,
  (extract(epoch FROM created_at) * 1000)::bigint::text AS created_ms,
  (extract(epoch FROM settled_at) * 1000)::bigint::text AS settled_ms`;

async function bench() {
  const web = createPool(urlAs(URL_, "blast_web"), { max: 2 });
  const known = (await web.query<{ request_id: string }>("SELECT request_id::text FROM social_coin_transfers WHERE account_id = $1 AND status = 'pending' LIMIT 1", [id(500)])).rows[0]
    ?? (await web.query<{ request_id: string }>("SELECT request_id::text FROM social_coin_transfers WHERE status = 'pending' LIMIT 1")).rows[0]!;
  const submitted = (await web.query<{ request_id: string }>("SELECT request_id::text FROM social_coin_transfers WHERE status = 'submitted' LIMIT 1")).rows[0]!;
  // 50 coin types a busy wallet might hold: 30 sale coins and 20 others.
  const held = [...Array.from({ length: 30 }, (_, i) => `${hex(i * 60 + 7)}::coin::T${i * 60 + 7}`), ...Array.from({ length: 20 }, (_, i) => `${hex(700000 + i)}::spam::S${i}`)];
  const statements: Statement[] = [
    {
      name: "record a new withdrawal (insert, rolled back)",
      sql: `INSERT INTO social_coin_transfers (request_id, account_id, sender, recipient, coin_type, amount, fee, status, digest)
            VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6::numeric, $7, 'pending', NULL) ON CONFLICT (request_id) DO NOTHING RETURNING ${COLUMNS}`,
      values: [id(0xfeed), id(9_000), hex(9_000), hex(0xa3), USDC, "100000000", "sponsored"],
    },
    {
      name: "repeat of a recorded id (conflict, nothing inserted)",
      sql: `INSERT INTO social_coin_transfers (request_id, account_id, sender, recipient, coin_type, amount, fee, status, digest)
            VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6::numeric, $7, 'pending', NULL) ON CONFLICT (request_id) DO NOTHING RETURNING ${COLUMNS}`,
      values: [known.request_id, id(500), hex(500), hex(0xa3), USDC, "100000000", "sponsored"],
    },
    { name: "lock the recorded withdrawal", sql: `SELECT ${COLUMNS} FROM social_coin_transfers WHERE request_id = $1::uuid FOR UPDATE`, values: [known.request_id] },
    {
      name: "attach the digest (rolled back)",
      sql: `UPDATE social_coin_transfers SET digest = $2, status = 'submitted', updated_at = now() WHERE request_id = $1::uuid AND status = 'pending' RETURNING ${COLUMNS}`,
      values: [known.request_id, "4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi"],
    },
    {
      name: "settle (rolled back)",
      sql: `UPDATE social_coin_transfers SET status = $2, failure = $3, settled_at = now(), updated_at = now() WHERE request_id = $1::uuid AND status = 'submitted' RETURNING ${COLUMNS}`,
      values: [submitted.request_id, "confirmed", null],
    },
    {
      name: "an account's latest withdrawals (heavy account, 5,000)",
      sql: `SELECT ${COLUMNS} FROM social_coin_transfers WHERE account_id = $1 ORDER BY created_at DESC, request_id DESC LIMIT 20`,
      values: [HEAVY],
    },
    { name: "which held coins are sale coins (50 types, 2,000 presales)", sql: "SELECT presale_id, sale_token FROM chain_read_v1.presales WHERE sale_token = ANY($1::text[])", values: [held] },
    { name: "SUI's price", sql: "SELECT usd_price::text AS usd_price, as_of_ms::text AS as_of_ms FROM chain_read_v1.prices WHERE coin_type = $1", values: [SUI] },
  ];
  const plans: string[] = [];
  for (const statement of statements) {
    const times: number[] = [];
    let plan = "";
    for (let run = 0; run < RUNS; run += 1) {
      const client = await web.connect();
      try {
        await client.query("BEGIN");
        const result = await client.query<{ "QUERY PLAN": unknown }>(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${statement.sql}`, statement.values);
        const json = (result.rows[0]!["QUERY PLAN"] as { "Planning Time": number; "Execution Time": number }[])[0]!;
        times.push(json["Planning Time"] + json["Execution Time"]);
        if (run === RUNS - 1) {
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
  fs.writeFileSync("loadtest/results/social-coins-scale-plans.txt", plans.join("\n"));
  await web.end();
}

if (process.argv[2] === "seed") await seed();
else if (process.argv[2] === "bench") await bench();
else throw new Error("Usage: social-coins-scale.ts seed|bench");
