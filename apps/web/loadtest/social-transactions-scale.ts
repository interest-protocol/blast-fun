// Social feed transaction log scale evidence (R3-27-AC-8): seed a launch-scale
// disposable database (10k accounts, 1,000,000 logged transactions across
// them with one heavy account at 20,000, and the heavy account's withdrawals
// in social_coin_transfers) and time the log's statements with their plans
// (EXPLAIN ANALYZE, BUFFERS), running as the web role. The list's first page
// and a deep page (15,000 rows in) are the route's own statements; the
// helper's writes run in rolled-back transactions.
//
//   SOCIAL_SCALE_DATABASE_URL=postgresql://postgres:<pw>@127.0.0.1:<port>/<db> \
//     node --no-warnings --import ./scripts/test-tsx-hooks.mjs --experimental-strip-types loadtest/social-transactions-scale.ts seed|bench
//
// The database must be a disposable loopback Postgres (seed resets it). bench
// prints p50/p95 per statement and writes the plans to
// loadtest/results/social-transactions-scale-plans.txt.
import fs from "node:fs";

import { migrateDatabase } from "@blast/core/modules/database/migrations.ts";
import { createPool } from "@blast/core/modules/database/pool.ts";
import { CHAIN_FIXTURE, resetSharedDatabase, urlAs } from "../../../packages/core/test/fixtures/modules/database/role-fixtures.ts";
import { TRANSACTION_COLUMNS } from "@blast/core/modules/social/transactions/log.ts";
import { encodeTransactionsCursor, TRANSACTIONS_FIRST_PAGE_SQL, TRANSACTIONS_NEXT_PAGE_SQL } from "@blast/server/modules/social/transactions/read.ts";

const URL_ = process.env.SOCIAL_SCALE_DATABASE_URL ?? "";
if (!/^postgres(ql)?:\/\/[^@]+@(127\.0\.0\.1|localhost):\d+\/\w+$/.test(URL_)) {
  throw new Error("SOCIAL_SCALE_DATABASE_URL must name a disposable loopback database (seed resets it).");
}
const ACCOUNTS = 10_000, TRANSACTIONS = 1_000_000, HEAVY_TRANSACTIONS = 20_000, RUNS = 50, PAGE = 30, DEEP = 15_000;
const uuid = (n: string) => `('00000000-0000-4000-8000-' || lpad(to_hex(${n}), 12, '0'))::uuid`;
const id = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
const USDC = "0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC";
const HEAVY = id(1);
const TYPICAL = id(5_000);
const START_MS = 1_790_000_000_000;

