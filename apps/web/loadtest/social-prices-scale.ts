// R3-20's web consumer at launch scale (OA-28 M4): seed a disposable database
// with blast-infra's own `chain_read_v1.price_history` — the quote coins' `pyth`
// rows (`configured_quotes` joined to `usd_price_buckets`) and every migrated
// sale coin's `pool` rows (`sale_coin_price_buckets` priced by its quote's Pyth
// buckets, carried forward both ways), the view's SQL copied verbatim from
// `2026-10-18-000000_sale_coin_price_history` (blast-infra integration
// c81c5fd) — over the web's fixture chain views, then time
// `GET /api/social/prices`' three statements as the replica role with their
// plans (EXPLAIN ANALYZE, BUFFERS).
//
// Scale: 2,000 migrated sale coins, half busy (a pool price in every bucket:
// 7 days of 5m, 30 days of 1h, 30 of 1d) and half quiet (a trade an hour, so
// the view carries their price forward through the quote's Pyth buckets);
// the two quote coins with 7 days of 5m, 400 of 1h and two years of 1d; 2,000
// shown sales (all trading), their prices, and a few excluded packages.
//
//   SOCIAL_SCALE_DATABASE_URL=postgresql://postgres:<pw>@127.0.0.1:<port>/<db> \
//     node --no-warnings --import ./scripts/test-tsx-hooks.mjs --experimental-strip-types loadtest/social-prices-scale.ts seed|bench
//
// The database must be a disposable loopback Postgres (seed resets it). bench
// prints p50/p95 per statement, fails on a sequential scan of either bucket
// table, and writes the plans to loadtest/results/social-prices-scale-plans.txt.
import fs from "node:fs";

import { migrateDatabase } from "@blast/core/modules/database/migrations.ts";
import { createPool } from "@blast/core/modules/database/pool.ts";
import { CHAIN_FIXTURE, resetSharedDatabase, urlAs } from "../../../packages/core/test/fixtures/modules/database/role-fixtures.ts";
import { PRICE_DEFAULT_POINTS } from "@blast/core/modules/social/contracts/prices.ts";
import { dayOpenAt, PRICE_FIGURES_SQL, PRICE_PRESALES_SQL, PRICE_SERIES_SQL, windowPlan, type PriceKey } from "@blast/server/modules/social/prices/history.ts";

const URL_ = process.env.SOCIAL_SCALE_DATABASE_URL ?? "";
if (!/^postgres(ql)?:\/\/[^@]+@(127\.0\.0\.1|localhost):\d+\/\w+$/.test(URL_)) {
  throw new Error("SOCIAL_SCALE_DATABASE_URL must name a disposable loopback database (seed resets it).");
}
const COINS = 2_000, RUNS = 50, WARMUPS = 3;
const M5 = 300_000, H1 = 3_600_000, D1 = 86_400_000;
/** The seed's clock, a whole day so the tiers line up: the newest 5m bucket starts here. */
const CLOCK = Math.floor(Date.now() / D1) * D1 - 5 * M5;
const hex = (n: number) => `0x${n.toString(16).padStart(64, "0")}`;
const feed = (n: string) => `'0x' || lpad(to_hex(${n}), 64, '0')`;
const coinOf = (n: number) => `${hex(n)}::coin::T${n}`;
const USDC = "0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC";
const SUI = `0x${"0".repeat(63)}2::sui::SUI`;

