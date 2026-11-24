// R3-29 scale evidence: the interested count (a sale's current presale
// follows) at launch scale. `seed` builds a disposable database: 10k accounts,
// 2,000 sales (a fifth upcoming, pessimistic for the interest order), 160k
// positions, 1M activity rows over 60 days, and 100k follows, every one of them
// a presale follow (pessimistic: the count reads only those): one upcoming sale
// at the gate's 4,020, half the rest on a hot head of 200 sales, the other half
// spread. `bench` runs, as `blast_replica`, the statements that read the count
// under EXPLAIN (ANALYZE), planning + execution, SCALE_RUNS times after 3
// warm-ups, and the whole reads as the route runs them:
//
// - the summary statement for the 200 most-followed sales in one statement
//   (the list's page and the lanes' pages read it for at most 50 each);
// - the upcoming tab's interest order (its key statement counts every
//   upcoming sale) and the whole upcoming read in that order;
// - the lanes' three list reads (upcoming, live, ended at 50).
// - live/fastest and ended/best key statements and whole pages; JIT-off plans
//   are diagnostic controls only. `index` adds a fixture-only claim-sample
//   covering index, asserts unchanged results/cursor, then reruns the benchmark.
//
//   SOCIAL_SCALE_DATABASE_URL=postgresql://postgres:<pw>@127.0.0.1:<port>/<db> \
//     node --no-warnings --import ./scripts/test-tsx-hooks.mjs --experimental-strip-types loadtest/social-interested-scale.ts seed|bench|index
//
// The database must be a disposable loopback Postgres (seed resets it). bench
// writes loadtest/results/social-interested-scale-timings.json and -plans.txt.
import fs from "node:fs";
import assert from "node:assert/strict";

import pg from "pg";

import { migrateDatabase } from "@blast/core/modules/database/migrations.ts";
import { createPool } from "@blast/core/modules/database/pool.ts";
import { CHAIN_FIXTURE, advanceWatermark, resetSharedDatabase, urlAs } from "../../../packages/core/test/fixtures/modules/database/role-fixtures.ts";
import { autocommitReader, type ReadableDatabase } from "@blast/core/modules/database/transaction.ts";
import { PRESALE_LIST_SORTS, type PresaleListSort, type PresaleListStatus } from "@blast/core/modules/social/contracts/presales.ts";
import { readPresaleListPage } from "@blast/server/modules/social/presales/route.ts";
import { readSummaries } from "@blast/server/modules/social/presales/summary.ts";

const URL_ = process.env.SOCIAL_SCALE_DATABASE_URL ?? "";
if (!/^postgres(ql)?:\/\/[^@]+@(127\.0\.0\.1|localhost):\d+\/\w+$/.test(URL_)) {
  throw new Error("SOCIAL_SCALE_DATABASE_URL must name a disposable loopback database (seed resets it).");
}
const DAY = 86_400_000;
const NOW = Date.now();
const RUNS = Number(process.env.SCALE_RUNS ?? 50);
const ACCOUNTS = 10_000, PRESALES = 2_000, ACTIVITY = 1_000_000, FOLLOWS = 100_000, POSITIONS_PER_SALE = 100;
/** The gate's `4,020 interested`, as real follows of one upcoming sale. */
const HEAVY = 4_020;
const HOT = 200;
const presaleId = (n: string) => `'0x' || lpad('5a1e' || to_hex(${n}), 64, '0')`;
const accountId = (n: string) => `('00000000-0000-4000-8000-' || lpad(to_hex(${n}), 12, '0'))::uuid`;
/** Lifecycle by `n % 10`: 0-1 pending (400), 2-3 open (400), 4 funded (200), 5-8 migrated (800), 9 cancelled (200). */
const LIFECYCLE = `(ARRAY['pending','pending','open','open','funded','migrated','migrated','migrated','migrated','cancelled'])[1 + n % 10]`;

