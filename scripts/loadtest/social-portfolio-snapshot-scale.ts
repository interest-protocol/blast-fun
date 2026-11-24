// OA-25 Q16 scale evidence: the daily portfolio snapshot (0097) and the gold
// card's trend read over it, at the coordinator's scale.
//
// `seed` builds a disposable database: 100,000 accounts (SCALE_ACCOUNTS) each
// with one wallet linked, 2,000 shown sales (USDC- and SUI-quoted, every
// lifecycle) with pool prices for the migrated ones, 200,000 presale
// positions and 100,000 sale-coin balances with blast-infra's wallet and owner
// indexes (`presale_wallets_address`, `sale_coin_balances_owner`), and 400
// days (SCALE_DAYS) of snapshots for every account — 40,000,000 rows, written
// day by day as the worker writes them (so one account's days are on as many
// heap pages as it has days), 1% of them skipped. The table is UNLOGGED for
// the load (no WAL; reads are the same) and its key is rebuilt after it.
//
// `bench` measures, as `blast_web` (the owner's portfolio, primary) and
// `blast_replica` (an opted-in public portfolio), SCALE_RUNS runs after 3
// warm-ups over random accounts:
//
// - the trend read (`trend.ts`): EXPLAIN (ANALYZE, BUFFERS) planning +
//   execution, and the whole `readPortfolioTrend` call;
// - a keyset page 300 days back (the paging the read supports);
// - the worker's statements for one 100-account batch (`snapshots.ts`): the
//   sweep's page, the addresses, positions, sale coins and prices, the upsert
//   and the retention delete (each in a rolled-back transaction), the retry
//   page; and a whole pass of the step (stub fullnode, no latency) over a new
//   day.
//
// A sequential scan of the snapshots, a sort in the trend read, or a scan of
// the positions or balances fails the run (SCALE_STRICT=0 skips the checks for
// a small smoke run).
//
//   SOCIAL_SCALE_DATABASE_URL=postgresql://postgres:<pw>@127.0.0.1:<port>/<db> \
//     node --no-warnings --import ./scripts/test-tsx-hooks.mjs --experimental-strip-types scripts/loadtest/social-portfolio-snapshot-scale.ts seed|bench
//
// The database must be a disposable loopback Postgres (seed resets it). bench
// writes loadtest/results/social-portfolio-snapshot-scale-timings.json and -plans.txt.
import fs from "node:fs";

import pg from "pg";

import { migrateDatabase } from "@blast/core/modules/database/migrations.ts";
import { createPool } from "@blast/core/modules/database/pool.ts";
import { CHAIN_FIXTURE, advanceWatermark, resetSharedDatabase, urlAs } from "../../packages/core/test/fixtures/modules/database/role-fixtures.ts";
import { autocommitReader, withTransaction } from "@blast/core/modules/database/transaction.ts";
import { PORTFOLIO_SNAPSHOT_STATEMENTS, portfolioSnapshotSteps, utcDay } from "../../apps/workers/src/modules/social/portfolio/snapshots.ts";
import { PORTFOLIO_TREND_STATEMENTS, readPortfolioSnapshots, readPortfolioTrend } from "@blast/server/modules/social/portfolio/trend.ts";
import { PORTFOLIO_COIN_TYPES } from "@blast/core/modules/social/portfolio/read.ts";
import { USDC_COIN_TYPE } from "@blast/core/lib/sui/coin-types.ts";

