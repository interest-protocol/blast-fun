// Social feed R3-63 scale evidence: the claim route's reads and the social
// worker's claim steps at launch scale, with their plans (EXPLAIN ANALYZE,
// BUFFERS), each as the role that runs it — `blast_web` for the route,
// `blast_watcher` for the worker — inside a transaction it rolls back.
//
//   SOCIAL_SCALE_DATABASE_URL=postgresql://postgres:<pw>@127.0.0.1:<port>/<db> \
//     node --no-warnings --import ./scripts/test-tsx-hooks.mjs --experimental-strip-types scripts/loadtest/social-claims-scale.ts seed|bench
//
// The database must be a disposable loopback Postgres (seed resets it).
// `seed` builds 10k accounts with a wallet each, 2,000 shown presales, 200k
// presale positions keyed as blast-infra keys them `(presale_id, wallet)`,
// 1,000,000 activity rows (with blast-infra's `digest` index), 1,000,000
// logged transactions (R3-27's shape), and the claims in flight beside them:
// 2,000 open claims whose transaction the indexer shows (four worker
// batches), 1,000 sent but never seen, 2,000 never sent (half past the hour).
// That ratio is the point: the claim steps must cost what is in flight,
// never the log's million rows. `bench` prints p50/p95 per statement and
// writes loadtest/results/social-claims-scale-plans.txt.
import fs from "node:fs";

import { migrateDatabase } from "@blast/core/modules/database/migrations.ts";
import { createPool } from "@blast/core/modules/database/pool.ts";
import { CHAIN_FIXTURE, resetSharedDatabase, urlAs } from "../../packages/core/test/fixtures/modules/database/role-fixtures.ts";
import { CLAIM_POSITION_SQL, CLAIM_ROW_SQL } from "@blast/server/modules/social/claims/store.ts";
import { CLAIM_STATEMENTS } from "../../apps/workers/src/modules/social/claims/settle.ts";
import { CLAIM_SENT_EXPIRY_MS, CLAIM_UNSENT_EXPIRY_MS } from "@blast/core/modules/social/contracts/claims.ts";
import { SETTLE_LOGGED_SQL, TRANSACTION_COLUMNS } from "@blast/core/modules/social/transactions/log.ts";

const URL_ = process.env.SOCIAL_SCALE_DATABASE_URL ?? "";
if (!/^postgres(ql)?:\/\/[^@]+@(127\.0\.0\.1|localhost):\d+\/\w+$/.test(URL_)) {
  throw new Error("SOCIAL_SCALE_DATABASE_URL must name a disposable loopback database (seed resets it).");
}
const ACCOUNTS = 10_000, PRESALES = 2_000, POSITIONS_PER_WALLET = 20, ACTIVITY = 1_000_000, LOGGED = 1_000_000;
const SEEN = 2_000, UNSEEN = 1_000, UNSENT = 2_000, BATCH = 500, RUNS = 50;
const NOW = 1_790_000_000_000 + LOGGED * 37 + 3_600_000;
const USDC = "0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC";
const uuid = (n: string) => `('00000000-0000-4000-8000-' || lpad(to_hex(${n}), 12, '0'))::uuid`;
const wallet = (n: string) => `('0x' || lpad('7a11' || lpad(to_hex(${n}), 8, '0'), 64, '0'))`;
const presale = (n: string) => `('0x' || lpad('5a1e' || lpad(to_hex(${n}), 6, '0'), 64, '0'))`;
/** A base58 digest, injective in `n` (`0` maps to `g`, padding is `z`; neither is hex). */
const digest = (prefix: string, n: string) => `('${prefix}' || translate(lpad(to_hex(${n}), 41, 'z'), '0', 'g'))`;