/** blast-infra's tables (the columns the view reads; u128/u64/u32 domains as numeric/integer) and its view, verbatim. */
const INFRA_PRICE_HISTORY = `
  DROP VIEW chain_read_v1.price_history;
  CREATE TABLE configured_quotes (
    coin_type TEXT PRIMARY KEY,
    symbol TEXT NOT NULL,
    decimals SMALLINT NOT NULL,
    pyth_feed_id TEXT NOT NULL CHECK (pyth_feed_id ~ '^0x[0-9a-f]{64}$')
  );
  CREATE TABLE usd_price_buckets (
    feed_id TEXT NOT NULL CHECK (feed_id ~ '^0x[0-9a-f]{64}$'),
    resolution TEXT NOT NULL CHECK (resolution IN ('5m', '1h', '1d')),
    bucket_ms BIGINT NOT NULL CHECK (bucket_ms >= 0),
    price NUMERIC NOT NULL,
    expo BIGINT NOT NULL,
    publish_time NUMERIC NOT NULL,
    checkpoint BIGINT NOT NULL,
    tx_slot INTEGER NOT NULL,
    event_slot INTEGER NOT NULL,
    part INTEGER NOT NULL,
    PRIMARY KEY (feed_id, resolution, bucket_ms)
  );
  CREATE TABLE sale_coins (
    coin_type TEXT PRIMARY KEY,
    presale_id TEXT NOT NULL UNIQUE,
    decimals SMALLINT
  );
  CREATE TABLE sale_coin_pools (
    pool_id TEXT PRIMARY KEY,
    presale_id TEXT NOT NULL,
    coin_type TEXT NOT NULL UNIQUE,
    quote_type TEXT NOT NULL
  );
  CREATE TABLE excluded_sale_packages (package_id TEXT PRIMARY KEY);
  CREATE TABLE sale_coin_price_buckets (
    coin_type TEXT COLLATE "C" NOT NULL,
    resolution TEXT NOT NULL CHECK (resolution IN ('5m', '1h', '1d')),
    bucket_ms BIGINT NOT NULL CHECK (bucket_ms >= 0),
    sqrt_price_x64 NUMERIC NOT NULL,
    price NUMERIC CHECK (price >= 0),
    price_timestamp_ms BIGINT NOT NULL,
    checkpoint BIGINT NOT NULL,
    tx_slot INTEGER NOT NULL,
    event_slot INTEGER NOT NULL,
    PRIMARY KEY (coin_type, resolution, bucket_ms)
  );
  ALTER TABLE configured_quotes OWNER TO blast_indexer;
  ALTER TABLE usd_price_buckets OWNER TO blast_indexer;
  ALTER TABLE sale_coins OWNER TO blast_indexer;
  ALTER TABLE sale_coin_pools OWNER TO blast_indexer;
  ALTER TABLE excluded_sale_packages OWNER TO blast_indexer;
  ALTER TABLE sale_coin_price_buckets OWNER TO blast_indexer;
  REVOKE ALL ON configured_quotes, usd_price_buckets, sale_coins, sale_coin_pools, excluded_sale_packages, sale_coin_price_buckets
    FROM PUBLIC, blast_web, blast_watcher, blast_social, blast_replica;
CREATE VIEW chain_read_v1.price_history AS
SELECT
    q.coin_type,
    b.resolution,
    b.bucket_ms,
    trim_scale(b.price * ('1e' || b.expo)::NUMERIC) AS usd_price,
    (b.publish_time * 1000)::BIGINT AS as_of_ms,
    'pyth'::TEXT AS source
FROM configured_quotes q
JOIN usd_price_buckets b ON b.feed_id = q.pyth_feed_id
UNION ALL
-- At each of the pool's buckets: its last price in the bucket times the quote's last Pyth price at
-- or before the bucket.
SELECT
    p.coin_type,
    s.resolution,
    s.bucket_ms,
    trim_scale(
        s.price * ('1e' || (c.decimals - q.decimals))::NUMERIC * u.price
            * ('1e' || u.expo)::NUMERIC
    ),
    greatest(s.price_timestamp_ms, (u.publish_time * 1000)::BIGINT),
    'pool'::TEXT
FROM sale_coin_pools p
JOIN sale_coins c ON c.coin_type = p.coin_type
JOIN configured_quotes q ON q.coin_type = p.quote_type
JOIN sale_coin_price_buckets s ON s.coin_type = p.coin_type COLLATE "C"
CROSS JOIN LATERAL (
    SELECT price, expo, publish_time
    FROM usd_price_buckets
    WHERE feed_id = q.pyth_feed_id AND resolution = s.resolution AND bucket_ms <= s.bucket_ms
    ORDER BY bucket_ms DESC
    LIMIT 1
) u
WHERE s.price IS NOT NULL
  AND c.decimals IS NOT NULL
  AND NOT EXISTS (
      SELECT 1 FROM excluded_sale_packages x
      WHERE x.package_id = split_part(p.coin_type, '::', 1)
  )
UNION ALL
-- At each of the quote's Pyth buckets after the pool's first stored one, where the pool did not
-- move: the pool's last price before it, carried forward, times that Pyth price.
SELECT
    p.coin_type,
    b.resolution,
    b.bucket_ms,
    trim_scale(
        s.price * ('1e' || (c.decimals - q.decimals))::NUMERIC * b.price
            * ('1e' || b.expo)::NUMERIC
    ),
    greatest(s.price_timestamp_ms, (b.publish_time * 1000)::BIGINT),
    'pool'::TEXT
FROM sale_coin_pools p
JOIN sale_coins c ON c.coin_type = p.coin_type
JOIN configured_quotes q ON q.coin_type = p.quote_type
JOIN usd_price_buckets b ON b.feed_id = q.pyth_feed_id
CROSS JOIN LATERAL (
    SELECT bucket_ms, price, price_timestamp_ms
    FROM sale_coin_price_buckets
    WHERE coin_type = p.coin_type COLLATE "C" AND resolution = b.resolution
      AND bucket_ms <= b.bucket_ms
    ORDER BY bucket_ms DESC
    LIMIT 1
) s
WHERE s.bucket_ms < b.bucket_ms
  AND s.price IS NOT NULL
  AND c.decimals IS NOT NULL
  AND NOT EXISTS (
      SELECT 1 FROM excluded_sale_packages x
      WHERE x.package_id = split_part(p.coin_type, '::', 1)
  );;
  ALTER VIEW chain_read_v1.price_history OWNER TO blast_indexer;
  REVOKE ALL ON chain_read_v1.price_history FROM PUBLIC;
  GRANT SELECT ON chain_read_v1.price_history TO blast_web, blast_watcher, blast_social, blast_replica;
`;

