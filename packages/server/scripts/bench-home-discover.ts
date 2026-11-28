// Home Discover at production scale, on a disposable loopback Postgres only.
// Seeds about 940 live bonding curves, 150 migrated curves, 60
// presales and a week of trades with production's activity indexes, then times
// `readHomeDiscover` as the replica role and lists the slowest statements.
// Discover once listed every live curve and timed out (57014) in production;
// the default read must stay well under the 2 s statement timeout.
//
//   cd packages/server && ../../scripts/with-disposable-postgres.sh \
//     node --no-warnings --import ../../scripts/test-tsx-hooks.mjs --experimental-strip-types scripts/bench-home-discover.ts
//
// LIVE_CURVES, MIGRATED, LIVE_TRADES and DEX_TRADES resize the seed; CASES is a
// comma-separated list of Home queries; EXPLAIN=1 prints the two slowest plans.
import pg from "pg";
import { createRuntimePool } from "@blast/core/modules/database/pool.ts";
import { autocommitReader, type ReadableDatabase } from "@blast/core/modules/database/transaction.ts";
import { readHomeDiscover, type HomeReadContext } from "@blast/server/modules/social/home/coins.ts";
import { parseHomeQuery } from "@blast/server/modules/social/home/rank.ts";
import { urlAs } from "../../core/test/fixtures/modules/database/role-fixtures.ts";
import { freshTestDatabase } from "../../core/test/fixtures/modules/database/template.ts";

const LIVE = Number(process.env.LIVE_CURVES ?? 940);
const MIGRATED = Number(process.env.MIGRATED ?? 150);
const DAYS = 7;
const LIVE_TRADES_PER_DAY = Number(process.env.LIVE_TRADES ?? 30);
const DEX_TRADES_PER_DAY = Number(process.env.DEX_TRADES ?? 80);
const WALLETS = 3000;
const SUI = "0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI";