async function seed() {
  const admin = createPool(URL_, { max: 2 });
  await resetSharedDatabase(admin);
  await admin.query(CHAIN_FIXTURE);
  await migrateDatabase(admin);
  await admin.query(
    `INSERT INTO social_accounts (account_id, privy_did, callsign, onboarded_at, privacy, sharing_since)
     SELECT ${uuid("n")}, 'did:privy:scale-' || n, 'acct_' || n, now(), 'public', now() FROM generate_series(1, ${ACCOUNTS}) n`,
  );
  // 1M rows over every account (account 1 made 20,000), one every 37 ms on average, so pages cross ties.
  // Kinds rotate; a row is confirmed, failed or still submitted; most carry a unique digest.
  await admin.query(
    `INSERT INTO social_transactions (tx_id, account_id, kind, state, digest, presale_id, coin_type, amount, quote_type, quote_amount,
       usd_value, idempotency_key, created_at_ms, settled_at_ms, failure_code)
     SELECT ${uuid("1000000 + n")},
       CASE WHEN n <= ${HEAVY_TRANSACTIONS} THEN ${uuid("1")} ELSE ${uuid(`2 + (n % ${ACCOUNTS - 1})`)} END,
       k.kind, s.state,
       CASE WHEN n % 50 = 0 THEN NULL ELSE translate(substr(encode(sha256(n::text::bytea), 'base64'), 1, 43), '0OIl+/', '123456') END,
       CASE WHEN k.kind IN ('commit', 'claim_refund', 'claim_tokens', 'claim_vesting') THEN '0x' || lpad(to_hex(n % 2000 + 1), 64, '0') END,
       '${USDC}', (1000000 + n)::numeric, NULL, NULL, ((1000000 + n) / 1000000.0)::numeric(20, 2),
       k.kind || ':' || n, ${START_MS} + n * 37 - (n % 3),
       CASE WHEN s.state = 'submitted' THEN NULL ELSE ${START_MS} + n * 37 + 1500 END,
       CASE WHEN s.state = 'failed' THEN 'execution_failed' END
     FROM generate_series(1, ${TRANSACTIONS}) n
     CROSS JOIN LATERAL (SELECT (ARRAY['commit', 'withdraw', 'claim_refund', 'claim_tokens', 'deposit', 'claim_vesting'])[1 + n % 6] AS kind) k
     CROSS JOIN LATERAL (SELECT CASE WHEN n % 50 = 0 THEN 'submitted' WHEN n % 41 = 0 THEN 'failed' ELSE 'confirmed' END AS state) s`,
  );
  // The heavy account's withdrawals also have their social_coin_transfers record (same id, same digest).
  await admin.query(
    `INSERT INTO social_coin_transfers (request_id, account_id, sender, recipient, coin_type, amount, fee, status, digest, failure, created_at, updated_at, settled_at)
     SELECT t.tx_id, t.account_id, '0x' || lpad('1', 64, '0'), '0x' || lpad(to_hex(900000 + row_number() OVER ()), 64, '0'),
       t.coin_type, t.amount, 'sponsored',
       CASE t.state WHEN 'submitted' THEN 'pending' ELSE t.state END,
       CASE WHEN t.state = 'submitted' THEN NULL ELSE t.digest END,
       CASE WHEN t.state = 'failed' THEN 'execution_failed' END,
       to_timestamp(t.created_at_ms / 1000.0), to_timestamp(t.created_at_ms / 1000.0),
       CASE WHEN t.state = 'submitted' THEN NULL ELSE to_timestamp(t.settled_at_ms / 1000.0) END
     FROM social_transactions t
     WHERE t.account_id = '${HEAVY}' AND t.kind = 'withdraw' AND (t.state <> 'submitted' OR t.digest IS NULL)`,
  );
  await admin.query("ANALYZE");
  const sizes = await admin.query(
    `SELECT (SELECT count(*)::int FROM social_transactions) AS transactions, (SELECT count(*)::int FROM social_coin_transfers) AS transfers,
       pg_size_pretty(pg_total_relation_size('social_transactions')) AS size`,
  );
  console.log(JSON.stringify(sizes.rows[0]));
  await admin.end();
}

type Statement = Readonly<{ name: string; sql: string; values: unknown[] }>;