const URL_ = process.env.SOCIAL_SCALE_DATABASE_URL ?? "";
if (!/^postgres(ql)?:\/\/[^@]+@(127\.0\.0\.1|localhost):\d+\/\w+$/.test(URL_)) {
  throw new Error("SOCIAL_SCALE_DATABASE_URL must name a disposable loopback database (seed resets it).");
}
const DAY = 86_400_000;
const RUNS = Number(process.env.SCALE_RUNS ?? 200);
const ACCOUNTS = Number(process.env.SCALE_ACCOUNTS ?? 100_000);
const DAYS = Number(process.env.SCALE_DAYS ?? 400);
const PRESALES = 2_000;
const BATCH = 100;
/** SCALE_STRICT=0 skips the plan checks (a small smoke run, where a sequential scan is the right plan). */
const STRICT = process.env.SCALE_STRICT !== "0";
const SUI = PORTFOLIO_COIN_TYPES.sui;
const presaleId = (n: string) => `'0x' || lpad('5a1e' || to_hex(${n}), 64, '0')`;
const saleToken = (n: string) => `${presaleId(n)} || '::coin::S' || ${n}`;
const accountId = (n: string) => `('00000000-0000-4000-8000-' || lpad(to_hex(${n}), 12, '0'))::uuid`;
const wallet = (n: string) => `'0x' || lpad('a11e7' || to_hex(${n}), 64, '0')`;
/** Lifecycle by `n % 10`: 0-1 pending, 2-3 open, 4 funded, 5-8 migrated, 9 cancelled. */
const LIFECYCLE = `(ARRAY['pending','pending','open','open','funded','migrated','migrated','migrated','migrated','cancelled'])[1 + n % 10]`;
const account = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
/** Today, UTC: the seeded history ends yesterday, so the bench's pass is a new day's sweep. */
const TODAY = utcDay(Date.now());