const testUrl = process.env.MISSION_CONTROL_TEST_DATABASE_URL;
if (!testUrl || !["127.0.0.1", "localhost", "[::1]"].includes(new URL(testUrl).hostname)) throw new Error("Run against a loopback test database only.");
const database = await freshTestDatabase();
const admin = new pg.Client({ connectionString: database.url });
await admin.connect();
const now = Date.now();
const hex = (prefix: string, i: string) => `'0x' || lpad(${prefix} || ${i}::text, 64, '0')`;
await admin.query(`
  UPDATE watermarks SET checkpoint_hi_inclusive = 2000000000, timestamp_ms_hi_inclusive = ${now};
  INSERT INTO blast_infra_fixture.coin_metadata VALUES ('${SUI}', 'Sui', 'SUI', '', NULL, 9) ON CONFLICT DO NOTHING;
  INSERT INTO blast_infra_fixture.prices VALUES ('${SUI}', 3, ${now}, 'pyth') ON CONFLICT DO NOTHING;
  -- Live curves and migrated curves with a DEX pool and a launch vault. Live reserves spread evenly from 0 to 99%
  -- of target; Closest to graduating reads every live curve and keeps the top HOME_CLOSEST_CURVES.
  CREATE TEMP TABLE bench_coins AS
    SELECT i, (${hex("'c'", "i")}) || '::coin::C' || i AS coin_type, i <= ${LIVE} AS live FROM generate_series(1, ${LIVE + MIGRATED}) i;
  INSERT INTO blast_infra_fixture.coin_metadata SELECT coin_type, 'Coin ' || i, 'C' || i, '', NULL, 6 FROM bench_coins;
  INSERT INTO public.coins (coin_type, decimals, launcher, creator, metadata, pool_key, created_checkpoint, created_at_ms, currency_supply)
    SELECT coin_type, 6, '0xl', '0xl', jsonb_build_object('name', 'Coin ' || i, 'symbol', 'C' || i), 'blast_curve:0xp' || i, 1000 + i, ${now} - i * 600000, 1000000000000000 FROM bench_coins;
  INSERT INTO public.pools (pool_key, venue, coin_type, quote_type, lifecycle, created_checkpoint, created_at_ms, quote_reserve, params)
    SELECT 'blast_curve:0xp' || i, 'blast_curve', coin_type, '${SUI}',
      CASE WHEN NOT live THEN 'migrated' WHEN i % 25 = 0 THEN 'migration_ready' ELSE 'live' END,
      1000 + i, ${now} - i * 600000,
      CASE WHEN live THEN (i * 7919 % 100) * 30000000000::numeric ELSE 3000000000000 END,
      jsonb_build_object('graduation_target', 3000000000000) FROM bench_coins;
  INSERT INTO public.pools (pool_key, venue, coin_type, quote_type, lifecycle, created_checkpoint, created_at_ms)
    SELECT 'cetus:0xd' || i, 'cetus', coin_type, '${SUI}', 'live', 2000 + i, ${now} - i * 300000 FROM bench_coins WHERE NOT live;
  INSERT INTO blast_infra_fixture.vaults (vault_id, meme_type, name, symbol, decimals, venue_type, pool_id, quote_type, quote_symbol, quote_decimals, created_checkpoint, origin_id)
    SELECT '0xv' || i, coin_type, 'Coin ' || i, 'C' || i, 6, 'cetus', '0xd' || i, '${SUI}', 'SUI', 9, 2000 + i, 'blast_curve:0xp' || i FROM bench_coins WHERE NOT live;
  INSERT INTO blast_infra_fixture.prices SELECT coin_type, (i % 50 + 1) * 0.000001, ${now} - 60000, 'pool' FROM bench_coins;
  INSERT INTO blast_infra_fixture.price_history
    SELECT coin_type, '1h', b, (i % 50 + 1) * 0.000001, b, 'pool'
    FROM bench_coins, generate_series(((${now} / 3600000) - 48) * 3600000, (${now} / 3600000) * 3600000, 3600000) b;
  INSERT INTO blast_infra_fixture.coin_holder_history
    SELECT coin_type, 1000 + k, ${now} - (30 - k) * 6 * 3600000, 10 + k * (i % 7) FROM bench_coins, generate_series(1, 30) k;
  INSERT INTO blast_infra_fixture.activity
    (checkpoint, tx_slot, event_slot, part, timestamp_ms, digest, kind, product, actor, tx_sender, presale_id, coin_type, quote_type, quote_amount, coin_amount, usd_value, venue)
    SELECT 5000000 + n, 0, 0, 0, ${now} - (n::bigint * 7907 % (${DAYS} * 86400000)), 'd' || n, CASE WHEN n % 3 = 0 THEN 'trade_sell' ELSE 'trade_buy' END, 'market',
      (${hex("'a'", "(n % " + WALLETS + ")")}), '0xs', NULL, c.coin_type, '${SUI}', 1000000000, 1000000, 3, CASE WHEN c.live THEN 'blast_curve' ELSE 'cetus' END
    FROM bench_coins c
    CROSS JOIN LATERAL generate_series(c.i::bigint * 100000, c.i::bigint * 100000 + ${DAYS} * CASE WHEN c.live THEN ${LIVE_TRADES_PER_DAY} ELSE ${DEX_TRADES_PER_DAY} END - 1) n;
  -- Presales: 40 migrated to a Cetus pool, 20 open taking commits.
  CREATE TEMP TABLE bench_sales AS
    SELECT j, '0xs' || j AS presale_id, (${hex("'p'", "j")}) || '::sale::S' || j AS coin_type, j <= 40 AS migrated FROM generate_series(1, 60) j;
  INSERT INTO blast_infra_fixture.coin_metadata SELECT coin_type, 'Sale ' || j, 'S' || j, '', NULL, 6 FROM bench_sales;
  INSERT INTO blast_infra_fixture.presales (presale_id, creator, created_at_ms, sale_token, quote_type, sale_symbol, sale_name, sale_icon_url, sale_decimals, quote_symbol, quote_decimals,
      lifecycle, start_ms, end_ms, raise_target, min_commitment, total_commitments, participants, venue, pool_id, updated_checkpoint)
    SELECT presale_id, '0xc', ${now} - j * 3600000, coin_type, '${SUI}', 'S' || j, 'Sale ' || j, '', 6, 'SUI', 9,
      CASE WHEN migrated THEN 'migrated' ELSE 'open' END, ${now} - j * 3600000, ${now} + 86400000 - j * 1800000,
      50000000000000, 1000000000, 40000000000000, 300, CASE WHEN migrated THEN 'cetus' END, CASE WHEN migrated THEN '0xsp' || j END, 3000 + j FROM bench_sales;
  INSERT INTO public.pools (pool_key, venue, coin_type, quote_type, lifecycle, created_checkpoint, created_at_ms)
    SELECT 'cetus:0xsp' || j, 'cetus', coin_type, '${SUI}', 'live', 3000 + j, ${now} - j * 3600000 FROM bench_sales WHERE migrated;
  INSERT INTO blast_infra_fixture.prices SELECT coin_type, 0.001, ${now} - 60000, 'pool' FROM bench_sales WHERE migrated;
  INSERT INTO blast_infra_fixture.coin_holder_history
    SELECT coin_type, 1000 + k, ${now} - (30 - k) * 6 * 3600000, 100 + k FROM bench_sales, generate_series(1, 30) k WHERE migrated;
  INSERT INTO blast_infra_fixture.activity
    (checkpoint, tx_slot, event_slot, part, timestamp_ms, digest, kind, product, actor, tx_sender, presale_id, coin_type, quote_type, quote_amount, coin_amount, usd_value, venue)
    SELECT 5000000 + n, 0, 0, 0, ${now} - (n::bigint * 7907 % (${DAYS} * 86400000)), 'd' || n,
      CASE WHEN NOT s.migrated THEN 'presale_commit' WHEN n % 3 = 0 THEN 'trade_sell' ELSE 'trade_buy' END, CASE WHEN s.migrated THEN 'market' ELSE 'presale' END,
      (${hex("'a'", "(n % " + WALLETS + ")")}), '0xs', s.presale_id, s.coin_type, '${SUI}', 1000000000, 1000000, 3, CASE WHEN s.migrated THEN 'cetus' END
    FROM bench_sales s
    CROSS JOIN LATERAL generate_series(900000000 + s.j::bigint * 100000, 900000000 + s.j::bigint * 100000 + ${DAYS} * 100 - 1) n;
  -- Production's indexes (blast-infra migrations).
  CREATE INDEX ON blast_infra_fixture.activity (timestamp_ms DESC);
  CREATE INDEX ON blast_infra_fixture.activity (coin_type, timestamp_ms DESC);
  CREATE INDEX ON blast_infra_fixture.activity (presale_id, timestamp_ms DESC);
  CREATE INDEX ON blast_infra_fixture.activity (actor, timestamp_ms DESC);
  CREATE INDEX ON public.pools (coin_type);
  CREATE INDEX ON blast_infra_fixture.vaults (meme_type);
  ANALYZE;
`);
const { rows: [count] } = await admin.query<{ activity: string; pools: string }>(
  "SELECT (SELECT count(*) FROM blast_infra_fixture.activity)::text AS activity, (SELECT count(*) FROM public.pools)::text AS pools");
