// Redesign data gaps 1-3, 7, 8, 10 and 11 scale evidence: the coin market, holders-with-basis,
// chart-trades and presale-facepile statements at launch scale; and the parity gaps' statements:
// each holder's why, each call's why and the list's tab counts.
// `seed` builds a disposable database: 10k accounts each with its wallet linked (a tenth sharing a
// portfolio), 100k follows, 2,000 shown sales (800 migrated, priced), 1M activity rows over about
// 25 days (85% commits, 10% claims, 5% trades, every trade stamped with its sale, as T-038 writes
// it), blast-infra's activity indexes (the presale-commit partial index included), 100k sale-coin
// balances, and one hot coin: 60,000 trades in its last 24 hours by 5,000 wallets, a 5-minute
// price history over 25 hours, its 100 largest holders being accounts with up to 400 rows each of
// it, and two vesting schedules. For the parity gaps: 50,000 active whys on activity rows (each by
// the row's own account; four on each of the hot coin's 100 largest holders' rows) and trust flags
// on a third of the sales.
//
// `bench` runs each statement under EXPLAIN (ANALYZE) — planning + execution, SCALE_RUNS times
// after 3 warm-ups — as `blast_replica` (the routes read the replica), then each whole read as its
// route runs it, and checks the answers. A Seq Scan on activity fails the run.
//
//   SOCIAL_SCALE_DATABASE_URL=postgresql://postgres:<pw>@127.0.0.1:<port>/<db> \
//     node --no-warnings --import ./scripts/test-tsx-hooks.mjs --experimental-strip-types loadtest/social-coin-market-scale.ts seed|bench
//
// The database must be a disposable loopback Postgres (seed resets it). bench writes
// loadtest/results/social-coin-market-scale-timings.json and -plans.txt.
import fs from "node:fs";

import pg from "pg";

import { migrateDatabase } from "@blast/core/modules/database/migrations.ts";
import { createPool } from "@blast/core/modules/database/pool.ts";
import { CHAIN_FIXTURE, advanceWatermark, resetSharedDatabase, urlAs } from "../../../packages/core/test/fixtures/modules/database/role-fixtures.ts";
import { autocommitReader, type ReadableDatabase } from "@blast/core/modules/database/transaction.ts";
import { PRESALE_BACKER_SAMPLE_COMMITS } from "@blast/core/modules/social/contracts/presales.ts";
import type { PresaleTerms } from "@blast/core/modules/presale/terms/index.ts";
import { COST_BASIS_KINDS, COST_BASIS_ROWS_PER_WALLET } from "@blast/server/modules/social/portfolio/cost-basis.ts";
import { BIG_TRADES_SQL, MY_TRADES_SQL, readChartTrades } from "@blast/server/modules/social/home/chart-trades.ts";
import { HOLDER_LEDGER_SQL, HOLDER_WHYS_SQL, readHomeHolders } from "@blast/server/modules/social/home/holders.ts";
import { CALL_WHYS_SQL, readCalls } from "@blast/server/modules/social/profiles/calls.ts";
import { readStatusCounts } from "@blast/server/modules/social/presales/summary.ts";
import { MARKET_COIN_SQL, MARKET_TRADES_SQL, readHomeMarket } from "@blast/server/modules/social/home/market.ts";
import { BACKER_SAMPLE_SQL, readBackerSamples } from "@blast/server/modules/social/presales/backer-sample.ts";

