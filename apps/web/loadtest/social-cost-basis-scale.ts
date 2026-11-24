import { PORTFOLIO_COIN_TYPES } from "@blast/core/modules/social/portfolio/read.ts";
// R3-32 scale evidence: the cost basis behind every P&L, at launch scale.
// `seed` builds a disposable database: 10k accounts each with its wallet
// linked, 2,000 shown sales (800 of them migrated, with a pool price), 1M
// activity rows over about 25 days (85% commits, 10% claims, 5% trades of
// migrated sales' coins, every trade stamped with its sale as T-038 writes
// it; a trade's `event_slot` is 1 here, u32::MAX in blast-infra, which the
// fixture's int4 column cannot hold), blast-infra's activity indexes, T-043's three hidden test sales (their
// activity is in the log, their sales are not in `presales`), 100k other
// sale-coin balances, and the two accounts the contract names:
//
// - **heavy**: two wallets, 40 coins and 2,000 activity rows of its own (per
//   coin: 10 commits, 2 claims, 24 buys and 14 sells, spread through the 25
//   days), plus 300 rows of the hidden sales the read must skip;
// - **bot**: one wallet with 15,000 trades, past the read's per-wallet cap.
//
// `bench` runs the ledger statement under EXPLAIN (ANALYZE) — planning +
// execution, SCALE_RUNS times after 3 warm-ups — as `blast_web` (the owner's
// reads on the primary) and as `blast_replica` (the profile's calls), for
// the heavy account, the bot and a typical account, then the three whole
// reads as their routes run them (`/me/portfolio` with indexed balances,
// `/me/presales`, the calls), and checks the answers: 2,000 rows read, no
// hidden sale's row, the bot's read stopped at the cap, every heavy coin's
// basis complete. A Seq Scan on activity fails the run.
//
//   SOCIAL_SCALE_DATABASE_URL=postgresql://postgres:<pw>@127.0.0.1:<port>/<db> \
//     node --no-warnings --import ./scripts/test-tsx-hooks.mjs --experimental-strip-types loadtest/social-cost-basis-scale.ts seed|bench
//
// The database must be a disposable loopback Postgres (seed resets it). bench
// writes loadtest/results/social-cost-basis-scale-timings.json and -plans.txt.
import fs from "node:fs";

import pg from "pg";

import { migrateDatabase } from "@blast/core/modules/database/migrations.ts";
import { createPool } from "@blast/core/modules/database/pool.ts";
import { CHAIN_FIXTURE, advanceWatermark, resetSharedDatabase, urlAs } from "../../../packages/core/test/fixtures/modules/database/role-fixtures.ts";
import { autocommitReader, type ReadableDatabase } from "@blast/core/modules/database/transaction.ts";
import {
  COST_BASIS_KINDS,
  COST_BASIS_ROWS_PER_WALLET,
  COST_BASIS_STATEMENTS,
  costBasisBook,
  costBasisFiguresOf,
  readCostBasisLedger,
} from "@blast/server/modules/social/portfolio/cost-basis.ts";
import { readSaleCoinHoldings } from "@blast/server/modules/social/portfolio/holdings.ts";
import { assemblePortfolio } from "@blast/server/modules/social/portfolio/route.ts";
import { readAccountAddresses } from "@blast/server/modules/social/accounts/read-wallet-addresses.ts";
import { readCalls } from "@blast/server/modules/social/profiles/calls.ts";
import { readMePresales } from "@blast/server/modules/social/profiles/viewer.ts";