async function seed() {
  const admin = createPool(URL_, { max: 2 });
  await resetSharedDatabase(admin);
  await admin.query(CHAIN_FIXTURE);
  await migrateDatabase(admin);
  // blast-infra's activity access paths (spec AC-148).
  await admin.query(`
    CREATE INDEX activity_time ON blast_infra_fixture.activity (timestamp_ms DESC);
    CREATE INDEX activity_actor_time ON blast_infra_fixture.activity (actor, timestamp_ms DESC);
    CREATE INDEX activity_presale_time ON blast_infra_fixture.activity (presale_id, timestamp_ms DESC);
    CREATE INDEX activity_coin_time ON blast_infra_fixture.activity (coin_type, timestamp_ms DESC);`);
  await admin.query(
    `INSERT INTO blast_infra_fixture.presales
       (presale_id, sale_token, quote_type, sale_symbol, sale_name, sale_icon_url, sale_decimals, quote_symbol, quote_decimals,
        lifecycle, start_ms, end_ms, raise_target, min_commitment, wallet_cap, total_commitments, participants, venue, pool_id, updated_checkpoint)
     SELECT ${presaleId("n")}, ${presaleId("n")} || '::coin::S' || n, '0x' || lpad('dba3', 64, '0') || '::usdc::USDC',
       'S' || n, 'Sale ' || n, 'https://cdn.blast.fun/s' || n || '.png', 9, 'USDC', 6, l.lifecycle,
       CASE l.lifecycle WHEN 'pending' THEN $1::bigint + (1 + n % 14)::bigint * ${DAY} WHEN 'open' THEN $1::bigint - 2::bigint * ${DAY} ELSE $1::bigint - (10 + n % 300)::bigint * ${DAY} END,
       CASE l.lifecycle WHEN 'pending' THEN $1::bigint + (4 + n % 14)::bigint * ${DAY} WHEN 'open' THEN $1::bigint + (1 + n % 5)::bigint * ${DAY} ELSE $1::bigint - (7 + n % 300)::bigint * ${DAY} END,
       250000000000, 10000000, 25000000000,
       CASE l.lifecycle WHEN 'pending' THEN 0 WHEN 'cancelled' THEN 61200000000 ELSE 250000000000 END,
       CASE l.lifecycle WHEN 'pending' THEN 0 ELSE ${POSITIONS_PER_SALE} END,
       CASE WHEN n % 2 = 0 THEN 'cetus' ELSE 'bluefin' END, NULL, 1
     FROM generate_series(0, ${PRESALES - 1}) n, LATERAL (SELECT ${LIFECYCLE} AS lifecycle) l`,
    [NOW],
  );
  await admin.query(
    `INSERT INTO blast_infra_fixture.presale_lifecycle
     SELECT p.presale_id, s.state, 'Life' || p.presale_id || s.state, p.end_ms + s.k::bigint * 3600000, 1
     FROM blast_infra_fixture.presales p
     CROSS JOIN LATERAL (VALUES ('opened', -72), ('funded', 1), ('migrated', 2), ('cancelled', 1)) s(state, k)
     WHERE (s.state = 'opened' AND p.lifecycle <> 'pending') OR (s.state = 'funded' AND p.lifecycle IN ('funded', 'migrated'))
       OR (s.state = 'migrated' AND p.lifecycle = 'migrated') OR (s.state = 'cancelled' AND p.lifecycle = 'cancelled')`,
  );
  await admin.query(
    `INSERT INTO blast_infra_fixture.prices
     SELECT sale_token, 0.0005 + (abs(hashtext(presale_id)) % 1000) * 0.00001, $1::bigint, 'pool' FROM blast_infra_fixture.presales WHERE lifecycle = 'migrated'
     UNION ALL SELECT '0x' || lpad('dba3', 64, '0') || '::usdc::USDC', 1, $1::bigint, 'pyth'`,
    [NOW],
  );
  // 100 positions per started sale; a migrated sale's are claimed (its presale price comes from the claims).
  await admin.query(
    `INSERT INTO blast_infra_fixture.presale_positions
       (presale_id, wallet, commitment, last_commit_ms, claim_digest, claimed_tokens, claimed_quote_refund, claimed_ms)
     SELECT p.presale_id, '0x' || lpad('a11e7' || to_hex(1 + (w * 97 + abs(hashtext(p.presale_id))) % ${ACCOUNTS}), 64, '0'), 2500000000,
       p.start_ms + w::bigint * 60000,
       CASE WHEN p.lifecycle = 'migrated' THEN 'Claim' || w END, CASE WHEN p.lifecycle = 'migrated' THEN 5000000000000 END,
       CASE WHEN p.lifecycle = 'migrated' THEN 0 END, CASE WHEN p.lifecycle = 'migrated' THEN p.end_ms + 86400000 END
     FROM blast_infra_fixture.presales p CROSS JOIN generate_series(0, ${POSITIONS_PER_SALE - 1}) w
     WHERE p.lifecycle <> 'pending'
     ON CONFLICT DO NOTHING`,
  );
  // 1M activity rows over 60 days on the started sales.
  for (let start = 0; start < ACTIVITY; start += 200_000) {
    await admin.query(
      `INSERT INTO blast_infra_fixture.activity
       SELECT 100000 + i, 0, 0, 0, $1::bigint - (hashint % 5184000000), 'Dg' || i,
         CASE WHEN k < 90 THEN 'presale_commit' ELSE 'presale_claim' END, 'presale',
         actor, actor, ${presaleId("p")}, NULL, '0x' || lpad('dba3', 64, '0') || '::usdc::USDC',
         (10 + (hashint % 5000))::bigint * 1000000, NULL, NULL, 10 + (hashint % 5000), $1::bigint, NULL, NULL, NULL
       FROM (
         SELECT i, abs(hashtext(i::text)) AS hashint, abs(hashtext('k' || i)) % 100 AS k,
           2 + (abs(hashtext('p' || i)) % ${PRESALES / 10}) * 10 + abs(hashtext('q' || i)) % 8 AS p,
           '0x' || lpad('a11e7' || to_hex(1 + abs(hashtext('w' || i)) % ${ACCOUNTS}), 64, '0') AS actor
         FROM generate_series($2::int, $3::int) i
       ) s`,
      [NOW, start, Math.min(start + 200_000, ACTIVITY) - 1],
    );
    console.log(`activity ${Math.min(start + 200_000, ACTIVITY)}`);
  }
  await admin.query(
    `INSERT INTO social_accounts (account_id, privy_did, callsign, display_name, privacy, sharing_since, onboarded_at)
     SELECT ${accountId("n")}, 'did:privy:scale-' || n, 'acct_' || n, 'Account ' || n,
       CASE WHEN n % 10 = 1 THEN 'private' ELSE 'public' END, CASE WHEN n % 10 = 1 THEN NULL ELSE now() - interval '400 days' END,
       now() - interval '400 days'
     FROM generate_series(1, ${ACCOUNTS}) n`,
  );
  // Follows: sale 0 (upcoming) at 4,020; then, to 100k, half on the hot head (sales 0-199), half over every sale.
  await admin.query(
    `INSERT INTO social_follows (follower_account_id, target_kind, target_id, source)
     SELECT ${accountId("n")}, 'presale', ${presaleId("0")}, 'user' FROM generate_series(1, ${HEAVY}) n`,
  );
  await admin.query(
    `INSERT INTO social_follows (follower_account_id, target_kind, target_id, source)
     SELECT ${accountId("a")}, 'presale', ${presaleId("p")}, 'user'
     FROM (
       SELECT DISTINCT ON (a, p) a, p FROM (
         SELECT 1 + abs(hashtext('fa' || i)) % ${ACCOUNTS} AS a,
           CASE WHEN i % 2 = 0 THEN abs(hashtext('fh' || i)) % ${HOT} ELSE abs(hashtext('fp' || i)) % ${PRESALES} END AS p
         FROM generate_series(1, ${Math.round(FOLLOWS * 1.1)}) i
       ) s WHERE p <> 0
     ) d
     LIMIT ${FOLLOWS - HEAVY}`,
  );
  await admin.query(advanceWatermark(2_000_000, 0, "market"));
  await admin.query(advanceWatermark(2_000_000, 0, "presale"));
  await admin.query("VACUUM ANALYZE");
  const counts = await admin.query(`SELECT
    (SELECT count(*) FROM social_accounts) accounts, (SELECT count(*) FROM blast_infra_fixture.presales) presales,
    (SELECT count(*) FROM blast_infra_fixture.presales WHERE lifecycle = 'pending') upcoming,
    (SELECT count(*) FROM blast_infra_fixture.presale_positions) positions, (SELECT count(*) FROM blast_infra_fixture.activity) activity,
    (SELECT count(*) FROM social_follows) follows, (SELECT count(*) FROM social_follows WHERE target_kind = 'presale') presale_follows,
    (SELECT max(c) FROM (SELECT count(*) c FROM social_follows GROUP BY target_id) m) most_followed,
    (SELECT pg_size_pretty(pg_relation_size('social_follows_target_idx'))) target_idx_size`);
  console.log(counts.rows[0]);
  await admin.end();
}