console.log(`seeded: ${LIVE} live curves, ${MIGRATED} migrated, 60 presales, ${count?.activity} activity rows, ${count?.pools} pools`);

const pool = createRuntimePool(urlAs(database.url, "blast_replica"),
  { connectionTimeoutMs: 5_000, idleInTransactionMs: 5_000, idleTimeoutMs: 1_000, lockTimeoutMs: 2_000, max: 8, statementTimeoutMs: 60_000 }, "bench");
const reader = autocommitReader(pool, "social");
const statements: { ms: number; sql: string; values: unknown }[] = [];
const db: ReadableDatabase = {
  ...reader,
  read: async (sql, values, rowMode) => {
    const start = performance.now();
    try {
      return await reader.read(sql, values, rowMode);
    } finally {
      statements.push({ ms: performance.now() - start, sql, values });
    }
  },
} as ReadableDatabase;
const label = (sql: string) => sql.replace(/\s+/g, " ").slice(0, 70);

const cases = (process.env.CASES ?? "window=24h&sort=relevant,window=24h&stage=almost&sort=progress,window=24h&stage=graduated&sort=market_cap").split(",");
for (const query of cases) {
  const times: number[] = [];
  let total = 0;
  for (let run = 0; run < 4; run += 1) {
    statements.length = 0;
    const context = { nowMs: Date.now(), hiddenKinds: [], terms: null, includeCurve: true, includeDexVolume: true, includeRecentBuys: true, includeMobileMarket: true } as HomeReadContext;
    const start = performance.now();
    total = (await readHomeDiscover(db, parseHomeQuery(new URLSearchParams(`${query}&curve=1`)), context)).total;
    times.push(performance.now() - start);
  }
  console.log(`\n${query}: total=${total} runs(ms)=${times.map((time) => time.toFixed(0)).join(",")}`);
  const slowest = [...statements].sort((a, b) => b.ms - a.ms);
  for (const statement of slowest.slice(0, 5)) console.log(`  ${statement.ms.toFixed(0).padStart(6)} ms  ${label(statement.sql)}`);
  if (process.env.EXPLAIN) for (const statement of slowest.slice(0, 2)) {
    const { rows } = await pool.query(`EXPLAIN (ANALYZE, BUFFERS) ${statement.sql}`, statement.values as unknown[]);
    console.log(`\n### ${label(statement.sql)}\n${rows.map((row) => row["QUERY PLAN"]).join("\n")}`);
  }
}
await pool.end();
await admin.end();
await database.drop?.();