const URL_ = process.env.SOCIAL_SCALE_DATABASE_URL ?? "";
if (!/^postgres(ql)?:\/\/[^@]+@(127\.0\.0\.1|localhost):\d+\/\w+$/.test(URL_)) {
  throw new Error("SOCIAL_SCALE_DATABASE_URL must name a disposable loopback database (seed resets it).");
}
const DAY = 86_400_000;
const NOW = Date.now();
const RUNS = Number(process.env.SCALE_RUNS ?? 50);
const ACCOUNTS = 10_000, PRESALES = 2_000;
/** 1M at launch scale; a smaller SCALE_ACTIVITY only checks the script. */
const ACTIVITY = Number(process.env.SCALE_ACTIVITY ?? 1_000_000);
const HEAVY_COINS = 40, HEAVY_ROWS_PER_COIN = 50, BOT_ROWS = 15_000;
const presaleId = (n: string) => `'0x' || lpad('5a1e' || to_hex(${n}), 64, '0')`;
const saleToken = (n: string) => `${presaleId(n)} || '::coin::S' || ${n}`;
const accountId = (n: string) => `('00000000-0000-4000-8000-' || lpad(to_hex(${n}), 12, '0'))::uuid`;
const wallet = (n: string) => `'0x' || lpad('a11e7' || to_hex(${n}), 64, '0')`;
const hex = (tag: string) => `0x${tag.padStart(64, "0")}`;
/** Lifecycle by `n % 10`: 0-1 pending, 2-3 open, 4 funded, 5-8 migrated, 9 cancelled. */
const LIFECYCLE = `(ARRAY['pending','pending','open','open','funded','migrated','migrated','migrated','migrated','cancelled'])[1 + n % 10]`;
const USDC = `0x${"dba3".padStart(64, "0")}::usdc::USDC`;
/** T-043's hidden test sales: their activity is in the log, their sales are not in `presales`. */
const EXCLUDED = [hex("e1"), hex("e2"), hex("e3")];
const HEAVY = { account: "00000000-0000-4000-8000-0000000fffe1", wallets: [hex("feed01"), hex("feed02")] };
const BOT = { account: "00000000-0000-4000-8000-0000000fffe2", wallets: [hex("b07001")] };
/** The heavy account's 40 coins: migrated sales (n % 10 in 5..8), 50 apart. */
const HEAVY_SALES = Array.from({ length: HEAVY_COINS }, (_, i) => 5 + i * 50);
const TYPICAL = { account: "00000000-0000-4000-8000-000000000007", wallets: [`0x${("a11e7" + (7).toString(16)).padStart(64, "0")}`] };