async function bench() {
  const web = createPool(urlAs(URL_, "blast_web"), { max: 2 });
  // Only to find a deep cursor for the bench; the route itself never pages by OFFSET.
  const deep = (await web.query<{ created_at_ms: string; tx_id: string }>(
    `SELECT created_at_ms::text, tx_id::text FROM social_transactions WHERE account_id = $1 ORDER BY created_at_ms DESC, tx_id OFFSET ${DEEP - 1} LIMIT 1`,
    [HEAVY],
  )).rows[0]!;
  const typicalCount = (await web.query<{ n: number }>("SELECT count(*)::int AS n FROM social_transactions WHERE account_id = $1", [TYPICAL])).rows[0]!.n;
  const known = (await web.query<{ tx_id: string; account_id: string; idempotency_key: string; kind: string; presale_id: string | null; amount: string }>(
    "SELECT tx_id::text, account_id::text, idempotency_key, kind, presale_id, amount::text FROM social_transactions WHERE account_id = $1 AND state = 'submitted' LIMIT 1",
    [TYPICAL],
  )).rows[0]!;
  console.log(JSON.stringify({ deepCursor: encodeTransactionsCursor({ createdAtMs: deep.created_at_ms, txId: deep.tx_id }), typicalCount }));
  const insertSql = `INSERT INTO social_transactions (tx_id, account_id, kind, state, digest, presale_id, coin_type, amount, quote_type, quote_amount,
       usd_value, idempotency_key, created_at_ms, settled_at_ms, failure_code)
     VALUES ($1::uuid, $2::uuid, $3, 'submitted', NULL, $4, $5, $6::numeric, NULL, NULL, NULL, $7, (extract(epoch FROM now()) * 1000)::bigint, NULL, NULL)
     ON CONFLICT (account_id, idempotency_key) DO NOTHING
     RETURNING ${TRANSACTION_COLUMNS}`;
  const statements: Statement[] = [
    { name: `the list's first page (heavy account, ${HEAVY_TRANSACTIONS.toLocaleString("en")} rows)`, sql: TRANSACTIONS_FIRST_PAGE_SQL, values: [HEAVY, PAGE + 1] },
    {
      name: `the list's deep page (heavy account, ${DEEP.toLocaleString("en")} rows in)`,
      sql: TRANSACTIONS_NEXT_PAGE_SQL,
      values: [HEAVY, deep.created_at_ms, deep.tx_id, PAGE + 1],
    },
    { name: "the list's first page (a typical account)", sql: TRANSACTIONS_FIRST_PAGE_SQL, values: [TYPICAL, PAGE + 1] },
    { name: "the list's first page (an id with no rows)", sql: TRANSACTIONS_FIRST_PAGE_SQL, values: [id(ACCOUNTS + 1), PAGE + 1] },
    {
      name: "log a new transaction (insert, rolled back)",
      sql: insertSql,
      values: ["0b8f6a52-6c1e-4d0b-9a57-3f2c1d4e5a6b", TYPICAL, "withdraw", null, USDC, "100000000", "withdraw:scale-new"],
    },
    {
      name: "log a repeat (conflict on the key, nothing inserted)",
      sql: insertSql,
      values: [id(0xfeed), known.account_id, known.kind, known.presale_id, USDC, known.amount, known.idempotency_key],
    },
    {
      name: "read the repeat's row under lock",
      sql: `SELECT ${TRANSACTION_COLUMNS} FROM social_transactions WHERE account_id = $1::uuid AND idempotency_key = $2 FOR UPDATE`,
      values: [known.account_id, known.idempotency_key],
    },
    {
      name: "move it forward (digest and outcome, rolled back)",
      sql: `UPDATE social_transactions SET state = $2, digest = $3, failure_code = $5,
              settled_at_ms = CASE WHEN $2 = 'submitted' THEN NULL ELSE GREATEST(COALESCE($4::bigint, (extract(epoch FROM now()) * 1000)::bigint), created_at_ms) END
            WHERE tx_id = $1::uuid AND state = 'submitted' RETURNING ${TRANSACTION_COLUMNS}`,
      values: [known.tx_id, "confirmed", "4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi", null, null],
    },
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
      } finally {
        await client.query("ROLLBACK").catch(() => undefined);
        client.release();
      }
    }
    // The recorded plan is one more run in its own rolled-back transaction, so a write's plan is the write's, not a repeat's.
    const client = await web.connect();
    try {
      await client.query("BEGIN");
      const text = await client.query<Record<string, string>>(`EXPLAIN (ANALYZE, BUFFERS) ${statement.sql}`, statement.values);
      plan = text.rows.map((row) => row["QUERY PLAN"]).join("\n");
    } finally {
      await client.query("ROLLBACK").catch(() => undefined);
      client.release();
    }
    times.sort((a, b) => a - b);
    const pct = (p: number) => times[Math.min(times.length - 1, Math.ceil((p / 100) * times.length) - 1)]!.toFixed(2);
    console.log(`${statement.name}: p50 ${pct(50)} ms, p95 ${pct(95)} ms`);
    plans.push(`== ${statement.name} ==\n${plan}\n`);
  }
  fs.mkdirSync("loadtest/results", { recursive: true });
  fs.writeFileSync("loadtest/results/social-transactions-scale-plans.txt", plans.join("\n"));
  await web.end();
}

if (process.argv[2] === "seed") await seed();
else if (process.argv[2] === "bench") await bench();
else throw new Error("Usage: social-transactions-scale.ts seed|bench");