/** One tier's Pyth buckets of the two quote feeds: `count` back from the clock, a price published 61 s in. */
function quoteBuckets(resolution: string, span: number, count: number): string {
  return `INSERT INTO usd_price_buckets (feed_id, resolution, bucket_ms, price, expo, publish_time, checkpoint, tx_slot, event_slot, part)
    SELECT ${feed("f")}, '${resolution}', b.bucket_ms,
      CASE WHEN f = 1 THEN 342000000 + (b.i * 7919) % 2000000 ELSE 99990000 + (b.i * 31) % 20000 END, -8, (b.bucket_ms + 61000) / 1000, 1, 0, 0, 0
    FROM generate_series(1, 2) f
    CROSS JOIN LATERAL (SELECT i, ${Math.floor(CLOCK / span) * span} - i::bigint * ${span} AS bucket_ms FROM generate_series(0, ${count - 1}) i) b`;
}

/** One tier's pool buckets of every sale coin: busy coins (even) every bucket, quiet ones (odd) every `quiet`th. */
function poolBuckets(resolution: string, span: number, count: number, quiet: number): string {
  return `INSERT INTO sale_coin_price_buckets (coin_type, resolution, bucket_ms, sqrt_price_x64, price, price_timestamp_ms, checkpoint, tx_slot, event_slot)
    SELECT ${coin("n")}, '${resolution}', b.bucket_ms, 1, 0.0000021 + ((n * 37 + b.i * 13) % 900) * 0.000000001, b.bucket_ms + 61000, 1, 0, 0
    FROM generate_series(1, ${COINS}) n
    CROSS JOIN LATERAL (SELECT i, ${Math.floor(CLOCK / span) * span} - i::bigint * ${span} AS bucket_ms FROM generate_series(0, ${count - 1}) i) b
    WHERE n % 2 = 0 OR b.i % ${quiet} = 0`;
}

/** Sale coin `n`'s type in SQL (the presale fixture's `sale_token`). */
const coin = (n: string) => `'0x' || lpad(to_hex(${n} + 2), 64, '0') || '::coin::T' || (${n} + 2)`;