async function seed() {
  const admin = createPool(URL_, { max: 2 });
  await resetSharedDatabase(admin);
  await admin.query(CHAIN_FIXTURE);
  await migrateDatabase(admin);
  await admin.query(
    `INSERT INTO social_accounts (account_id, privy_did, callsign, onboarded_at, privacy, sharing_since)
     SELECT ${uuid("n")}, 'did:privy:scale-' || n, 'acct_' || n, now(), 'public', now() FROM generate_series(1, ${ACCOUNTS}) n`,
  );
  await admin.query(
    `INSERT INTO social_account_wallets (address, account_id, kind, verified_at)
     SELECT ${wallet("n")}, ${uuid("n")}, 'slush', now() - interval '60 days' FROM generate_series(1, ${ACCOUNTS}) n`,
  );
  // 2,000 shown sales: a tenth cancelled, two fifths migrated, the rest open or funded.
  await admin.query(
    `INSERT INTO blast_infra_fixture.presales
     SELECT ${presale("n")}, ${presale("n")} || '::coin::C' || n, '${USDC}', 'C' || n, 'Coin ' || n, 'https://i/c.png', 9, 'USDC', 6,
       (ARRAY['cancelled','migrated','migrated','migrated','migrated','open','open','funded','funded','open'])[1 + n % 10],
       ${NOW} - 86400000 * 9, ${NOW} - 86400000 * 2, 100000000000, 1000000, NULL, 120000000000, 100, 'cetus', NULL, 1
     FROM generate_series(1, ${PRESALES}) n`,
  );
  // 200k positions: every wallet in 20 sales; a third of the settled ones already claimed.
  await admin.query(
    `INSERT INTO blast_infra_fixture.presale_positions
     SELECT ${presale(`1 + (w * 7 + k * 101) % ${PRESALES}`)}, ${wallet("w")}, 250000000, ${NOW} - 86400000 * 3,
       CASE WHEN (w + k) % 3 = 0 THEN ${digest("Pc", `w * 100 + k`)} END,
       CASE WHEN (w + k) % 3 = 0 THEN 0 END, CASE WHEN (w + k) % 3 = 0 THEN 250000000 END,
       CASE WHEN (w + k) % 3 = 0 THEN ${NOW} - 86400000 END
     FROM generate_series(1, ${ACCOUNTS}) w CROSS JOIN generate_series(1, ${POSITIONS_PER_WALLET}) k
     ON CONFLICT DO NOTHING`,
  );
  // 1M activity rows (commits, a fifth of them claims), the newest at the watermark.
  await admin.query(
    `INSERT INTO blast_infra_fixture.activity
     SELECT 100000 + n, 0, 0, 0, ${NOW} - (${ACTIVITY} - n) * 30, ${digest("As", "n")},
       CASE WHEN n % 5 = 0 THEN 'presale_claim' ELSE 'presale_commit' END, 'presale',
       ${wallet(`1 + n % ${ACCOUNTS}`)}, ${wallet(`1 + n % ${ACCOUNTS}`)}, ${presale(`1 + n % ${PRESALES}`)}, NULL, '${USDC}',
       250000000, NULL, NULL, 250, NULL, NULL, NULL, NULL
     FROM generate_series(1, ${ACTIVITY}) n`,
  );
  await admin.query("CREATE INDEX IF NOT EXISTS activity_digest ON blast_infra_fixture.activity (digest)");
  await admin.query(
    `UPDATE watermarks SET checkpoint_hi_inclusive = ${100_000 + ACTIVITY}, timestamp_ms_hi_inclusive = ${NOW} WHERE pipeline = 'presale'`,
  );
  // 1M logged transactions, R3-27's shape (kinds rotate; confirmed, failed, a few still submitted with a digest).
  await admin.query(
    `INSERT INTO social_transactions (tx_id, account_id, kind, state, digest, presale_id, coin_type, amount, usd_value,
       idempotency_key, created_at_ms, settled_at_ms, failure_code)
     SELECT ${uuid("1000000 + n")}, ${uuid(`1 + n % ${ACCOUNTS}`)}, k.kind, s.state, ${digest("Lg", "n")},
       CASE WHEN k.kind IN ('commit', 'claim_refund', 'claim_tokens', 'claim_vesting') THEN ${presale(`1 + n % ${PRESALES}`)} END,
       '${USDC}', (1000000 + n)::numeric, ((1000000 + n) / 1000000.0)::numeric(20, 2),
       k.kind || ':' || n, 1790000000000 + n * 37, CASE WHEN s.state = 'submitted' THEN NULL ELSE 1790000000000 + n * 37 + 1500 END,
       CASE WHEN s.state = 'failed' THEN 'execution_failed' END
     FROM generate_series(1, ${LOGGED}) n
     CROSS JOIN LATERAL (SELECT (ARRAY['commit', 'withdraw', 'claim_refund', 'claim_tokens', 'deposit', 'commit'])[1 + n % 6] AS kind) k
     CROSS JOIN LATERAL (SELECT CASE WHEN k.kind NOT LIKE 'claim%' AND n % 50 = 0 THEN 'submitted' WHEN n % 41 = 0 THEN 'failed' ELSE 'confirmed' END AS state) s`,
  );
  // The claims in flight: seen (their digest is a claim the indexer shows, paid to the row's own wallet),
  // sent but never seen, and never sent (half of them past the hour).
  await admin.query(
    `INSERT INTO social_transactions (tx_id, account_id, kind, state, digest, presale_id, quote_type, quote_amount, idempotency_key, created_at_ms)
     SELECT ${uuid("5000000 + c")}, ${uuid(`1 + a.n % ${ACCOUNTS}`)}, 'claim_refund', 'submitted', a.digest, a.presale_id, '${USDC}', 250000000,
       'claim_refund:seen-' || c, ${NOW} - 600000 + c
     FROM generate_series(1, ${SEEN}) c
     JOIN LATERAL (SELECT ${ACTIVITY} - c * 5 AS n) pick ON TRUE
     JOIN LATERAL (SELECT digest, presale_id, pick.n AS n FROM blast_infra_fixture.activity WHERE checkpoint = 100000 + pick.n) a ON TRUE`,
  );
  await admin.query(
    `INSERT INTO social_transactions (tx_id, account_id, kind, state, digest, presale_id, idempotency_key, created_at_ms)
     SELECT ${uuid("6000000 + c")}, ${uuid(`1 + c % ${ACCOUNTS}`)}, 'claim_tokens', 'submitted',
       CASE WHEN c <= ${UNSEEN} THEN ${digest("Un", "c")} END, ${presale(`1 + c % ${PRESALES}`)}, 'claim_tokens:open-' || c,
       CASE WHEN c <= ${UNSEEN} THEN ${NOW} - 7200000 - c ELSE ${NOW} - (CASE WHEN c % 2 = 0 THEN ${CLAIM_UNSENT_EXPIRY_MS} + 60000 ELSE 600000 END) - c END
     FROM generate_series(1, ${UNSEEN + UNSENT}) c`,
  );
  await admin.query("ANALYZE");
  console.log(JSON.stringify((await admin.query(
    `SELECT (SELECT count(*)::int FROM social_transactions) AS logged,
       (SELECT count(*)::int FROM social_transactions WHERE state = 'submitted' AND kind LIKE 'claim%') AS open_claims,
       (SELECT count(*)::int FROM blast_infra_fixture.presale_positions) AS positions,
       (SELECT count(*)::int FROM blast_infra_fixture.activity) AS activity,
       pg_size_pretty(pg_total_relation_size('social_transactions')) AS log_size,
       pg_size_pretty(pg_relation_size('social_transactions_open_claims_idx')) AS open_claims_index`,
  )).rows[0]));
  await admin.end();
}