async function seed() {
  const admin = createPool(URL_, { max: 2 });
  await resetSharedDatabase(admin);
  await admin.query(CHAIN_FIXTURE);
  await migrateDatabase(admin);
  // blast-infra's activity access paths (2026-10-07 `chain_read_activity`; the fixture has no generated id).
  await admin.query(`
    CREATE INDEX activity_time ON blast_infra_fixture.activity (timestamp_ms DESC);
    CREATE INDEX activity_actor ON blast_infra_fixture.activity (actor, timestamp_ms DESC);
    CREATE INDEX activity_presale ON blast_infra_fixture.activity (presale_id, timestamp_ms DESC);
    CREATE INDEX activity_coin ON blast_infra_fixture.activity (coin_type, timestamp_ms DESC);
    CREATE INDEX activity_digest ON blast_infra_fixture.activity (digest);`);
  await admin.query(
    `INSERT INTO blast_infra_fixture.presales
     (presale_id, sale_token, quote_type, sale_symbol, sale_name, sale_icon_url, sale_decimals,
      quote_symbol, quote_decimals, lifecycle, start_ms, end_ms, raise_target, min_commitment,
      wallet_cap, total_commitments, participants, venue, pool_id, updated_checkpoint)
     SELECT ${presaleId("n")}, ${saleToken("n")}, $2,
       'S' || n, 'Sale ' || n, 'https://cdn.blast.fun/s' || n || '.png', 9, 'USDC', 6, l.lifecycle,
       $1::bigint - 30::bigint * ${DAY}, $1::bigint - 26::bigint * ${DAY}, 250000000000, 10000000, 25000000000, 250000000000, 100,
       CASE WHEN n % 2 = 0 THEN 'cetus' ELSE 'bluefin' END, NULL, 1
     FROM generate_series(0, ${PRESALES - 1}) n, LATERAL (SELECT ${LIFECYCLE} AS lifecycle) l`,
    [NOW, USDC],
  );
  await admin.query(
    `INSERT INTO blast_infra_fixture.prices
     SELECT ${saleToken("n")}, (0.0001 + (n % 97) * 0.00007)::numeric, $1::bigint - 5000, 'pool'
     FROM generate_series(0, ${PRESALES - 1}) n WHERE n % 10 BETWEEN 5 AND 8`,
    [NOW],
  );
  // 1M rows over about 25 days: commits, claims, and trades of migrated sales' coins, each with its sale.
  for (let start = 0; start < ACTIVITY; start += 200_000) {
    await admin.query(
      `INSERT INTO blast_infra_fixture.activity
       SELECT 100000 + i, abs(hashtext('t' || i)) % 4, CASE WHEN k.kind LIKE 'trade%' THEN 1 ELSE 0 END, 0,
         $1::bigint - 60000 - (hashint % 2160000000), 'Dg' || i,
         k.kind, CASE WHEN k.kind LIKE 'trade%' THEN 'market' ELSE 'presale' END, actor, actor,
         ${presaleId("pp.sale")}, ${saleToken("pp.sale")}, $4,
         CASE WHEN k.kind = 'presale_claim' THEN 0 ELSE (10 + (hashint % 5000))::bigint * 1000000 END,
         CASE WHEN k.kind = 'presale_commit' THEN NULL ELSE (1 + hashint % 90000)::bigint * 1000000000 END,
         CASE WHEN k.kind = 'presale_claim' THEN 0 END,
         CASE WHEN k.kind = 'presale_claim' THEN NULL ELSE 10 + (hashint % 5000) END,
         CASE WHEN k.kind = 'presale_claim' THEN NULL ELSE $1::bigint END,
         CASE WHEN k.kind LIKE 'trade%' THEN 'cetus' END, NULL, NULL
       FROM (
         SELECT i, abs(hashtext(i::text)) AS hashint, abs(hashtext('k' || i)) % 100 AS kk,
           2 + (abs(hashtext('p' || i)) % ${PRESALES / 10}) * 10 + abs(hashtext('q' || i)) % 8 AS p0,
           ${wallet(`1 + abs(hashtext('w' || i)) % ${ACCOUNTS}`)} AS actor
         FROM generate_series($2::int, $3::int) i
       ) s,
       LATERAL (SELECT CASE WHEN s.kk < 85 THEN 'presale_commit' WHEN s.kk < 95 THEN 'presale_claim' WHEN s.kk < 98 THEN 'trade_buy' ELSE 'trade_sell' END AS kind) k,
       LATERAL (SELECT CASE WHEN k.kind LIKE 'trade%' THEN s.p0 - s.p0 % 10 + 5 + s.p0 % 4 ELSE s.p0 END AS sale) pp`,
      [NOW, start, Math.min(start + 200_000, ACTIVITY) - 1, USDC],
    );
    console.log(`activity ${Math.min(start + 200_000, ACTIVITY)}`);
  }
  // The heavy account: per coin, 10 commits (5 per wallet), a claim per wallet, then 24 buys and 14 sells, in that order.
  await admin.query(
    `INSERT INTO blast_infra_fixture.activity
     SELECT 7000000 + c * 100 + r, 0, CASE WHEN r >= 12 THEN 1 ELSE 0 END, 0,
       $1::bigint - 25::bigint * ${DAY} + (c * ${HEAVY_ROWS_PER_COIN} + r)::bigint * 1000000, 'Dh' || c || '-' || r,
       k.kind, CASE WHEN r >= 12 THEN 'market' ELSE 'presale' END, w.address, w.address,
       ${presaleId("s.sale")}, ${saleToken("s.sale")}, $2,
       CASE k.kind WHEN 'presale_commit' THEN 100000000 WHEN 'presale_claim' THEN 0 WHEN 'trade_buy' THEN 4200000 ELSE 3100000 END,
       CASE k.kind WHEN 'presale_commit' THEN NULL WHEN 'presale_claim' THEN 500000000000 WHEN 'trade_buy' THEN 10000000000 ELSE 5000000000 END,
       CASE WHEN k.kind = 'presale_claim' THEN 20000000 END,
       CASE k.kind WHEN 'presale_commit' THEN 99.98 WHEN 'presale_claim' THEN 19.9960 WHEN 'trade_buy' THEN 4.2 ELSE 3.1 END,
       $1::bigint - ${DAY}::bigint, CASE WHEN r >= 12 THEN 'cetus' END, NULL, NULL
     FROM generate_series(0, ${HEAVY_COINS - 1}) c, generate_series(0, ${HEAVY_ROWS_PER_COIN - 1}) r,
       LATERAL (SELECT ($3::int[])[1 + c] AS sale) s,
       LATERAL (SELECT ($4::text[])[1 + r % 2] AS address) w,
       LATERAL (SELECT CASE WHEN r < 10 THEN 'presale_commit' WHEN r < 12 THEN 'presale_claim' WHEN r < 36 THEN 'trade_buy' ELSE 'trade_sell' END AS kind) k`,
    [NOW, USDC, HEAVY_SALES, HEAVY.wallets],
  );
  // Its hidden-sale rows (100 per excluded sale) and every hidden sale's own rows: the newest rows of the log.
  await admin.query(
    `INSERT INTO blast_infra_fixture.activity
     SELECT 8000000 + i, 0, 0, 0, $1::bigint - 1000 - i, 'Dx' || i, 'presale_commit', 'presale',
       CASE WHEN i % 10 = 0 THEN ($3::text[])[1 + (i / 10) % 2] ELSE ${wallet("1 + i % 50")} END,
       CASE WHEN i % 10 = 0 THEN ($3::text[])[1 + (i / 10) % 2] ELSE ${wallet("1 + i % 50")} END,
       ($2::text[])[1 + i % 3], ($2::text[])[1 + i % 3] || '::sale_tokens::SALE', $4,
       5000000, NULL, NULL, 5, $1::bigint, NULL, NULL, NULL
     FROM generate_series(0, 2999) i`,
    [NOW, EXCLUDED, HEAVY.wallets, USDC],
  );
  // The bot: 15,000 trades over 10 coins.
  await admin.query(
    `INSERT INTO blast_infra_fixture.activity
     SELECT 9000000 + i, 0, 1, 0, $1::bigint - 20::bigint * ${DAY} + i::bigint * 100000, 'Db' || i,
       CASE WHEN i % 3 = 2 THEN 'trade_sell' ELSE 'trade_buy' END, 'market', $2, $2,
       ${presaleId("(5 + (i % 10) * 10)")}, ${saleToken("(5 + (i % 10) * 10)")}, $3, 1000000, 1000000000, NULL, 1, $1::bigint, 'cetus', NULL, NULL
     FROM generate_series(0, ${BOT_ROWS - 1}) i`,
    [NOW, BOT.wallets[0], USDC],
  );
  // Accounts, every one with its wallet linked, public and sharing; the heavy account with two, the bot with one.
  await admin.query(
    `INSERT INTO social_accounts (account_id, privy_did, callsign, display_name, privacy, sharing_since, onboarded_at)
     SELECT ${accountId("n")}, 'did:privy:scale-' || n, 'acct_' || n, 'Account ' || n, 'public', now() - interval '400 days', now() - interval '400 days'
     FROM generate_series(1, ${ACCOUNTS}) n`,
  );
  await admin.query(
    `INSERT INTO social_accounts (account_id, privy_did, callsign, display_name, privacy, sharing_since, onboarded_at)
     VALUES ($1, 'did:privy:scale-heavy', 'heavy_one', 'Heavy', 'public', now() - interval '400 days', now() - interval '400 days'),
       ($2, 'did:privy:scale-bot', 'bot_one', 'Bot', 'public', now() - interval '400 days', now() - interval '400 days')`,
    [HEAVY.account, BOT.account],
  );
  await admin.query(
    `INSERT INTO social_account_wallets (address, account_id, verified_at)
     SELECT ${wallet("n")}, ${accountId("n")}, now() - interval '400 days' FROM generate_series(1, ${ACCOUNTS}) n
     UNION ALL SELECT unnest($1::text[]), $2::uuid, now() - interval '400 days'
     UNION ALL SELECT unnest($3::text[]), $4::uuid, now() - interval '400 days'`,
    [HEAVY.wallets, HEAVY.account, BOT.wallets, BOT.account],
  );
  // Balances: 100k other holders of the migrated coins; the heavy wallets hold what their ledger says (per coin, wallet 1
  // 500 + 120 − 35 tokens, wallet 2 the same); the bot what its trades left.
  await admin.query(
    `INSERT INTO blast_infra_fixture.coin_balances
     SELECT DISTINCT ON (coin_type, owner) ${saleToken("(5 + (abs(hashtext('c' || n)) % 200) * 10 + abs(hashtext('d' || n)) % 4)")} AS coin_type,
       ${wallet("1 + n % 10000")} AS owner, (1 + n % 5000)::numeric * 1000000000, 1
     FROM generate_series(1, 100000) n`,
  );
  await admin.query(
    `INSERT INTO blast_infra_fixture.coin_balances
     SELECT ${saleToken("s")}, w, 585000000000, 1 FROM unnest($1::int[]) s, unnest($2::text[]) w`,
    [HEAVY_SALES, HEAVY.wallets],
  );
  await admin.query(
    `INSERT INTO blast_infra_fixture.coin_balances
     SELECT ${saleToken("(5 + c * 10)")}, $1, 500000000000, 1 FROM generate_series(0, 9) c`,
    [BOT.wallets[0]],
  );
  await admin.query(
    `INSERT INTO blast_infra_fixture.presale_positions
     SELECT ${presaleId("s")}, w, 500000000, $1::bigint - 25::bigint * ${DAY}, 'Claim' || s || w, 500000000000, 20000000, $1::bigint - 24::bigint * ${DAY}
     FROM unnest($2::int[]) s, unnest($3::text[]) w`,
    [NOW, HEAVY_SALES, HEAVY.wallets],
  );
  await admin.query("INSERT INTO blast_infra_fixture.wallet_sync(owner,timestamp_ms) SELECT address,$1 FROM social_account_wallets", [NOW]);
  await admin.query(`INSERT INTO blast_infra_fixture.coin_balances
    SELECT coin, address, 1000000000, 1 FROM social_account_wallets CROSS JOIN unnest($1::text[]) coin
    ON CONFLICT (coin_type,owner) DO NOTHING`, [[PORTFOLIO_COIN_TYPES.sui, PORTFOLIO_COIN_TYPES.usdc]]);
  await admin.query(advanceWatermark(10_000_000, 0, "market"));
  await admin.query(advanceWatermark(10_000_000, 0, "presale"));
  await admin.query("VACUUM ANALYZE");
  const counts = await admin.query(`SELECT
    (SELECT count(*) FROM social_accounts) accounts, (SELECT count(*) FROM blast_infra_fixture.presales) presales,
    (SELECT count(*) FROM blast_infra_fixture.activity) activity, (SELECT count(*) FROM blast_infra_fixture.coin_balances) balances,
    (SELECT count(*) FROM blast_infra_fixture.activity WHERE actor = ANY($1::text[])) heavy_rows,
    (SELECT count(*) FROM blast_infra_fixture.activity WHERE actor = ANY($2::text[])) bot_rows`, [HEAVY.wallets, BOT.wallets]);
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

/** The ledger statement under EXPLAIN (ANALYZE): planning + execution per run (3 warm-ups), and its plan once. */
async function explained(pool: pg.Pool, label: string, values: readonly unknown[], plans: Record<string, string>): Promise<Timing> {
  const samples: number[] = [];
  for (let i = 0; i < RUNS + 3; i += 1) {
    const { rows } = await pool.query<{ "QUERY PLAN": [{ "Planning Time": number; "Execution Time": number }] }>(
      `EXPLAIN (ANALYZE, FORMAT JSON) ${COST_BASIS_STATEMENTS.ledger}`, [...values],
    );
    const [plan] = rows[0]!["QUERY PLAN"];
    if (i >= 3) samples.push(plan["Planning Time"] + plan["Execution Time"]);
  }
  const text = await pool.query<{ "QUERY PLAN": string }>(`EXPLAIN (ANALYZE, BUFFERS) ${COST_BASIS_STATEMENTS.ledger}`, [...values]);
  plans[label] = text.rows.map((row) => row["QUERY PLAN"]).join("\n");
  if (/Seq Scan on activity/.test(plans[label]!)) throw new Error(`${label}: a sequential scan of activity`);
  return summarize(label, samples);
}

/**
 * A whole read's statements, each timed on its own while the read runs as its
 * route runs it (in parallel where the route reads in parallel): p95 per
 * statement, by its first words, so the ledger's share of a read is visible.
 */
async function breakdown(label: string, db: ReadableDatabase, run: (db: ReadableDatabase) => Promise<unknown>): Promise<Timing[]> {
  const samples = new Map<string, number[]>();
  const timedDb: ReadableDatabase = {
    read: async (text, values) => {
      const start = performance.now();
      try {
        return await db.read(text, values);
      } finally {
        const key = text.includes("FROM chain_read_v1.activity a") && text.includes("unnest($1::text[]) AS w(address)")
          ? "the cost-basis ledger" : text.replace(/\s+/g, " ").trim().slice(0, 90);
        samples.set(key, [...(samples.get(key) ?? []), performance.now() - start]);
      }
    },
  } as ReadableDatabase;
  // react-doctor-disable-next-line react-doctor/async-await-in-loop -- Measure benchmark cases and warm-up samples serially; overlapping queries would contaminate their latency.
  for (let i = 0; i < RUNS; i += 1) await run(timedDb);
  return [...samples.entries()].map(([key, times]) => summarize(`${label} / ${key}`, times.slice(-RUNS)));
}

/** A whole read as its route runs it (wall time, every statement). */
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
  // The seed's prices are as old as the seed: make them fresh (at most 120 s), as the market pipeline keeps them.
  const admin = new pg.Pool({ connectionString: URL_, max: 1 });
  await admin.query("UPDATE blast_infra_fixture.prices SET as_of_ms = $1", [Date.now()]);
  await admin.end();
  // Enough connections that a read's parallel statements do not queue behind each other.
  const webPool = new pg.Pool({ connectionString: urlAs(URL_, "blast_web"), max: 8 });
  const replicaPool = new pg.Pool({ connectionString: urlAs(URL_, "blast_replica"), max: 8 });
  const web: ReadableDatabase = autocommitReader(webPool, "social");
  const replica: ReadableDatabase = autocommitReader(replicaPool, "social");
  const timings: Timing[] = [];
  const plans: Record<string, string> = {};
  const problems: string[] = [];
  const nowMs = Date.now();
  const args = (wallets: readonly string[]) => [wallets, [...COST_BASIS_KINDS], COST_BASIS_ROWS_PER_WALLET + 1];

  // The answers first: the heavy account's 2,000 rows (none of a hidden sale), the bot's read stopped at the cap.
  const heavyWallets = await readAccountAddresses(web, HEAVY.account);
  if (heavyWallets.length !== 2) problems.push(`heavy account: ${heavyWallets.length} wallets`);
  const heavy = await readCostBasisLedger(web, heavyWallets);
  if (heavy.rows.length !== HEAVY_COINS * HEAVY_ROWS_PER_COIN || heavy.truncated) problems.push(`heavy ledger: ${heavy.rows.length} rows, truncated ${heavy.truncated}`);
  if (heavy.rows.some((row) => EXCLUDED.includes(row.presale_id))) problems.push("heavy ledger: a hidden sale's row was read");
  const holdings = await readSaleCoinHoldings(web, heavyWallets);
  const figuresOf = costBasisFiguresOf(heavy, holdings, nowMs);
  const incomplete = holdings.filter((holding) => !figuresOf(holding.presale_id).basis_complete);
  console.log(`heavy: ${heavy.rows.length} rows, ${holdings.length} coins held, ${incomplete.length} incomplete; first coin ${JSON.stringify(figuresOf(holdings[0]!.presale_id))}`);
  if (holdings.length !== HEAVY_COINS || incomplete.length > 0) problems.push(`heavy: ${holdings.length} coins, ${incomplete.length} incomplete`);
  const bot = await readCostBasisLedger(web, BOT.wallets);
  console.log(`bot: ${bot.rows.length} rows read of ${BOT_ROWS}, truncated ${bot.truncated}`);
  if (bot.rows.length !== COST_BASIS_ROWS_PER_WALLET + 1 || !bot.truncated) problems.push(`bot: ${bot.rows.length} rows, truncated ${bot.truncated}`);
  const typical = await readAccountAddresses(web, TYPICAL.account);
  console.log(`typical account: ${(await readCostBasisLedger(web, typical)).rows.length} rows`);

  timings.push(await explained(webPool, "ledger statement, heavy account (2 wallets, 40 coins, 2,000 rows + 300 hidden), as blast_web", args(heavyWallets), plans));
  timings.push(await explained(replicaPool, "ledger statement, heavy account, as blast_replica (the calls)", args(heavyWallets), plans));
  timings.push(await explained(webPool, "ledger statement, bot (15,000 rows, capped at 10,001), as blast_web", args(BOT.wallets), plans));
  timings.push(await explained(webPool, "ledger statement, a typical account (~100 rows), as blast_web", args(typical), plans));
  timings.push(await timed("the rule over the heavy ledger (the book and 40 coins' figures, in process, as a request runs it)", async () => {
    const of = costBasisFiguresOf(heavy, holdings, nowMs);
    for (const holding of holdings) of(holding.presale_id);
  }));
  timings.push(await timed("the calls' book over the heavy ledger (in process)", async () => costBasisBook(heavy)));
  timings.push(await timed("whole read: /me/portfolio for the heavy account (indexed wallets, every statement)", () =>
    assemblePortfolio({ db: web, accountId: HEAVY.account, addresses: heavyWallets, now: () => nowMs })));
  timings.push(await timed("whole read: /me/presales for the heavy account", () => readMePresales(web, HEAVY.account, nowMs)));
  timings.push(await timed("whole read: the heavy account's calls (replica)", () => readCalls(replica, HEAVY.account, nowMs)));
  const calls = await readCalls(replica, HEAVY.account, nowMs);
  console.log(`calls: ${calls.calls.length}, trading with a multiple ${calls.calls.filter((call) => call.multiple !== null).length}`);
  if (calls.calls.filter((call) => call.multiple !== null).length !== HEAVY_COINS) problems.push("calls: a trading call has no multiple");
  timings.push(...await breakdown("statements of /me/portfolio", web, (db) =>
    assemblePortfolio({ db, accountId: HEAVY.account, addresses: heavyWallets, now: () => nowMs })));
  timings.push(...await breakdown("statements of /me/presales", web, (db) => readMePresales(db, HEAVY.account, nowMs)));
  timings.push(...await breakdown("statements of the calls", replica, (db) => readCalls(db, HEAVY.account, nowMs)));

  const load = fs.readFileSync("/proc/loadavg", "utf8").trim();
  fs.mkdirSync("loadtest/results", { recursive: true });
  fs.writeFileSync("loadtest/results/social-cost-basis-scale-timings.json", JSON.stringify({ at: new Date().toISOString(), runs: RUNS, load, timings, problems }, null, 1));
  fs.writeFileSync("loadtest/results/social-cost-basis-scale-plans.txt",
    Object.entries(plans).map(([label, plan]) => `== ${label}\n${plan}\n`).join("\n"));
  console.log(`host load ${load}`);
  for (const problem of problems) console.error(`PROBLEM: ${problem}`);
  await Promise.all([webPool.end(), replicaPool.end()]);
  if (problems.length > 0) process.exitCode = 1;
}

if (process.argv[2] === "seed") await seed();
else if (process.argv[2] === "bench") await bench();
else throw new Error("Usage: social-cost-basis-scale.ts seed|bench");