async function seed() {
  const admin = createPool(URL_, { max: 2 });
  await resetSharedDatabase(admin);
  await admin.query(CHAIN_FIXTURE);
  await migrateDatabase(admin);
  await admin.query(INFRA_PRICE_HISTORY);
  // The quote coins: SUI (feed 1) and USDC (feed 2).
  await admin.query(
    `INSERT INTO configured_quotes (coin_type, symbol, decimals, pyth_feed_id)
     VALUES ('${SUI}', 'SUI', 9, ${feed("1")}), ('${USDC}', 'USDC', 6, ${feed("2")})`,
  );
  console.time("buckets");
  await admin.query(quoteBuckets("5m", M5, 2_016));
  await admin.query(quoteBuckets("1h", H1, 9_600));
  await admin.query(quoteBuckets("1d", D1, 730));
  // 2,000 migrated sale coins, a quarter quoted in SUI, each with its pool.
  await admin.query(
    `INSERT INTO sale_coins (coin_type, presale_id, decimals) SELECT ${coin("n")}, '0x' || lpad(to_hex(900000 + n), 64, '0'), 9 FROM generate_series(1, ${COINS}) n`,
  );
  await admin.query(
    `INSERT INTO sale_coin_pools (pool_id, presale_id, coin_type, quote_type)
     SELECT 'pool' || n, '0x' || lpad(to_hex(900000 + n), 64, '0'), ${coin("n")}, CASE WHEN n % 4 = 0 THEN '${SUI}' ELSE '${USDC}' END
     FROM generate_series(1, ${COINS}) n`,
  );
  await admin.query(`INSERT INTO excluded_sale_packages (package_id) SELECT '0x' || lpad(to_hex(800000 + n), 64, '0') FROM generate_series(1, 3) n`);
  await admin.query(poolBuckets("5m", M5, 2_016, 12));
  await admin.query(poolBuckets("1h", H1, 720, 6));
  await admin.query(poolBuckets("1d", D1, 30, 3));
  console.timeEnd("buckets");
  // 2,000 shown sales, all trading, launched 1 to 30 days ago.
  await admin.query(
    `INSERT INTO blast_infra_fixture.presales (presale_id, sale_token, quote_type, sale_symbol, sale_name, sale_icon_url, sale_decimals, quote_symbol,
       quote_decimals, lifecycle, start_ms, end_ms, raise_target, min_commitment, wallet_cap, total_commitments, participants, venue, pool_id, updated_checkpoint)
     SELECT '0x' || lpad(to_hex(900000 + n), 64, '0'), ${coin("n")}, '${USDC}', 'T' || n, 'Token ' || n,
       'https://i.blast.test/' || n || '.png', 9, 'USDC', 6, 'migrated', 0, 1, 100000000000, 1000000, NULL, 0, 0, 'cetus', NULL, 1
     FROM generate_series(1, ${COINS}) n`,
  );
  await admin.query(
    `INSERT INTO blast_infra_fixture.presale_lifecycle (presale_id, state, digest, timestamp_ms, checkpoint)
     SELECT '0x' || lpad(to_hex(900000 + n), 64, '0'), 'migrated', 'L' || n, ${CLOCK} - (1 + n % 30)::bigint * ${D1}, 1
     FROM generate_series(1, ${COINS}) n`,
  );
  await admin.query(
    `INSERT INTO blast_infra_fixture.prices (coin_type, usd_price, as_of_ms, source)
     SELECT coin_type, 0.0021, ${CLOCK}, 'pool' FROM sale_coins
     UNION ALL VALUES ('${SUI}', 3.42, ${CLOCK}, 'pyth'), ('${USDC}', 1, ${CLOCK}, 'pyth')`,
  );
  await admin.query("ANALYZE");
  const size = await admin.query(
    `SELECT (SELECT count(*)::int FROM usd_price_buckets) AS pyth_buckets, (SELECT count(*)::int FROM sale_coin_price_buckets) AS pool_buckets,
       pg_size_pretty(pg_total_relation_size('sale_coin_price_buckets')) AS pool_size`,
  );
  console.log(JSON.stringify(size.rows[0]));
  await admin.end();
}

type Statement = Readonly<{ name: string; sql: string; values: unknown[] }>;

function seriesValues(keys: readonly PriceKey[], window: "24h" | "launch"): unknown[] {
  const plans = keys.map((key) => windowPlan(window, key, CLOCK, PRICE_DEFAULT_POINTS)!);
  return [
    keys.map((key) => key.coinType),
    plans.map((plan) => plan.tier),
    plans.map((plan) => plan.lo),
    plans.map((plan) => plan.hi),
    plans.map((plan) => plan.step),
    plans.map((plan) => plan.head),
    plans.map((plan) => plan.after),
  ];
}