async function seed() {
  const admin = createPool(URL_, { max: 2 });
  await resetSharedDatabase(admin);
  await admin.query(CHAIN_FIXTURE);
  await migrateDatabase(admin);
  const now = Date.now();
  // blast-infra's access paths for the worker's holdings reads.
  await admin.query(`
    CREATE INDEX presale_wallets_address ON blast_infra_fixture.presale_positions (wallet);
    CREATE INDEX sale_coin_balances_owner ON blast_infra_fixture.coin_balances (owner, coin_type);`);
  await admin.query(
    `INSERT INTO blast_infra_fixture.presales
     SELECT ${presaleId("n")}, ${saleToken("n")}, CASE WHEN n % 3 = 0 THEN $3 ELSE $2 END,
       'S' || n, 'Sale ' || n, 'https://cdn.blast.fun/s' || n || '.png', 9,
       CASE WHEN n % 3 = 0 THEN 'SUI' ELSE 'USDC' END, CASE WHEN n % 3 = 0 THEN 9 ELSE 6 END, l.lifecycle,
       $1::bigint - 30::bigint * ${DAY}, $1::bigint + (n % 5 - 2)::bigint * ${DAY}, 250000000000, 10000000, 25000000000, 250000000000, 100,
       CASE WHEN n % 2 = 0 THEN 'cetus' ELSE 'bluefin' END, NULL, 1
     FROM generate_series(0, ${PRESALES - 1}) n, LATERAL (SELECT ${LIFECYCLE} AS lifecycle) l`,
    [now, USDC_COIN_TYPE, SUI],
  );
  await admin.query(
    `INSERT INTO blast_infra_fixture.prices
     SELECT ${saleToken("n")}, (0.0001 + (n % 97) * 0.00007)::numeric, $1::bigint, 'pool'
     FROM generate_series(0, ${PRESALES - 1}) n WHERE n % 10 BETWEEN 5 AND 8
     UNION ALL SELECT $2, 3.4123, $1::bigint, 'pyth'`,
    [now, SUI],
  );
  // In chunks: each account's callsign guard takes an advisory lock for the rest of its transaction.
  for (let from = 1; from <= ACCOUNTS; from += 5_000) {
    await admin.query(
      `INSERT INTO social_accounts (account_id, privy_did, callsign, privacy, sharing_since, onboarded_at)
       SELECT ${accountId("n")}, 'did:privy:snap-' || n, 'snap_' || n, 'public', now() - interval '500 days', now() - interval '500 days'
       FROM generate_series($1::int, $2::int) n`,
      [from, Math.min(from + 4_999, ACCOUNTS)],
    );
  }
  await admin.query(
    `INSERT INTO social_account_wallets (address, account_id, verified_at)
     SELECT ${wallet("n")}, ${accountId("n")}, now() - interval '500 days' FROM generate_series(1, ${ACCOUNTS}) n`,
  );
  // Two positions an account on average, in random sales; 100k sale-coin balances of migrated sales' coins.
  await admin.query(
    `INSERT INTO blast_infra_fixture.presale_positions
     SELECT DISTINCT ON (p, w) ${presaleId("p")} AS p, w, (1 + i % 500)::numeric * 1000000, $1::bigint - ${DAY},
       NULL, NULL, NULL, NULL
     FROM (SELECT i, abs(hashtext('p' || i)) % ${PRESALES} AS p, ${wallet(`1 + abs(hashtext('w' || i)) % ${ACCOUNTS}`)} AS w
           FROM generate_series(1, ${ACCOUNTS * 2}) i) s`,
    [now],
  );
  await admin.query(
    `INSERT INTO blast_infra_fixture.coin_balances
     SELECT DISTINCT ON (coin_type, owner) ${saleToken("(5 + (abs(hashtext('c' || n)) % 200) * 10 + abs(hashtext('d' || n)) % 4)")} AS coin_type,
       ${wallet(`1 + abs(hashtext('o' || n)) % ${ACCOUNTS}`)} AS owner, (1 + n % 5000)::numeric * 1000000000, 1
     FROM generate_series(1, ${ACCOUNTS}) n`,
  );
  // The history: DAYS days ending yesterday, every account every day, written day by day as the worker writes them.
  await admin.query("ALTER TABLE social_portfolio_snapshots SET UNLOGGED");
  await admin.query("ALTER TABLE social_portfolio_snapshots DROP CONSTRAINT social_portfolio_snapshots_pkey");
  const first = Date.parse(`${TODAY}T00:00:00.000Z`) - DAYS * DAY;
  for (let d = 0; d < DAYS; d += 1) {
    const dayMs = first + d * DAY;
    await admin.query(
      `INSERT INTO social_portfolio_snapshots (account_id, day, value_usd, committed_usd, claimable_usd, tokens_usd, usdc_usd, sui_usd,
         skipped, taken_at_ms, checkpoint, prices_as_of_ms)
       SELECT ${accountId("n")}, $1::date, v.value, v.committed, v.zero, v.tokens, v.zero, v.zero,
         CASE WHEN v.value IS NULL THEN 'price_missing' END, $2::bigint + n, $3::bigint, CASE WHEN v.value IS NOT NULL THEN $2::bigint END
       FROM generate_series(1, ${ACCOUNTS}) n
       CROSS JOIN LATERAL (SELECT abs(hashtext(n || ':' || $1::text)) AS h) r
       CROSS JOIN LATERAL (SELECT
         CASE WHEN r.h % 100 = 0 THEN NULL ELSE ((r.h % 900000) / 100.0 + (r.h % 7000))::numeric(20, 2) END AS value,
         CASE WHEN r.h % 100 = 0 THEN NULL ELSE ((r.h % 900000) / 100.0)::numeric(20, 2) END AS committed,
         CASE WHEN r.h % 100 = 0 THEN NULL ELSE (r.h % 7000)::numeric(20, 2) END AS tokens,
         CASE WHEN r.h % 100 = 0 THEN NULL ELSE 0::numeric(20, 2) END AS zero) v`,
      [new Date(dayMs).toISOString().slice(0, 10), dayMs + 300_000, 1_000_000 + d * 216_000],
    );
    if (d % 50 === 49) console.log(`snapshots: ${d + 1} days`);
  }
  console.log("rebuilding the key");
  await admin.query("SET maintenance_work_mem = '512MB'");
  await admin.query("ALTER TABLE social_portfolio_snapshots ADD CONSTRAINT social_portfolio_snapshots_pkey PRIMARY KEY (account_id, day) INCLUDE (value_usd)");
  await admin.query(advanceWatermark(50_000_000, 0, "market"));
  await admin.query(advanceWatermark(50_000_000, 0, "presale"));
  await admin.query("VACUUM ANALYZE");
  const counts = await admin.query(`SELECT
    (SELECT count(*) FROM social_accounts) accounts, (SELECT count(*) FROM social_account_wallets) wallets,
    (SELECT count(*) FROM blast_infra_fixture.presale_positions) positions, (SELECT count(*) FROM blast_infra_fixture.coin_balances) balances,
    (SELECT reltuples::bigint FROM pg_class WHERE relname = 'social_portfolio_snapshots') snapshots,
    pg_size_pretty(pg_relation_size('social_portfolio_snapshots')) heap,
    pg_size_pretty(pg_relation_size('social_portfolio_snapshots_pkey')) key,
    pg_size_pretty(pg_relation_size('social_portfolio_snapshots_skipped_idx')) skipped_idx`);
  console.log(counts.rows[0]);
  await admin.end();
}