type Timing = { label: string; p50: number; p95: number; max: number; runs: number };

function summarize(label: string, samples: number[]): Timing {
  samples.sort((a, b) => a - b);
  const at = (q: number) => +samples[Math.min(samples.length - 1, Math.ceil(q * samples.length) - 1)]!.toFixed(2);
  const result = { label, p50: at(0.5), p95: at(0.95), max: +samples.at(-1)!.toFixed(2), runs: samples.length };
  console.log(JSON.stringify(result));
  return result;
}

type Statement = { text: string; values: readonly unknown[] };

/** One read's result and the statements it sends, in order. */
async function capture<T>(db: ReadableDatabase, run: (db: ReadableDatabase) => Promise<T>): Promise<{ statements: Statement[]; result: T }> {
  const statements: Statement[] = [];
  const result = await run({ read: (text, values = []) => { statements.push({ text, values }); return db.read(text, values); } } as ReadableDatabase);
  return { statements, result };
}

/** One statement under EXPLAIN (ANALYZE): planning + execution per run (3 warm-ups), and its plan once. */
async function explained(pool: pg.Pool, label: string, statement: Statement, plans: Record<string, string>): Promise<Timing> {
  const samples: number[] = [];
  for (let i = 0; i < RUNS + 3; i += 1) {
    const { rows } = await pool.query<{ "QUERY PLAN": [{ "Planning Time": number; "Execution Time": number }] }>(
      `EXPLAIN (ANALYZE, FORMAT JSON) ${statement.text}`, [...statement.values],
    );
    const [plan] = rows[0]!["QUERY PLAN"];
    if (i >= 3) samples.push(plan["Planning Time"] + plan["Execution Time"]);
  }
  const text = await pool.query<{ "QUERY PLAN": string }>(`EXPLAIN (ANALYZE, BUFFERS) ${statement.text}`, [...statement.values]);
  plans[label] = text.rows.map((row) => row["QUERY PLAN"]).join("\n");
  return summarize(label, samples);
}