const URL_ = process.env.SOCIAL_SCALE_DATABASE_URL ?? "";
if (!/^postgres(ql)?:\/\/[^@]+@(127\.0\.0\.1|localhost):\d+\/\w+$/.test(URL_)) {
  throw new Error("SOCIAL_SCALE_DATABASE_URL must name a disposable loopback database (seed resets it).");
}
const DAY = 86_400_000;
const NOW = Date.now();
const RUNS = Number(process.env.SCALE_RUNS ?? 50);
const ACCOUNTS = 10_000, PRESALES = 2_000, FOLLOWS = 100_000;
/** 1M at launch scale; a smaller SCALE_ACTIVITY only checks the script. */
const ACTIVITY = Number(process.env.SCALE_ACTIVITY ?? 1_000_000);
const HOT_TRADES = 60_000, HOT_TRADERS = 5_000, HOT_HOLDERS = 100, HOT_HOLDER_ROWS = 400;
const presaleId = (n: string) => `'0x' || lpad('5a1e' || to_hex(${n}), 64, '0')`;
const saleToken = (n: string) => `${presaleId(n)} || '::coin::S' || ${n}`;
const accountId = (n: string) => `('00000000-0000-4000-8000-' || lpad(to_hex(${n}), 12, '0'))::uuid`;
const wallet = (n: string) => `'0x' || lpad('a11e7' || to_hex(${n}), 64, '0')`;
/** Lifecycle by `n % 10`: 0-1 pending, 2-3 open, 4 funded, 5-8 migrated, 9 cancelled. */
const LIFECYCLE = `(ARRAY['pending','pending','open','open','funded','migrated','migrated','migrated','migrated','cancelled'])[1 + n % 10]`;
const USDC = `0x${"dba3".padStart(64, "0")}::usdc::USDC`;
/** The hot coin: a migrated sale. */
const HOT = 5;
const hotPresale = `0x${`5a1e${HOT.toString(16)}`.padStart(64, "0")}`;
const hotCoin = `${hotPresale}::coin::S${HOT}`;
/** A list page of open sales (n % 10 in 2..3) for the facepile. */
const OPEN_PAGE = Array.from({ length: 20 }, (_, i) => `0x${`5a1e${(2 + i * 10).toString(16)}`.padStart(64, "0")}`);
/** A holder of the hot coin with the most rows of it, two wallets, sharing its portfolio. */
const HEAVY = { account: "00000000-0000-4000-8000-000000000001", wallets: [`0x${"a11e71".padStart(64, "0")}`] };
const WHYS = 50_000;