type Timing = { label: string; p50: number; p95: number; max: number; runs: number };

function summarize(label: string, samples: number[]): Timing {
  samples.sort((a, b) => a - b);
  const at = (q: number) => +samples[Math.min(samples.length - 1, Math.ceil(q * samples.length) - 1)]!.toFixed(3);
  const result = { label, p50: at(0.5), p95: at(0.95), max: +samples.at(-1)!.toFixed(3), runs: samples.length };
  console.log(JSON.stringify(result));
  return result;
}

const randomAccount = () => account(1 + Math.floor(Math.random() * ACCOUNTS));
const dayPlus = (day: string, days: number) => new Date(Date.parse(`${day}T00:00:00.000Z`) + days * DAY).toISOString().slice(0, 10);

/**
 * `sql` under EXPLAIN (ANALYZE): planning + execution per run (3 warm-ups),
 * each run with fresh `values()`, inside a rolled-back transaction when it
 * writes; one EXPLAIN (ANALYZE, BUFFERS) plan kept.
 */
async function explained(
  pool: pg.Pool,
  label: string,
  sql: string,
  values: () => readonly unknown[],
  plans: Record<string, string>,
  options: Readonly<{ writes?: boolean; runs?: number; forbid?: RegExp }> = {},
): Promise<Timing> {
  const samples: number[] = [];
  const runs = options.runs ?? RUNS;
  const client = await pool.connect();
  try {
    for (let i = 0; i < runs + 4; i += 1) {
      if (options.writes) await client.query("BEGIN");
      const last = i === runs + 3;
      const { rows } = await client.query<{ "QUERY PLAN": unknown }>(
        `EXPLAIN (ANALYZE, ${last ? "BUFFERS" : "FORMAT JSON"}) ${sql}`, [...values()],
      );
      if (options.writes) await client.query("ROLLBACK");
      if (last) {
        plans[label] = rows.map((row) => String(row["QUERY PLAN"])).join("\n");
      } else if (i >= 3) {
        const [plan] = rows[0]!["QUERY PLAN"] as [{ "Planning Time": number; "Execution Time": number }];
        samples.push(plan["Planning Time"] + plan["Execution Time"]);
      }
    }
  } finally {
    client.release();
  }
  if (STRICT && /Seq Scan on social_portfolio_snapshots/.test(plans[label]!)) throw new Error(`${label}: a sequential scan of the snapshots`);
  if (STRICT && options.forbid && options.forbid.test(plans[label]!)) throw new Error(`${label}: ${options.forbid}`);
  return summarize(label, samples);
}