/** A whole read as the route runs it (wall time, all statements). */
async function timed(label: string, run: () => Promise<unknown>): Promise<Timing> {
  const samples: number[] = [];
  for (let i = 0; i < RUNS + 3; i += 1) {
    const start = performance.now();
    // react-doctor-disable-next-line react-doctor/async-await-in-loop -- Measure benchmark cases and warm-up samples serially; overlapping queries would contaminate their latency.
    await run();
    if (i >= 3) samples.push(performance.now() - start);
  }
  return summarize(label, samples);
}

async function bench() {
  const replicaPool = new pg.Pool({ connectionString: urlAs(URL_, "blast_replica"), max: 4 });
  const replica = autocommitReader(replicaPool, "social");
  const timings: Timing[] = [];
  const plans: Record<string, string> = {};
  const nowMs = Date.now();

  // The 200 most-followed sales: the most index entries one statement can count.
  const top = (await replicaPool.query<{ target_id: string; n: string }>(
    `SELECT target_id, count(*) n FROM social_follows WHERE target_kind = 'presale' GROUP BY 1 ORDER BY 2 DESC, 1 LIMIT 200`,
  )).rows;
  const ids = top.map((row) => row.target_id);
  console.log(`200 sales: ${top.reduce((sum, row) => sum + Number(row.n), 0)} follows, ${top[0]!.n} on the most followed`);
  const { statements: [summary], result: rows } = await capture(replica, (db) => readSummaries(db, ids));
  if (rows.length !== 200 || rows.some((row) => !Number.isInteger(row.interested))) throw new Error("200 rows with an integer count expected");
  timings.push(await explained(replicaPool, "summary statement, 200 most-followed sales (one statement)", summary!, plans));
  timings.push(await timed("readSummaries, 200 most-followed sales (wall)", () => readSummaries(replica, ids)));

  // The upcoming tab in interest order: its key statement counts every upcoming sale.
  const interest = { status: "upcoming", sort: "interest", cursor: null, limit: 50 } as const;
  const { statements, result: page } = await capture(replica, (db) => readPresaleListPage(db, interest, nowMs));
  const key = statements.find((statement) => /ORDER BY r\.sort_key::numeric DESC/.test(statement.text));
  if (!key) throw new Error("the interest order's key statement was not captured");
  timings.push(await explained(replicaPool, "upcoming tab, interest order: key statement (every upcoming sale counted)", key, plans));
  console.log(`upcoming by interest: ${page.presales.slice(0, 3).map((row) => `${row.name} ${row.interested}`).join(", ")}`);
  timings.push(await timed("upcoming tab, interest order, 50 (whole read, wall)", () => readPresaleListPage(replica, interest, nowMs)));

  // The lanes' three reads, each at the route's ceiling.
  for (const status of ["upcoming", "live", "ended"] as const satisfies readonly PresaleListStatus[]) {
    const sort = PRESALE_LIST_SORTS[status][0] as PresaleListSort;
    // react-doctor-disable-next-line react-doctor/async-await-in-loop -- Measure benchmark cases and warm-up samples serially; overlapping queries would contaminate their latency.
    timings.push(await timed(`lanes: ${status} by ${sort}, 50 (whole read, wall)`, () =>
      readPresaleListPage(replica, { status, sort, cursor: null, limit: 50 }, nowMs)));
  }

  // Cold partner variants must cover the costly rankings, not only defaults.
  for (const request of [
    { status: "live", sort: "fastest", cursor: null, limit: 50 },
    { status: "ended", sort: "best", cursor: null, limit: 50 },
  ] as const) {
    const label = `${request.status}/${request.sort}`;
    const { statements: ranking } = await capture(replica, (db) => readPresaleListPage(db, request, nowMs));
    const statement = ranking.find((entry) => /ORDER BY r\.sort_key::numeric/.test(entry.text));
    if (!statement) throw new Error("Ranking key statement was not captured");
    timings.push(await explained(replicaPool, `${label}: key statement`, statement, plans));
    timings.push(await timed(`${label}: whole read`, () => readPresaleListPage(replica, request, nowMs)));
    // Diagnostic control only: do not alter runtime pool settings or budgets.
    const client = await replicaPool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL jit = off");
      const control = await client.query<{ "QUERY PLAN": string }>(`EXPLAIN (ANALYZE, BUFFERS) ${statement.text}`, [...statement.values]);
      plans[`${label}: diagnostic JIT off`] = control.rows.map((row) => row["QUERY PLAN"]).join("\n");
    } finally { await client.query("ROLLBACK"); client.release(); }
  }

  const load = fs.readFileSync("/proc/loadavg", "utf8").trim();
  fs.mkdirSync("loadtest/results", { recursive: true });
  fs.writeFileSync("loadtest/results/social-interested-scale-timings.json", JSON.stringify({ at: new Date().toISOString(), runs: RUNS, load, timings }, null, 1));
  fs.writeFileSync("loadtest/results/social-interested-scale-plans.txt",
    Object.entries(plans).map(([label, plan]) => `== ${label}\n${plan}\n`).join("\n"));
  console.log(`host load ${load}`);
  await replicaPool.end();
}