type Statement = Readonly<{ name: string; role: "blast_web" | "blast_watcher"; sql: string; values: unknown[] }>;

async function bench() {
  const admin = createPool(URL_, { max: 1 });
  const known = (await admin.query<{ presale_id: string; wallet: string }>(
    `SELECT presale_id, wallet FROM blast_infra_fixture.presale_positions WHERE claim_digest IS NULL ORDER BY wallet DESC LIMIT 1`,
  )).rows[0]!;
  const open = (await admin.query<{ tx_id: string; account_id: string; idempotency_key: string; digest: string }>(
    `SELECT tx_id::text, account_id::text, idempotency_key, digest FROM social_transactions
     WHERE state = 'submitted' AND kind = 'claim_refund' AND digest IS NOT NULL ORDER BY created_at_ms LIMIT 1`,
  )).rows[0]!;
  await admin.end();
  const statements: Statement[] = [
    { name: "record: the Blast wallet's position in one sale", role: "blast_web", sql: CLAIM_POSITION_SQL, values: [known.presale_id, known.wallet] },
    { name: "record: the attempt by its id", role: "blast_web", sql: CLAIM_ROW_SQL, values: [open.tx_id] },
    {
      name: "record: log a new claim (insert, rolled back)",
      role: "blast_web",
      sql: `INSERT INTO social_transactions (tx_id, account_id, kind, state, digest, presale_id, quote_type, quote_amount, usd_value, idempotency_key)
            VALUES ($1::uuid, $2::uuid, 'claim_refund', 'submitted', NULL, $3, $4, 250000000, 250, $5)
            ON CONFLICT (account_id, idempotency_key) DO NOTHING RETURNING ${TRANSACTION_COLUMNS}`,
      values: ["0b8f6a52-6c1e-4d0b-9a57-3f2c1d4e5a6b", open.account_id, known.presale_id, USDC, "claim_refund:0b8f6a52-6c1e-4d0b-9a57-3f2c1d4e5a6b"],
    },
    { name: `worker: the settle batch (${BATCH} of ${SEEN} seen, ${UNSEEN} unseen, ${UNSENT} unsent)`, role: "blast_watcher", sql: CLAIM_STATEMENTS.settleBatch, values: [100_000 + ACTIVITY, BATCH] },
    { name: "worker: settle one row by its key (rolled back)", role: "blast_watcher", sql: SETTLE_LOGGED_SQL, values: [open.account_id, open.idempotency_key, "confirmed", open.digest, null, NOW] },
    { name: "worker: the expiry sweep (rolled back)", role: "blast_watcher", sql: CLAIM_STATEMENTS.expire, values: [NOW - CLAIM_UNSENT_EXPIRY_MS, NOW - CLAIM_SENT_EXPIRY_MS, NOW] },
  ];
  const plans: string[] = [];
  const results: Record<string, { p50: number; p95: number }> = {};
  for (const statement of statements) {
    const pool = createPool(urlAs(URL_, statement.role), { max: 1 });
    const times: number[] = [];
    for (let run = 0; run < RUNS + 3; run += 1) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const result = await client.query<{ "QUERY PLAN": unknown }>(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${statement.sql}`, statement.values);
        const json = (result.rows[0]!["QUERY PLAN"] as { "Planning Time": number; "Execution Time": number }[])[0]!;
        if (run >= 3) times.push(json["Planning Time"] + json["Execution Time"]);
      } finally {
        await client.query("ROLLBACK").catch(() => undefined);
        client.release();
      }
    }
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const text = await client.query<Record<string, string>>(`EXPLAIN (ANALYZE, BUFFERS) ${statement.sql}`, statement.values);
      plans.push(`== ${statement.name} (as ${statement.role}) ==\n${text.rows.map((row) => row["QUERY PLAN"]).join("\n")}\n`);
    } finally {
      await client.query("ROLLBACK").catch(() => undefined);
      client.release();
    }
    await pool.end();
    times.sort((a, b) => a - b);
    const pct = (p: number) => Number(times[Math.min(times.length - 1, Math.ceil((p / 100) * times.length) - 1)]!.toFixed(2));
    results[statement.name] = { p50: pct(50), p95: pct(95) };
    console.log(`${statement.name}: p50 ${pct(50)} ms, p95 ${pct(95)} ms`);
  }
  fs.mkdirSync("loadtest/results", { recursive: true });
  fs.writeFileSync("loadtest/results/social-claims-scale-plans.txt", plans.join("\n"));
  fs.writeFileSync("loadtest/results/social-claims-scale-timings.json", `${JSON.stringify(results, null, 2)}\n`);
}

if (process.argv[2] === "seed") await seed();
else if (process.argv[2] === "bench") await bench();
else throw new Error("Usage: social-claims-scale.ts seed|bench");