async function seed() {
  const admin = createPool(URL_, { max: 2 });
  await resetSharedDatabase(admin);
  await admin.query(CHAIN_FIXTURE);
  await migrateDatabase(admin);
  // blast-infra's activity access paths (2026-10-07 `chain_read_activity`, 2026-10-11 `presale_heat`,
  // 2026-11-21 `activity_wallet_sale_ledger`).
  await admin.query(`
    CREATE INDEX activity_time ON blast_infra_fixture.activity (timestamp_ms DESC);
    CREATE INDEX activity_actor ON blast_infra_fixture.activity (actor, timestamp_ms DESC);
    CREATE INDEX activity_presale ON blast_infra_fixture.activity (presale_id, timestamp_ms DESC);
    CREATE INDEX activity_coin ON blast_infra_fixture.activity (coin_type, timestamp_ms DESC);
    CREATE INDEX activity_digest ON blast_infra_fixture.activity (digest);
    CREATE INDEX activity_presale_commit_window ON blast_infra_fixture.activity (presale_id, timestamp_ms)
      INCLUDE (quote_amount, usd_value) WHERE kind = 'presale_commit' AND presale_id IS NOT NULL;
    CREATE INDEX activity_actor_presale ON blast_infra_fixture.activity
      (actor, presale_id, timestamp_ms, checkpoint, tx_slot, event_slot, part) WHERE presale_id IS NOT NULL;`);
  await admin.query(
    `INSERT INTO blast_infra_fixture.presales (presale_id, sale_token, quote_type, sale_symbol, sale_name, sale_icon_url, sale_decimals,
       quote_symbol, quote_decimals, lifecycle, start_ms, end_ms, raise_target, min_commitment, wallet_cap, total_commitments, participants,
       venue, pool_id, updated_checkpoint)
     SELECT ${presaleId("n")}, ${saleToken("n")}, $2,
       'S' || n, 'Sale ' || n, 'https://cdn.blast.fun/s' || n || '.png', 9, 'USDC', 6, l.lifecycle,
       $1::bigint - 30::bigint * ${DAY}, $1::bigint - 26::bigint * ${DAY}, 250000000000, 10000000, 25000000000, 250000000000, 100,
       CASE WHEN n % 2 = 0 THEN 'cetus' ELSE 'bluefin' END, '0x' || lpad('9001' || to_hex(n), 64, '0'), 1
     FROM generate_series(0, ${PRESALES - 1}) n, LATERAL (SELECT ${LIFECYCLE} AS lifecycle) l`,
    [NOW, USDC],
  );
  await admin.query(
    `INSERT INTO blast_infra_fixture.prices
     SELECT ${saleToken("n")}, (0.0001 + (n % 97) * 0.00007)::numeric, $1::bigint - 5000, 'pool'
     FROM generate_series(0, ${PRESALES - 1}) n WHERE n % 10 BETWEEN 5 AND 8
     UNION ALL SELECT $2, 1, $1::bigint, 'pyth'`,
    [NOW, USDC],
  );
  // Every migrated coin's pool reserves (blast-infra's `pool_reserves`, one row per coin).
  await admin.query(
    `INSERT INTO blast_infra_fixture.pool_reserves
     SELECT ${saleToken("n")}, $2, ${presaleId("n")}, '0x' || lpad('9001' || to_hex(n), 64, '0'),
       CASE WHEN n % 2 = 0 THEN 'cetus' ELSE 'bluefin' END, 900000000000000 + n, 45000000000 + n, 1, $1::bigint - 60000
     FROM generate_series(0, ${PRESALES - 1}) n`,
    [NOW, USDC],
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
  // The hot coin's last day: 60,000 trades by 5,000 wallets, a fifth of them over $1,000.
  await admin.query(
    `INSERT INTO blast_infra_fixture.activity
     SELECT 20000000 + i, 0, 1, 0, $1::bigint - 1000 - (i::bigint * ${DAY - 60_000} / ${HOT_TRADES}), 'Dt' || i,
       CASE WHEN i % 3 = 0 THEN 'trade_sell' ELSE 'trade_buy' END, 'market', ${wallet(`1 + i % ${HOT_TRADERS}`)}, ${wallet(`1 + i % ${HOT_TRADERS}`)},
       $2, $3, $4, (1 + i % 3000)::bigint * 1000000, (1 + i % 3000)::bigint * 20000000000, NULL,
       CASE WHEN i % 50 = 0 THEN NULL ELSE (1 + i % 3000)::numeric END, $1::bigint, 'cetus', NULL, NULL
     FROM generate_series(0, ${HOT_TRADES - 1}) i`,
    [NOW, hotPresale, hotCoin, USDC],
  );
  // The 100 largest holders' own history of the coin: 400 rows each over 25 days (claims, buys, sells).
  await admin.query(
    `INSERT INTO blast_infra_fixture.activity
     SELECT 30000000 + h * 1000 + r, 0, 1, 0, $1::bigint - 25::bigint * ${DAY} + (r::bigint * 5000000), 'Dh' || h || '-' || r,
       CASE WHEN r = 0 THEN 'presale_claim' WHEN r % 4 = 3 THEN 'trade_sell' ELSE 'trade_buy' END,
       'market', ${wallet("1 + h")}, ${wallet("1 + h")}, $2, $3, $4,
       CASE WHEN r = 0 THEN 0 ELSE 5000000 END, 100000000000, CASE WHEN r = 0 THEN 0 END,
       CASE WHEN r = 0 THEN NULL ELSE 5 END, $1::bigint, 'cetus', NULL, NULL
     FROM generate_series(0, ${HOT_HOLDERS - 1}) h, generate_series(0, ${HOT_HOLDER_ROWS - 1}) r`,
    [NOW, hotPresale, hotCoin, USDC],
  );
  await admin.query(
    `INSERT INTO blast_infra_fixture.price_history
     SELECT $2, '5m', b, (0.002 + (b / 300000 % 37) * 0.00001)::numeric, b + 60000, 'pool'
     FROM generate_series(($1::bigint - 25::bigint * 3600000) / 300000 * 300000, $1::bigint, 300000) b`,
    [NOW, hotCoin],
  );
  await admin.query(
    `INSERT INTO blast_infra_fixture.vesting_schedules (share, asset, schedule_id, presale_id, beneficiary, total, claimed, start_ms, cliff_ms, end_ms)
     VALUES ('token', 'sale_token', '0x' || lpad('7e1', 64, '0'), $1, '0x' || lpad('7ea1', 64, '0'), 100000000000000000, 25000000000000000, $2::bigint - 30::bigint * ${DAY}, '0', ($2::bigint + 300::bigint * ${DAY})::numeric),
       ('participant', 'sale_token', '0x' || lpad('7e2', 64, '0'), $1, '0x' || lpad('7ea2', 64, '0'), 50000000000000000, 50000000000000000, $2::bigint - 30::bigint * ${DAY}, '0', ($2::bigint - ${DAY}::bigint)::numeric)`,
    [hotPresale, NOW],
  );
  await admin.query(
    `INSERT INTO social_accounts (account_id, privy_did, callsign, display_name, privacy, sharing_since, onboarded_at, portfolio_public)
     SELECT ${accountId("n")}, 'did:privy:scale-' || n, 'acct_' || n, 'Account ' || n, 'public', now() - interval '400 days', now() - interval '400 days', n % 10 = 1
     FROM generate_series(1, ${ACCOUNTS}) n`,
  );
  await admin.query(
    `INSERT INTO social_account_wallets (address, account_id, verified_at)
     SELECT ${wallet("n")}, ${accountId("n")}, now() - interval '400 days' FROM generate_series(1, ${ACCOUNTS}) n`,
  );
  await admin.query(
    `INSERT INTO social_follows (follower_account_id, target_kind, target_id, source)
     SELECT DISTINCT ON (f, t) ${accountId("f")}, 'account', ${accountId("t")}::text, 'user'
     FROM (SELECT 1 + abs(hashtext('f' || n)) % ${ACCOUNTS} AS f, 1 + abs(hashtext('t' || n)) % ${ACCOUNTS} AS t FROM generate_series(1, ${FOLLOWS}) n) x
     WHERE f <> t`,
  );
  // Balances: 100k holders of the migrated coins, and the hot coin's 100 largest (the accounts 1..100).
  await admin.query(
    `INSERT INTO blast_infra_fixture.coin_balances
     SELECT DISTINCT ON (coin_type, owner) ${saleToken("(5 + (abs(hashtext('c' || n)) % 200) * 10 + abs(hashtext('d' || n)) % 4)")} AS coin_type,
       ${wallet("1 + n % 10000")} AS owner, (1 + n % 5000)::numeric * 1000000000, 1
     FROM generate_series(1, 100000) n
     ON CONFLICT DO NOTHING`,
  );
  await admin.query(
    `INSERT INTO blast_infra_fixture.coin_balances
     SELECT $1, ${wallet("1 + h")}, (1000000 - h)::numeric * 1000000000000, 1 FROM generate_series(0, ${HOT_HOLDERS - 1}) h
     ON CONFLICT (coin_type, owner) DO UPDATE SET balance = EXCLUDED.balance`,
    [hotCoin],
  );
  // Parity: whys on a spread of activity rows, each by the row's own account (the insert trigger stamps its sale),
  // and four on each of the hot coin's largest holders' own rows.
  await admin.query(
    `INSERT INTO social_whys (why_id, entry_id, author_account_id, text)
     SELECT gen_random_uuid(), 'a:' || a.checkpoint || ':' || a.tx_slot || ':' || a.event_slot || ':' || a.part, w.account_id, 'Scale thesis ' || a.checkpoint
     FROM blast_infra_fixture.activity a JOIN social_account_wallets w ON w.address = a.actor
     WHERE a.checkpoint < 20000000 AND a.checkpoint % 20 = 0
     LIMIT ${WHYS}`,
  );
  await admin.query(
    `INSERT INTO social_whys (why_id, entry_id, author_account_id, text)
     SELECT gen_random_uuid(), 'a:' || a.checkpoint || ':' || a.tx_slot || ':' || a.event_slot || ':' || a.part, w.account_id, 'Holder thesis ' || a.checkpoint
     FROM blast_infra_fixture.activity a JOIN social_account_wallets w ON w.address = a.actor
     WHERE a.checkpoint >= 30000000 AND a.checkpoint % 100 = 1`,
  );
  await admin.query(
    `INSERT INTO social_sale_trust (presale_id, verified_team, verified_by, verified_at_ms, updated_at_ms)
     SELECT ${presaleId("n")}, true, 'scale', $1::bigint, $1::bigint FROM generate_series(0, ${PRESALES - 1}) n WHERE n % 3 = 0`,
    [NOW],
  );
  await admin.query(advanceWatermark(100_000_000, 0, "market"));
  await admin.query(advanceWatermark(100_000_000, 0, "presale"));
  await admin.query("VACUUM ANALYZE");
  const counts = await admin.query(`SELECT
    (SELECT count(*) FROM social_accounts) accounts, (SELECT count(*) FROM social_follows) follows,
    (SELECT count(*) FROM blast_infra_fixture.presales) presales, (SELECT count(*) FROM blast_infra_fixture.activity) activity,
    (SELECT count(*) FROM blast_infra_fixture.activity WHERE coin_type = $1 AND timestamp_ms > $2::bigint - ${DAY}) hot_day,
    (SELECT count(*) FROM blast_infra_fixture.coin_balances) balances,
    (SELECT count(*) FROM social_whys WHERE state = 'active') whys`, [hotCoin, NOW]);
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

/** A statement under EXPLAIN (ANALYZE): planning + execution per run (3 warm-ups), and its plan once. */
async function explained(pool: pg.Pool, label: string, sql: string, values: readonly unknown[], plans: Record<string, string>): Promise<Timing> {
  const samples: number[] = [];
  for (let i = 0; i < RUNS + 3; i += 1) {
    // react-doctor-disable-next-line react-doctor/async-await-in-loop -- Measure samples serially; overlapping queries would contaminate their latency.
    const { rows } = await pool.query<{ "QUERY PLAN": [{ "Planning Time": number; "Execution Time": number }] }>(`EXPLAIN (ANALYZE, FORMAT JSON) ${sql}`, [...values]);
    const [plan] = rows[0]!["QUERY PLAN"];
    if (i >= 3) samples.push(plan["Planning Time"] + plan["Execution Time"]);
  }
  const text = await pool.query<{ "QUERY PLAN": string }>(`EXPLAIN (ANALYZE, BUFFERS) ${sql}`, [...values]);
  plans[label] = text.rows.map((row) => row["QUERY PLAN"]).join("\n");
  if (/Seq Scan on activity/.test(plans[label]!)) throw new Error(`${label}: a sequential scan of activity`);
  return summarize(label, samples);
}

/** A whole read as its route runs it (wall time, every statement). */
async function timed(label: string, run: () => Promise<unknown>): Promise<Timing> {
  const samples: number[] = [];
  for (let i = 0; i < RUNS + 3; i += 1) {
    const start = performance.now();
    // react-doctor-disable-next-line react-doctor/async-await-in-loop -- Measure samples serially; overlapping queries would contaminate their latency.
    await run();
    if (i >= 3) samples.push(performance.now() - start);
  }
  return summarize(label, samples);
}

async function bench() {
  // The seed's prices are as old as the seed: make them fresh (at most 120 s), as the market pipeline keeps them.
  const admin = new pg.Pool({ connectionString: URL_, max: 1 });
  await admin.query("UPDATE blast_infra_fixture.prices SET as_of_ms = $1", [Date.now()]);
  const clock = Number((await admin.query<{ ms: string }>("SELECT max(timestamp_ms)::text AS ms FROM blast_infra_fixture.activity")).rows[0]!.ms);
  await admin.end();
  const replicaPool = new pg.Pool({ connectionString: urlAs(URL_, "blast_replica"), max: 8 });
  const replica: ReadableDatabase = autocommitReader(replicaPool, "social");
  const timings: Timing[] = [];
  const plans: Record<string, string> = {};
  const problems: string[] = [];
  const nowMs = Date.now();
  const terms = async (id: string) => (id === hotPresale ? { presaleId: id, supply: { total: "1000000000000000000" } } as unknown as PresaleTerms : null);

  // The answers first.
  const market = await readHomeMarket(replica, hotCoin, { nowMs, terms, hiddenKinds: [] });
  console.log(`market: 24h ${market.windows["24h"].buys} buys / ${market.windows["24h"].sells} sells, ${market.windows["24h"].buyers} buyers; 1h change ${market.windows["1h"].change_bps} bps; cap ${market.market_cap_usd} of FDV ${market.fdv_usd}`);
  // The bench's chain clock is the watermark's time, set at the end of the seed: its day leaves out the hot coin's oldest minutes.
  if (market.windows["24h"].buys + market.windows["24h"].sells < HOT_TRADES * 0.95) problems.push("market: the hot coin's day is not counted");
  if (market.windows["5m"].open_usd === null || market.windows["4h"].change_bps === null) problems.push("market: a window has no opening price");
  if (market.supply?.circulating !== "925000000000000000") problems.push(`market: circulating ${market.supply?.circulating}`);
  const holders = await readHomeHolders(replica, hotCoin, 100, { nowMs, terms, hiddenKinds: [] });
  const shared = holders.holders.filter((holder) => holder.basis_usd !== null);
  console.log(`holders: ${holders.holders.length}, ${shared.length} with a basis`);
  if (holders.holders.length !== 100 || shared.length === 0) problems.push(`holders: ${holders.holders.length} rows, ${shared.length} with a basis`);
  const [big, mine] = await Promise.all([
    readChartTrades(replica, { coinType: hotCoin, fromMs: clock - DAY, toMs: clock, minUsd: 1_000 }, null, { nowMs, hiddenKinds: [] }),
    readChartTrades(replica, { coinType: hotCoin, fromMs: clock - 7 * DAY, toMs: clock, minUsd: 1_000 }, HEAVY.wallets, { nowMs, hiddenKinds: [] }),
  ]);
  console.log(`chart: ${big.trades.length} big trades (truncated ${big.truncated}), ${mine.trades.length} of the heavy wallet's`);
  if (big.trades.length === 0 || mine.trades.length === 0) problems.push("chart: an overlay is empty");
  const samples = await readBackerSamples(replica, OPEN_PAGE);
  console.log(`facepiles: ${samples.size} of ${OPEN_PAGE.length} sales have named backers`);

  // Parity answers: every one of the hot coin's largest holders has a why; the tabs count every sale.
  const withWhy = holders.holders.filter((holder) => holder.why).length;
  const [counts, trusted, calls] = await Promise.all([
    readStatusCounts(replica, { nowMs }),
    readStatusCounts(replica, { nowMs, trust: ["verified_team"] }),
    readCalls(replica, HEAVY.account, nowMs),
  ]);
  console.log(`parity: ${withWhy} holders with a why; counts ${JSON.stringify(counts)}, verified ${JSON.stringify(trusted)}; ${calls.calls.length} calls, ${calls.calls.filter((call) => call.why).length} with a why`);
  if (withWhy < HOT_HOLDERS) problems.push(`holders: ${withWhy} of ${HOT_HOLDERS} have a why`);
  if (counts.live + counts.upcoming + counts.ended !== PRESALES) problems.push(`status counts: ${JSON.stringify(counts)}`);
  const countStatements: { text: string; values: unknown[] }[] = [];
  await readStatusCounts({ read: (text, values = []) => { countStatements.push({ text, values: [...values] }); return replica.read(text, values); } } as ReadableDatabase, { nowMs, trust: ["verified_team"] });
  const calledSales = calls.calls.map((call) => call.presale.presale_id);

  const holderWallets = Array.from({ length: HOT_HOLDERS }, (_, h) => `0x${`a11e7${(1 + h).toString(16)}`.padStart(64, "0")}`);
  const holderAccounts = Array.from({ length: HOT_HOLDERS }, (_, h) => `00000000-0000-4000-8000-${(1 + h).toString(16).padStart(12, "0")}`);
  const marketCp = 100_000_000;
  timings.push(await explained(replicaPool, "market trades statement, the hot coin (60,000 trades in its day)", MARKET_TRADES_SQL, [hotCoin, clock, marketCp, ["trade_buy", "trade_sell"]], plans));
  timings.push(await explained(replicaPool, "market coin statement (price, four opening prices, vesting, pool reserves)", MARKET_COIN_SQL, [hotCoin, clock], plans));
  timings.push(await explained(replicaPool, "holders' ledger statement, the hot coin's 100 largest (400 rows each)", HOLDER_LEDGER_SQL, [holderWallets, hotPresale, [...COST_BASIS_KINDS], COST_BASIS_ROWS_PER_WALLET + 1, marketCp, marketCp], plans));
  timings.push(await explained(replicaPool, "big trades statement, the hot coin, 24 h", BIG_TRADES_SQL, [hotCoin, clock - DAY, clock, marketCp, ["trade_buy", "trade_sell"], "1000", 201], plans));
  timings.push(await explained(replicaPool, "big trades statement, the hot coin, 30 days", BIG_TRADES_SQL, [hotCoin, clock - 30 * DAY, clock, marketCp, ["trade_buy", "trade_sell"], "1000", 201], plans));
  timings.push(await explained(replicaPool, "my trades statement, a holder's wallet, 7 days", MY_TRADES_SQL, [hotCoin, clock - 7 * DAY, clock, marketCp, ["trade_buy", "trade_sell"], HEAVY.wallets, 201], plans));
  timings.push(await explained(replicaPool, "facepile statement, a 20-sale list page", BACKER_SAMPLE_SQL, [OPEN_PAGE, PRESALE_BACKER_SAMPLE_COMMITS], plans));
  timings.push(await explained(replicaPool, "parity: holders' whys statement, the hot coin's 100 largest", HOLDER_WHYS_SQL, [holderAccounts, hotPresale, hotCoin, []], plans));
  timings.push(await explained(replicaPool, "parity: calls' whys statement, the heavy holder's calls", CALL_WHYS_SQL, [HEAVY.account, calledSales], plans));
  timings.push(await explained(replicaPool, "parity: tab counts statement, 2,000 sales, verified_team=true", countStatements[0]!.text, countStatements[0]!.values, plans));
  timings.push(await timed("whole read: /home/market, the hot coin", () => readHomeMarket(replica, hotCoin, { nowMs, terms, hiddenKinds: [] })));
  timings.push(await timed("whole read: /home/holders?limit=100, the hot coin", () => readHomeHolders(replica, hotCoin, 100, { nowMs, terms, hiddenKinds: [] })));
  timings.push(await timed("whole read: /home/trades, the hot coin, 24 h", () => readChartTrades(replica, { coinType: hotCoin, fromMs: clock - DAY, toMs: clock, minUsd: 1_000 }, null, { nowMs, hiddenKinds: [] })));
  timings.push(await timed("whole read: tab counts, unfiltered", () => readStatusCounts(replica, { nowMs })));
  timings.push(await timed("whole read: /profiles/{callsign}/calls, the heavy holder", () => readCalls(replica, HEAVY.account, nowMs)));

  const load = fs.readFileSync("/proc/loadavg", "utf8").trim();
  fs.mkdirSync("loadtest/results", { recursive: true });
  fs.writeFileSync("loadtest/results/social-coin-market-scale-timings.json", JSON.stringify({ at: new Date().toISOString(), runs: RUNS, load, timings, problems }, null, 1));
  fs.writeFileSync("loadtest/results/social-coin-market-scale-plans.txt", Object.entries(plans).map(([label, plan]) => `== ${label}\n${plan}\n`).join("\n"));
  console.log(`host load ${load}`);
  for (const problem of problems) console.error(`PROBLEM: ${problem}`);
  await replicaPool.end();
  if (problems.length > 0) process.exitCode = 1;
}

if (process.argv[2] === "seed") await seed();
else if (process.argv[2] === "bench") await bench();
else throw new Error("Usage: social-coin-market-scale.ts seed|bench");