/** Fixture-only index experiment; never sends DDL to a hosted database. */
async function indexed() {
  const admin = createPool(URL_, { max: 1 });
  const replicaPool = new pg.Pool({ connectionString: urlAs(URL_, "blast_replica"), max: 2 });
  const replica = autocommitReader(replicaPool, "social");
  const request = { status: "ended", sort: "best", cursor: null, limit: 50 } as const;
  const nowMs = Date.now();
  try {
    const before = await readPresaleListPage(replica, request, nowMs);
    await admin.query(`CREATE INDEX presale_claim_sample_cover ON blast_infra_fixture.presale_positions
      (presale_id, wallet) INCLUDE (commitment, claimed_quote_refund, claimed_tokens)
      WHERE claim_digest IS NOT NULL AND claimed_tokens > 0`);
    const after = await readPresaleListPage(replica, request, nowMs);
    assert.deepEqual(after.presales, before.presales);
    assert.equal(after.next_cursor, before.next_cursor);
    console.log(JSON.stringify((await admin.query(`SELECT pg_size_pretty(pg_relation_size('blast_infra_fixture.presale_claim_sample_cover')) AS claim_cover_size`)).rows[0]));
  } finally { await Promise.all([admin.end(), replicaPool.end()]); }
  await bench();
}

const command = process.argv[2];
if (command === "seed") await seed();
else if (command === "bench") await bench();
else if (command === "index") await indexed();
else throw new Error("usage: social-interested-scale.ts seed|bench|index");