async function bench() {
  const replica = createPool(urlAs(URL_, "blast_replica"), { max: 2 });
  // The lanes' ask: 50 trading sales, busy and quiet alternately, launched 1 to 30 days ago.
  const trading = Array.from({ length: 50 }, (_, i) => 101 + i);
  const keys: PriceKey[] = trading.map((n) => ({ presaleId: hex(900000 + n), coinType: coinOf(n + 2), launchedMs: CLOCK - (1 + (n % 30)) * D1 }));
  const young: PriceKey[] = keys.slice(0, 20).map((key) => ({ ...key, launchedMs: CLOCK - 6 * H1 }));
  const sui: PriceKey = { presaleId: null, coinType: SUI, launchedMs: null };
  const statements: Statement[] = [
    { name: "the asked sales (50, SHOWN_PRESALES by key, with their launch)", sql: PRICE_PRESALES_SQL, values: [keys.map((key) => key.presaleId)] },
    { name: "figures: now, 24 h ago, day open (50 coins, the lanes)", sql: PRICE_FIGURES_SQL, values: [keys.map((key) => key.coinType), CLOCK - D1, dayOpenAt(CLOCK)] },
    { name: "series: last 24 h, 5m thinned to 60 (50 coins, the lanes)", sql: PRICE_SERIES_SQL, values: seriesValues(keys, "24h") },
    { name: "series: since launch, 1 to 30 days (50 coins, a feed page's calls)", sql: PRICE_SERIES_SQL, values: seriesValues(keys, "launch") },
    { name: "series: since launch, 6 h old (20 coins, 5m)", sql: PRICE_SERIES_SQL, values: seriesValues(young, "launch") },
    { name: "figures: SUI (the coin sheet, the dock)", sql: PRICE_FIGURES_SQL, values: [[SUI], CLOCK - D1, dayOpenAt(CLOCK)] },
    { name: "series: SUI's last 24 h", sql: PRICE_SERIES_SQL, values: seriesValues([sui], "24h") },
  ];
  const plans: string[] = [];
  let scans = 0;
  for (const statement of statements) {
    const times: number[] = [];
    let plan = "";
    let rows = 0;
    for (let run = 0; run < WARMUPS + RUNS; run += 1) {
      const result = await replica.query<{ "QUERY PLAN": unknown }>(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${statement.sql}`, statement.values);
      const json = (result.rows[0]!["QUERY PLAN"] as { "Planning Time": number; "Execution Time": number; Plan: { "Actual Rows": number } }[])[0]!;
      if (run >= WARMUPS) times.push(json["Planning Time"] + json["Execution Time"]);
      rows = json.Plan["Actual Rows"];
      if (run === WARMUPS + RUNS - 1) {
        const text = await replica.query<Record<string, string>>(`EXPLAIN (ANALYZE, BUFFERS) ${statement.sql}`, statement.values);
        plan = text.rows.map((row) => row["QUERY PLAN"]).join("\n");
      }
    }
    times.sort((a, b) => a - b);
    const pct = (p: number) => times[Math.min(times.length - 1, Math.ceil((p / 100) * times.length) - 1)]!.toFixed(2);
    const seq = /Seq Scan on (usd_price_buckets|sale_coin_price_buckets)/.test(plan);
    if (seq) scans += 1;
    console.log(`${statement.name}: p50 ${pct(50)} ms, p95 ${pct(95)} ms, ${rows} rows${seq ? ", SEQ SCAN of the buckets" : ""}`);
    plans.push(`== ${statement.name} ==\n${plan}\n`);
  }
  fs.mkdirSync("loadtest/results", { recursive: true });
  fs.writeFileSync("loadtest/results/social-prices-scale-plans.txt", plans.join("\n"));
  await replica.end();
  if (scans > 0) throw new Error(`${scans} statements scan a bucket table`);
}

if (process.argv[2] === "seed") await seed();
else if (process.argv[2] === "bench") await bench();
else throw new Error("Usage: social-prices-scale.ts seed|bench");