async function timed(label: string, runs: number, run: () => Promise<unknown>): Promise<Timing> {
  const samples: number[] = [];
  for (let i = 0; i < runs + 3; i += 1) {
    const start = performance.now();
    // react-doctor-disable-next-line react-doctor/async-await-in-loop -- Measure benchmark cases and warm-up samples serially; overlapping queries would contaminate their latency.
    await run();
    if (i >= 3) samples.push(performance.now() - start);
  }
  return summarize(label, samples);
}

async function bench() {
  const now = Date.now();
  // Fresh prices and watermarks, as the market pipeline keeps them.
  const admin = new pg.Pool({ connectionString: URL_, max: 1 });
  await admin.query("UPDATE blast_infra_fixture.prices SET as_of_ms = $1", [now]);
  await admin.query("UPDATE watermarks SET timestamp_ms_hi_inclusive = $1", [now]);
  const webPool = new pg.Pool({ connectionString: urlAs(URL_, "blast_web"), max: 4 });
  const replicaPool = new pg.Pool({ connectionString: urlAs(URL_, "blast_replica"), max: 4 });
  const watcherPool = new pg.Pool({ connectionString: urlAs(URL_, "blast_watcher"), max: 2 });
  const timings: Timing[] = [];
  const plans: Record<string, string> = {};
  const problems: string[] = [];
  const tomorrow = dayPlus(TODAY, 1);
  const trendArgs = () => [randomAccount(), tomorrow, dayPlus(TODAY, -31), 32];

  // The answers first: a month of history gives every unskipped account a line.
  const web = autocommitReader(webPool, "social");
  const sample = await readPortfolioTrend(web, account(7), now);
  console.log(`account 7: ${sample.points.length} points, change ${sample.change_bps}`);
  const history = await readPortfolioSnapshots(web, account(7), { before: tomorrow, since: null, limit: 1_000 });
  if (history.length < DAYS * 0.97) problems.push(`account 7: ${history.length} valued days of ${DAYS}`);

  for (const [role, pool] of [["blast_web", webPool], ["blast_replica", replicaPool]] as const) {
    timings.push(await explained(pool, `trend read (32 days, one account's key range), as ${role}`, PORTFOLIO_TREND_STATEMENTS.snapshots, trendArgs, plans, { forbid: /Sort|Heap Fetches: [1-9]/ }));
  }
  timings.push(await explained(webPool, "keyset page of 50, 300 days back, as blast_web", PORTFOLIO_TREND_STATEMENTS.snapshots,
    () => [randomAccount(), dayPlus(TODAY, -300), "-infinity", 50], plans, { forbid: /Sort/ }));
  timings.push(await timed("whole readPortfolioTrend (the portfolio's call), as blast_web", RUNS, () => readPortfolioTrend(web, randomAccount(), now)));
  timings.push(await timed("whole readPortfolioTrend, as blast_replica", RUNS, () => readPortfolioTrend(autocommitReader(replicaPool, "social"), randomAccount(), now)));

  // The worker's statements for one batch of 100 accounts, as the watcher.
  const batchStart = () => 1 + Math.floor(Math.random() * (ACCOUNTS - BATCH));
  const batch = (start: number) => Array.from({ length: BATCH }, (_, i) => account(start + i));
  const wallets = (start: number) => Array.from({ length: BATCH }, (_, i) => `0x${("a11e7" + (start + i).toString(16)).padStart(64, "0")}`);
  const S = PORTFOLIO_SNAPSHOT_STATEMENTS;
  const yesterday = dayPlus(TODAY, -1);
  timings.push(await explained(watcherPool, "sweep page (100 accounts by key, a probe of yesterday's row each)", S.page,
    () => [account(batchStart()), BATCH, yesterday], plans));
  timings.push(await explained(watcherPool, "addresses of 100 accounts", S.addresses, () => [batch(batchStart())], plans, { runs: 50 }));
  timings.push(await explained(watcherPool, "positions of 100 accounts' wallets", S.positions, () => {
    const start = batchStart();
    return [batch(start), wallets(start)];
  }, plans, { runs: 50, forbid: /Seq Scan on presale_positions/ }));
  timings.push(await explained(watcherPool, "sale coins of 100 accounts' wallets", S.coins, () => {
    const start = batchStart();
    return [batch(start), wallets(start)];
  }, plans, { runs: 50, forbid: /Seq Scan on coin_balances/ }));
  const coinTypes = (await admin.query<{ coin_type: string }>("SELECT coin_type FROM blast_infra_fixture.prices ORDER BY coin_type LIMIT 120")).rows.map((row) => row.coin_type);
  timings.push(await explained(watcherPool, "prices of 120 coins", S.prices, () => [coinTypes], plans, { runs: 50 }));
  const upsertValues = () => {
    const accounts = batch(batchStart());
    const value = accounts.map(() => "123.45");
    const zero = accounts.map(() => "0.00");
    return [TODAY, now, 50_000_000, accounts, value, value, zero, zero, zero, zero, accounts.map(() => null), accounts.map(() => now)];
  };
  timings.push(await explained(watcherPool, "upsert of 100 rows (rolled back)", S.upsert, upsertValues, plans, { writes: true, runs: 50 }));
  timings.push(await explained(watcherPool, "retention delete for 100 accounts, 1 day past 400 (rolled back)", S.retention,
    () => [batch(batchStart()), dayPlus(TODAY, -(DAYS - 2))], plans, { writes: true, runs: 50 }));
  timings.push(await explained(watcherPool, "retry page (a day's skipped rows by key)", S.retryPage,
    () => [yesterday, account(batchStart()), BATCH], plans, { runs: 50 }));

  // A whole pass of the step over today (a new day): 100 accounts valued and written, the cursor stored. Stub fullnode, no latency.
  const [step] = portfolioSnapshotSteps({
    batchSize: BATCH,
    retentionDays: 400,
    fullnode: () => ({ getBalance: async () => ({ balance: { balance: "1000000000" } }) }),
  });
  let written = 0;
  timings.push(await timed("one pass of the step: 100 accounts valued and written (stub fullnode)", 30, async () => {
    const report = await withTransaction(watcherPool, (tx) => step!.run(tx.forModule("social"), { pipeline: "market", checkpoint: 50_000_000, timestampMs: now }, { now: () => now + 1_000 }));
    written += report.snapshots_written ?? 0;
  }));
  console.log(`step passes wrote ${written} rows for ${TODAY}`);
  if (written === 0) problems.push("the step wrote nothing");

  const load = fs.readFileSync("/proc/loadavg", "utf8").trim();
  const size = (await admin.query(`SELECT reltuples::bigint AS rows, pg_size_pretty(pg_relation_size('social_portfolio_snapshots')) AS heap,
    pg_size_pretty(pg_relation_size('social_portfolio_snapshots_pkey')) AS key FROM pg_class WHERE relname = 'social_portfolio_snapshots'`)).rows[0];
  fs.mkdirSync("loadtest/results", { recursive: true });
  fs.writeFileSync("loadtest/results/social-portfolio-snapshot-scale-timings.json",
    JSON.stringify({ at: new Date().toISOString(), accounts: ACCOUNTS, days: DAYS, size, runs: RUNS, load, timings, problems }, null, 1));
  fs.writeFileSync("loadtest/results/social-portfolio-snapshot-scale-plans.txt",
    Object.entries(plans).map(([label, plan]) => `== ${label}\n${plan}\n`).join("\n"));
  console.log(`table ${JSON.stringify(size)}; host load ${load}`);
  for (const problem of problems) console.error(`PROBLEM: ${problem}`);
  await Promise.all([admin.end(), webPool.end(), replicaPool.end(), watcherPool.end()]);
  if (problems.length > 0) process.exitCode = 1;
}

if (process.argv[2] === "seed") await seed();
else if (process.argv[2] === "bench") await bench();
else throw new Error("Usage: social-portfolio-snapshot-scale.ts seed|bench");
