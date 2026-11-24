// R3-57 scale evidence: Recent activity (`GET /api/social/activity`, the
// ticker's read) at launch scale. `seed` builds a disposable database: 10k
// accounts, each with its wallet linked (every activity row's actor is a
// naming-rule lookup, nine in ten of them named), 2,000 shown sales, 1M
// activity rows over about 25 days (the spread is `hashtext`'s non-negative
// int4 range in ms; 85% commits, 10% claims, 5% trades of migrated
// sales' coins), blast-infra's activity indexes, and the rows the read must
// skip: T-043's three excluded test sales (no `presales` row, 3,000 rows of
// activity and 1,000 of them the **newest** rows in the log, the pessimistic
// case for the in-scan filter) and a sale whose coin metadata has not arrived.
// `bench` runs, as `blast_replica`, the page statement under EXPLAIN (ANALYZE),
// planning + execution, SCALE_RUNS times after 3 warm-ups, and the whole read
// as the route runs it:
//
// - the newest page (what the ticker reads on every hint and poll), trading
//   hidden and visible;
// - a keyset page 20 days back (a `before` cursor), and the page right after
//   the newest (the gap fill's first step).
//
// `bench-happening` runs Home's `GET /api/social/happening` read over the same
// seed (T-011's hidden-sale fix): it checks the answer against the fixture
// table read directly with the hidden sales named (the tape is the 8 newest
// shown rows although the newest 1,000 rows are hidden; the last hour counts
// no hidden wallet or dollar), then times the tape and last-hour statements
// under EXPLAIN (ANALYZE) and the whole read as the route runs it. A wrong
// answer is reported after the timings, so the read before the fix can be
// measured too.
//
// `bench-feed` runs every other reader of activity across sales that the
// hidden-sale fix of 2026-10-05 changed, over the same seed plus what they
// read besides it (added idempotently, as the owner): 100k account follows,
// an account's theses on its commits to the excluded sales (with rockets) and
// to shown ones, an account's 1,000 notifications whose 300 newest are of the
// excluded sales (rows the generator wrote before the fix), a follower of
// every account that committed to them, and backer counters on every commit
// (as blast-infra stamps them) for the milestone and fill steps. Reads
// run as the role production uses (the replica for the feed and profiles,
// `blast_web` for notifications and viewer state, `blast_watcher` for the
// worker); each statement is timed under EXPLAIN (ANALYZE) and the worker's
// inserts run inside a transaction that is rolled back (`SCALE_WRITE_RUNS`,
// 10 by default). The worker statements run over two batches: the newest
// 500 commits (all of them the excluded sales') and the newest 1,500. Every
// answer is checked for a hidden sale, reported after the timings so the
// reads before the fix can be measured too.
//
//   SOCIAL_SCALE_DATABASE_URL=postgresql://postgres:<pw>@127.0.0.1:<port>/<db> \
//     node --no-warnings --import ./scripts/test-tsx-hooks.mjs --experimental-strip-types scripts/loadtest/social-activity-scale.ts seed|bench|bench-happening|bench-feed
//
// The database must be a disposable loopback Postgres (seed resets it). bench
// writes loadtest/results/social-activity-scale-timings.json and -plans.txt,
// bench-happening social-happening-hidden-scale-timings.json and -plans.txt,
// bench-feed social-feed-hidden-scale-timings.json and -plans.txt.
import fs from "node:fs";

import pg from "pg";

import { migrateDatabase } from "@blast/core/modules/database/migrations.ts";
import { createPool } from "@blast/core/modules/database/pool.ts";
import { CHAIN_FIXTURE, advanceWatermark, resetSharedDatabase, urlAs } from "../../packages/core/test/fixtures/modules/database/role-fixtures.ts";
import { autocommitReader, type ReadableDatabase } from "@blast/core/modules/database/transaction.ts";
import { readActivityPage, decodeActivityCursor } from "@blast/server/modules/social/activity/read.ts";
import { SOCIAL_CONFIG_DEFAULTS } from "@blast/core/modules/social/contracts/config.ts";
import { SOCIAL_FEED_TRADE_KINDS } from "@blast/core/modules/social/contracts/feed.ts";
import { HAPPENING_LAST_HOUR_MS, HAPPENING_TAPE_KINDS, HAPPENING_TAPE_MAX } from "@blast/core/modules/social/contracts/happening.ts";
import { forYouEntries, forYouNewEntries } from "@blast/server/modules/social/feed/for-you.ts";
import { readHappening, type HappeningRequest } from "@blast/server/modules/social/happening/read.ts";
import { INTENT_STATEMENTS } from "../../apps/workers/src/modules/social/intents/resolve.ts";
import { toUsd } from "@blast/core/modules/social/items/decimal.ts";
import { MILESTONE_STATEMENTS } from "../../apps/workers/src/modules/social/milestones/generate.ts";
import { NOTIFICATION_STATEMENTS } from "../../apps/workers/src/modules/social/notifications/generate.ts";
import { readNotificationItems, readUnreadCount } from "@blast/server/modules/social/notifications/store.ts";
import { readCalls } from "@blast/server/modules/social/profiles/calls.ts";
import { thesisEntriesOf } from "@blast/server/modules/social/profiles/theses.ts";
import { isVisible, personEntriesOf, presalePostEntriesOf, visibleEntry } from "@blast/core/modules/social/read-model/entries.ts";
import { FOLLOWED_BACKERS_SQL } from "@blast/server/modules/social/viewer-state/store.ts";

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
const presaleId = (n: string) => `'0x' || lpad('5a1e' || to_hex(${n}), 64, '0')`;
const accountId = (n: string) => `('00000000-0000-4000-8000-' || lpad(to_hex(${n}), 12, '0'))::uuid`;
const wallet = (n: string) => `'0x' || lpad('a11e7' || to_hex(${n}), 64, '0')`;
/** Lifecycle by `n % 10`: 0-1 pending, 2-3 open, 4 funded, 5-8 migrated, 9 cancelled. */
const LIFECYCLE = `(ARRAY['pending','pending','open','open','funded','migrated','migrated','migrated','migrated','cancelled'])[1 + n % 10]`;
const USDC = `'0x' || lpad('dba3', 64, '0') || '::usdc::USDC'`;
/** T-043's excluded test sales: their activity is in the log, their sales are not in `presales`. */
const EXCLUDED = ["0x" + "e1".padStart(64, "0"), "0x" + "e2".padStart(64, "0"), "0x" + "e3".padStart(64, "0")];
const INCOMPLETE = "0x" + "e4".padStart(64, "0");

async function seed() {
  const admin = createPool(URL_, { max: 2 });
  await resetSharedDatabase(admin);
  await admin.query(CHAIN_FIXTURE);
  await migrateDatabase(admin);
  // blast-infra's activity access paths (its `activity_time` is `(timestamp_ms DESC, activity_id)`; the fixture has no generated id).
  await admin.query(`
    CREATE INDEX activity_time ON blast_infra_fixture.activity (timestamp_ms DESC);
    CREATE INDEX activity_actor_time ON blast_infra_fixture.activity (actor, timestamp_ms DESC);
    CREATE INDEX activity_presale_time ON blast_infra_fixture.activity (presale_id, timestamp_ms DESC);
    CREATE INDEX activity_coin_time ON blast_infra_fixture.activity (coin_type, timestamp_ms DESC);`);
  await admin.query(
    `INSERT INTO blast_infra_fixture.presales
     SELECT ${presaleId("n")}, ${presaleId("n")} || '::coin::S' || n, ${USDC},
       'S' || n, 'Sale ' || n, 'https://cdn.blast.fun/s' || n || '.png', 9, 'USDC', 6, l.lifecycle,
       $1::bigint - 10::bigint * ${DAY}, $1::bigint + ${DAY}, 250000000000, 10000000, 25000000000, 250000000000, 100,
       CASE WHEN n % 2 = 0 THEN 'cetus' ELSE 'bluefin' END, NULL, 1
     FROM generate_series(0, ${PRESALES - 1}) n, LATERAL (SELECT ${LIFECYCLE} AS lifecycle) l`,
    [NOW],
  );
  // A sale whose coin metadata has not arrived: in presales, not shown.
  await admin.query(
    `INSERT INTO blast_infra_fixture.presales VALUES ($1, $1 || '::coin::INC', ${USDC}, NULL, NULL, NULL, NULL, 'USDC', 6, 'open',
       $2::bigint - ${DAY}, $2::bigint + ${DAY}, 250000000000, 10000000, NULL, 0, 0, 'cetus', NULL, 1)`,
    [INCOMPLETE, NOW],
  );
  // 1M rows over about 25 days on the started sales: commits, claims, and trades of migrated sales' coins (presale_id NULL).
  for (let start = 0; start < ACTIVITY; start += 200_000) {
    await admin.query(
      `INSERT INTO blast_infra_fixture.activity
       SELECT 100000 + i, abs(hashtext('t' || i)) % 4, 0, 0, $1::bigint - 60000 - (hashint % 5184000000), 'Dg' || i,
         k.kind, CASE WHEN k.kind LIKE 'trade%' THEN 'market' ELSE 'presale' END,
         actor, actor,
         CASE WHEN k.kind LIKE 'trade%' THEN NULL ELSE ${presaleId("pp.sale")} END,
         CASE WHEN k.kind LIKE 'trade%' THEN ${presaleId("pp.sale")} || '::coin::S' || pp.sale END,
         ${USDC},
         CASE WHEN k.kind = 'presale_claim' THEN 0 ELSE (10 + (hashint % 5000))::bigint * 1000000 END,
         CASE WHEN k.kind = 'presale_commit' THEN NULL ELSE (1 + hashint % 90000)::bigint * 1000000000 END,
         CASE WHEN k.kind = 'presale_claim' THEN 0 END,
         CASE WHEN k.kind = 'presale_claim' THEN NULL ELSE 10 + (hashint % 5000) END,
         CASE WHEN k.kind = 'presale_claim' THEN NULL ELSE $1::bigint END,
         NULL, NULL, NULL
       FROM (
         SELECT i, abs(hashtext(i::text)) AS hashint, abs(hashtext('k' || i)) % 100 AS kk,
           2 + (abs(hashtext('p' || i)) % ${PRESALES / 10}) * 10 + abs(hashtext('q' || i)) % 8 AS p0,
           ${wallet(`1 + abs(hashtext('w' || i)) % ${ACCOUNTS}`)} AS actor
         FROM generate_series($2::int, $3::int) i
       ) s,
       LATERAL (SELECT CASE WHEN s.kk < 85 THEN 'presale_commit' WHEN s.kk < 95 THEN 'presale_claim' WHEN s.kk < 98 THEN 'trade_buy' ELSE 'trade_sell' END AS kind) k,
       -- Trades only on migrated sales (n % 10 in 5..8).
       LATERAL (SELECT CASE WHEN k.kind LIKE 'trade%' THEN s.p0 - s.p0 % 10 + 5 + s.p0 % 4 ELSE s.p0 END AS sale) pp`,
      [NOW, start, Math.min(start + 200_000, ACTIVITY) - 1],
    );
    console.log(`activity ${Math.min(start + 200_000, ACTIVITY)}`);
  }
  // The rows the read skips: 1,000 per excluded sale (the newest 1,000 of all are theirs), and 500 on the incomplete sale.
  await admin.query(
    `INSERT INTO blast_infra_fixture.activity
     SELECT 5000000 + i, 0, 0, 0, CASE WHEN i < 1000 THEN $1::bigint - i ELSE $1::bigint - 60000 - (abs(hashtext('x' || i)) % 5184000000) END,
       'Dx' || i, 'presale_commit', 'presale', ${wallet("1 + i % 50")}, ${wallet("1 + i % 50")}, ($2::text[])[1 + i % 3], NULL, ${USDC},
       5000000, NULL, NULL, 5, $1::bigint, NULL, NULL, NULL
     FROM generate_series(0, 2999) i`,
    [NOW, EXCLUDED],
  );
  await admin.query(
    `INSERT INTO blast_infra_fixture.activity
     SELECT 5100000 + i, 0, 0, 0, $1::bigint - 60000 - (abs(hashtext('y' || i)) % 5184000000), 'Dy' || i, 'presale_commit', 'presale',
       ${wallet("1 + i % 50")}, ${wallet("1 + i % 50")}, $2, NULL, ${USDC}, 5000000, NULL, NULL, 5, $1::bigint, NULL, NULL, NULL
     FROM generate_series(0, 499) i`,
    [NOW, INCOMPLETE],
  );
  // Accounts, every one with its wallet linked; nine in ten public and sharing (named).
  await admin.query(
    `INSERT INTO social_accounts (account_id, privy_did, callsign, display_name, privacy, sharing_since, onboarded_at)
     SELECT ${accountId("n")}, 'did:privy:scale-' || n, 'acct_' || n, 'Account ' || n,
       CASE WHEN n % 10 = 1 THEN 'private' ELSE 'public' END, CASE WHEN n % 10 = 1 THEN NULL ELSE now() - interval '400 days' END,
       now() - interval '400 days'
     FROM generate_series(1, ${ACCOUNTS}) n`,
  );
  await admin.query(
    `INSERT INTO social_account_wallets (address, account_id, verified_at)
     SELECT ${wallet("n")}, ${accountId("n")}, now() - interval '400 days' FROM generate_series(1, ${ACCOUNTS}) n`,
  );
  await admin.query(advanceWatermark(6_000_000, 0, "market"));
  await admin.query(advanceWatermark(6_000_000, 0, "presale"));
  await admin.query("VACUUM ANALYZE");
  const counts = await admin.query(`SELECT
    (SELECT count(*) FROM social_accounts) accounts, (SELECT count(*) FROM social_account_wallets) wallets,
    (SELECT count(*) FROM blast_infra_fixture.presales) presales, (SELECT count(*) FROM blast_infra_fixture.activity) activity,
    (SELECT count(*) FROM blast_infra_fixture.activity WHERE kind LIKE 'trade%') trades,
    (SELECT count(*) FROM blast_infra_fixture.activity a WHERE NOT EXISTS (SELECT 1 FROM blast_infra_fixture.presales p WHERE p.presale_id = a.presale_id) AND a.presale_id IS NOT NULL) excluded_rows,
    (SELECT pg_size_pretty(pg_relation_size('blast_infra_fixture.activity_time'))) activity_time_size`);
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

/** The statement one read sends that `pick` names (by default the page statement, the one naming `chain_read_v1.activity`). */
async function capture(
  db: ReadableDatabase,
  run: (db: ReadableDatabase) => Promise<unknown>,
  pick: (text: string) => boolean = (text) => text.includes("FROM chain_read_v1.activity a"),
): Promise<Statement> {
  const statements: Statement[] = [];
  await run({ read: (text, values = []) => { statements.push({ text, values }); return db.read(text, values); } } as ReadableDatabase);
  const page = statements.find((statement) => pick(statement.text));
  if (!page) throw new Error("the statement was not captured");
  return page;
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
  if (/Seq Scan on activity/.test(plans[label]!)) throw new Error(`${label}: a sequential scan of activity`);
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
  const hidden = { nowMs, before: null, hiddenKinds: SOCIAL_FEED_TRADE_KINDS };
  const visible = { nowMs, before: null, hiddenKinds: [] };

  const newest = await readActivityPage(replica, hidden);
  if (newest.events.length !== 30 || newest.next_cursor === null) throw new Error("a full newest page expected");
  const hiddenSales = new Set([...EXCLUDED, INCOMPLETE]);
  if ([newest, await readActivityPage(replica, visible)].some((page) => page.events.some((event) => hiddenSales.has(event.presale_id)))) {
    throw new Error("a hidden sale's row was read");
  }
  console.log(`newest page: ${newest.events.length} rows, ${newest.events.filter((event) => event.actor.type === "account").length} named, next ${newest.next_cursor}`);
  const withTrades = await readActivityPage(replica, visible);
  console.log(`with trades: ${withTrades.events.filter((event) => event.kind.startsWith("trade")).length} trades of 30`);

  const deep = `${nowMs - 20 * DAY}:9999999:9:9:9`;
  const cases: [string, Parameters<typeof readActivityPage>[1]][] = [
    ["newest page, trading hidden (the ticker's every read; the newest 1,000 rows are hidden sales')", hidden],
    ["newest page, trading visible", visible],
    ["the page after the newest (the gap fill's first step)", { ...hidden, before: decodeActivityCursor(newest.next_cursor) }],
    ["a keyset page 20 days back", { ...hidden, before: decodeActivityCursor(deep) }],
  ];
  for (const [label, request] of cases) {
    if ((await readActivityPage(replica, request)).events.length !== 30) throw new Error(`${label}: a full page expected`);
    const statement = await capture(replica, (db) => readActivityPage(db, request));
    timings.push(await explained(replicaPool, `page statement: ${label}`, statement, plans));
    timings.push(await timed(`whole read (watermark, as_of, page): ${label}`, () => readActivityPage(replica, request)));
  }

  const load = fs.readFileSync("/proc/loadavg", "utf8").trim();
  fs.mkdirSync("loadtest/results", { recursive: true });
  fs.writeFileSync("loadtest/results/social-activity-scale-timings.json", JSON.stringify({ at: new Date().toISOString(), runs: RUNS, load, timings }, null, 1));
  fs.writeFileSync("loadtest/results/social-activity-scale-plans.txt",
    Object.entries(plans).map(([label, plan]) => `== ${label}\n${plan}\n`).join("\n"));
  console.log(`host load ${load}`);
  await replicaPool.end();
}

async function benchHappening() {
  const admin = new pg.Pool({ connectionString: URL_, max: 2 });
  const replicaPool = new pg.Pool({ connectionString: urlAs(URL_, "blast_replica"), max: 4 });
  const replica = autocommitReader(replicaPool, "social");
  const timings: Timing[] = [];
  const plans: Record<string, string> = {};
  const problems: string[] = [];
  const nowMs = Date.now();
  const hidden: HappeningRequest = { config: SOCIAL_CONFIG_DEFAULTS, nowMs, hiddenKinds: SOCIAL_FEED_TRADE_KINDS };
  const visible: HappeningRequest = { ...hidden, hiddenKinds: [] };
  const hiddenSales = [...EXCLUDED, INCOMPLETE];

  // What the read must answer, from the fixture table itself with the hidden sales named (not through SHOWN_PRESALES).
  const bounds = (await admin.query<{ presale_ck: string; presale_ms: string; market_ck: string }>(
    `SELECT max(checkpoint_hi_inclusive) FILTER (WHERE pipeline = 'presale')::text AS presale_ck,
       max(timestamp_ms_hi_inclusive) FILTER (WHERE pipeline = 'presale')::text AS presale_ms,
       max(checkpoint_hi_inclusive) FILTER (WHERE pipeline = 'market')::text AS market_ck FROM watermarks`,
  )).rows[0]!;
  const clock = Math.min(nowMs, Number(bounds.presale_ms));
  const lastHour = async (keepHidden: boolean) => (await admin.query<{ wallets: number; usd: string }>(
    `SELECT count(DISTINCT actor)::int AS wallets, coalesce(sum(usd_value), 0)::text AS usd FROM blast_infra_fixture.activity
     WHERE kind = 'presale_commit' AND timestamp_ms >= $1::bigint - ${HAPPENING_LAST_HOUR_MS} AND timestamp_ms <= $1::bigint
       AND checkpoint <= $2::bigint AND ($4 OR presale_id <> ALL($3::text[]))`,
    [clock, bounds.presale_ck, hiddenSales, keepHidden],
  )).rows[0]!;
  const newest = async (kinds: readonly string[]) => (await admin.query<{ id: string }>(
    `SELECT checkpoint || ':' || tx_slot || ':' || event_slot || ':' || part AS id FROM blast_infra_fixture.activity
     WHERE timestamp_ms <= $1::bigint AND kind = ANY($2::text[])
       AND checkpoint <= CASE WHEN kind IN ('presale_commit', 'presale_claim') THEN $3::bigint ELSE $4::bigint END
       AND coalesce(presale_id, split_part(coin_type, '::', 1)) <> ALL($5::text[])
     ORDER BY timestamp_ms DESC, checkpoint DESC, tx_slot DESC, event_slot DESC, part DESC LIMIT ${HAPPENING_TAPE_MAX}`,
    [clock, kinds, bounds.presale_ck, bounds.market_ck, hiddenSales],
  )).rows.map((row) => row.id);
  const [shownHour, everyHour] = await Promise.all([lastHour(false), lastHour(true)]);
  console.log(`last hour: shown sales ${shownHour.wallets} wallets $${toUsd(shownHour.usd)}; with the hidden sales ${everyHour.wallets} wallets $${toUsd(everyHour.usd)}`);
  const hiddenIds = new Set(hiddenSales);
  for (const [label, request, kinds] of [
    ["trading hidden", hidden, [...HAPPENING_TAPE_KINDS]],
    ["trading visible", visible, [...HAPPENING_TAPE_KINDS, "trade_buy", "trade_sell"]],
  ] as const) {
    const body = await readHappening(replica, request);
    const tape = body.tape.map((event) => event.activity_id);
    const leaked = body.tape.filter((event) => event.presale_id === null || hiddenIds.has(event.presale_id) || event.symbol === "");
    console.log(`${label}: tape ${tape.length} rows, ${leaked.length} of hidden or unknown sales; last hour ${body.last_hour.wallets} wallets $${body.last_hour.usd}`);
    if (JSON.stringify(tape) !== JSON.stringify(await newest(kinds))) problems.push(`${label}: the tape is not the ${HAPPENING_TAPE_MAX} newest shown rows (${leaked.length} hidden)`);
    if (body.last_hour.wallets !== shownHour.wallets || body.last_hour.usd !== toUsd(shownHour.usd)) {
      problems.push(`${label}: last hour ${body.last_hour.wallets} wallets $${body.last_hour.usd}, shown sales only ${shownHour.wallets} wallets $${toUsd(shownHour.usd)}`);
    }
  }

  const statements: [string, (text: string) => boolean, HappeningRequest][] = [
    ["tape, trading hidden (Home's every read; the newest 1,000 rows are hidden sales')", (text) => text.includes("LIMIT $5::int"), hidden],
    ["tape, trading visible", (text) => text.includes("LIMIT $5::int"), visible],
    ["last hour (commits of shown sales in the hour before the clock)", (text) => text.includes("count(DISTINCT a.actor)"), hidden],
  ];
  for (const [label, pick, request] of statements) {
    timings.push(await explained(replicaPool, label, await capture(replica, (db) => readHappening(db, request), pick), plans));
  }
  timings.push(await timed("whole happening read (watermark, as_of, last hour, tape, candidates, chips, window, interested)", () => readHappening(replica, hidden)));

  const load = fs.readFileSync("/proc/loadavg", "utf8").trim();
  fs.mkdirSync("loadtest/results", { recursive: true });
  fs.writeFileSync("loadtest/results/social-happening-hidden-scale-timings.json", JSON.stringify({ at: new Date().toISOString(), runs: RUNS, load, timings, problems }, null, 1));
  fs.writeFileSync("loadtest/results/social-happening-hidden-scale-plans.txt",
    Object.entries(plans).map(([label, plan]) => `== ${label}\n${plan}\n`).join("\n"));
  console.log(`host load ${load}`);
  await Promise.all([admin.end(), replicaPool.end()]);
  if (problems.length) throw new Error(`the happening read answered wrongly:\n${problems.join("\n")}`);
}

const WRITE_RUNS = Number(process.env.SCALE_WRITE_RUNS ?? 10);
const account = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
const walletOf = (n: number) => `0x${`a11e7${n.toString(16)}`.padStart(64, "0")}`;
/** An account that committed to the excluded sales (wallets 1 to 50 did; 2 is public and sharing). */
const BACKER = 2;
/** The account whose notifications are read. */
const READER = 3;
/** An account that follows every account that committed to the excluded sales. */
const FOLLOWER = 9_999;

/** What `bench-feed` reads besides R3-57's seed, added as the owner; running it again adds nothing. */
async function feedSetup(admin: pg.Pool, hiddenSales: readonly string[], newestMs: number): Promise<void> {
  await admin.query(
    `INSERT INTO social_follows (follower_account_id, target_kind, target_id, source)
     SELECT ${accountId("f")}, 'account', (${accountId("1 + (f + k * 997) % " + ACCOUNTS)})::text, 'user'
     FROM generate_series(1, ${ACCOUNTS}) f, generate_series(1, 10) k
     UNION ALL
     SELECT ${accountId(String(FOLLOWER))}, 'account', (${accountId("t")})::text, 'user' FROM generate_series(1, 50) t
     ON CONFLICT DO NOTHING`,
  );
  // The backer's theses: on its 20 newest commits to the excluded sales (rocketed, so they would rank first) and its 20 newest shown ones.
  await admin.query(
    `INSERT INTO social_whys (why_id, entry_id, author_account_id, text)
     SELECT gen_random_uuid(), 'a:' || a.activity_id, $1::uuid, 'Bench thesis ' || a.activity_id FROM (
       (SELECT activity_id FROM chain_read_v1.activity WHERE actor = $2 AND kind = 'presale_commit' AND presale_id = ANY($3::text[])
        ORDER BY timestamp_ms DESC LIMIT 20)
       UNION ALL
       (SELECT activity_id FROM chain_read_v1.activity WHERE actor = $2 AND kind = 'presale_commit' AND presale_id <> ALL($3::text[])
        ORDER BY timestamp_ms DESC LIMIT 20)
     ) a
     ON CONFLICT DO NOTHING`,
    [account(BACKER), walletOf(BACKER), hiddenSales],
  );
  await admin.query(
    `INSERT INTO social_reactions (entry_id, account_id, reaction)
     SELECT w.entry_id, ${accountId("n")}, 'rocket' FROM social_whys w, generate_series(100, 104) n
     WHERE w.author_account_id = $1::uuid AND w.presale_id = ANY($2::text[])
     ON CONFLICT DO NOTHING`,
    [account(BACKER), hiddenSales],
  );
  // The reader's notifications: 1,000 unread, the 300 newest of the excluded sales.
  await admin.query(
    `INSERT INTO social_notifications (account_id, kind, source_key, presale_id, occurred_at_ms, data)
     SELECT $1::uuid, 'funded', 'funded:bench-' || n, CASE WHEN n < 300 THEN ($2::text[])[1 + n % 3] ELSE ${presaleId("n % " + PRESALES)} END,
       $3::bigint - n * 60000, '{}'::jsonb
     FROM generate_series(0, 999) n
     ON CONFLICT DO NOTHING`,
    [account(READER), EXCLUDED, newestMs],
  );
  // Backer counters on every commit, rising per sale, as blast-infra stamps them (the seed stamps none), so the steps
  // find crossings and each sale's previous counter in one index step.
  await admin.query(
    `UPDATE blast_infra_fixture.activity a SET participants_after = r.n + 5, total_commitments_after = (r.n + 5) * 10000000::numeric
     FROM (
       SELECT checkpoint, tx_slot, event_slot, part,
         row_number() OVER (PARTITION BY presale_id ORDER BY timestamp_ms, checkpoint, tx_slot, event_slot, part) AS n
       FROM blast_infra_fixture.activity WHERE kind = 'presale_commit'
     ) r
     WHERE (a.checkpoint, a.tx_slot, a.event_slot, a.part) = (r.checkpoint, r.tx_slot, r.event_slot, r.part)
       AND a.participants_after IS DISTINCT FROM r.n + 5`,
  );
  await admin.query("VACUUM blast_infra_fixture.activity");
  await admin.query("ANALYZE social_follows; ANALYZE social_whys; ANALYZE social_reactions; ANALYZE social_notifications; ANALYZE blast_infra_fixture.activity");
}

/**
 * One write statement under EXPLAIN (ANALYZE) inside a transaction that is
 * rolled back. `count` reads `[rows, rows of hidden sales]` of the written
 * table; the first run reports what the statement wrote, in its own
 * transaction.
 */
async function explainedWrite(
  pool: pg.Pool,
  label: string,
  statement: Statement,
  plans: Record<string, string>,
  count: (client: pg.PoolClient) => Promise<readonly [number, number]>,
): Promise<{ timing: Timing; written: readonly [number, number] }> {
  const client = await pool.connect();
  const samples: number[] = [];
  let written: readonly [number, number] = [0, 0];
  try {
    for (let i = 0; i < WRITE_RUNS + 3; i += 1) {
      await client.query("BEGIN");
      const before = i === 0 ? await count(client) : null;
      const { rows } = await client.query<{ "QUERY PLAN": [{ "Planning Time": number; "Execution Time": number }] }>(
        `EXPLAIN (ANALYZE, FORMAT JSON) ${statement.text}`, [...statement.values],
      );
      if (before) {
        const after = await count(client);
        written = [after[0] - before[0], after[1] - before[1]];
      }
      await client.query("ROLLBACK");
      const [plan] = rows[0]!["QUERY PLAN"];
      if (i >= 3) samples.push(plan["Planning Time"] + plan["Execution Time"]);
    }
    await client.query("BEGIN");
    const text = await client.query<{ "QUERY PLAN": string }>(`EXPLAIN (ANALYZE, BUFFERS) ${statement.text}`, [...statement.values]);
    await client.query("ROLLBACK");
    plans[label] = text.rows.map((row) => row["QUERY PLAN"]).join("\n");
  } finally {
    client.release();
  }
  if (/Seq Scan on activity/.test(plans[label]!)) throw new Error(`${label}: a sequential scan of activity`);
  return { timing: summarize(label, samples), written };
}

async function benchFeed() {
  const admin = new pg.Pool({ connectionString: URL_, max: 2 });
  const replicaPool = new pg.Pool({ connectionString: urlAs(URL_, "blast_replica"), max: 4 });
  const webPool = new pg.Pool({ connectionString: urlAs(URL_, "blast_web"), max: 2 });
  const watcherPool = new pg.Pool({ connectionString: urlAs(URL_, "blast_watcher"), max: 2 });
  const replica = autocommitReader(replicaPool, "social");
  const web = autocommitReader(webPool, "social");
  const timings: Timing[] = [];
  const plans: Record<string, string> = {};
  const problems: string[] = [];
  const nowMs = Date.now();
  const config = SOCIAL_CONFIG_DEFAULTS;
  const hiddenSales = [...EXCLUDED, INCOMPLETE];
  const isHidden = (presaleId: string | null) => presaleId !== null && hiddenSales.includes(presaleId);
  const newestMs = Number((await admin.query<{ t: string }>("SELECT max(timestamp_ms)::text AS t FROM blast_infra_fixture.activity")).rows[0]!.t);
  await feedSetup(admin, hiddenSales, newestMs);
  const read = async (label: string, db: ReadableDatabase, pool: pg.Pool, run: (db: ReadableDatabase) => Promise<unknown>, pick: (text: string) => boolean) => {
    timings.push(await explained(pool, label, await capture(db, run, pick), plans));
  };

  // For You: the first page (trades hidden, as production runs), the page after 60, and the "N new posts" count for the last hour.
  const [first, sixty] = await Promise.all([
    forYouEntries(replica, { config, nowMs, limit: 20, hiddenKinds: SOCIAL_FEED_TRADE_KINDS }),
    forYouEntries(replica, { config, nowMs, limit: 60, hiddenKinds: SOCIAL_FEED_TRADE_KINDS }),
  ]);
  const after60 = { rankMs: sixty.at(-1)!.rankMs, entryId: sixty.at(-1)!.entryId };
  const leakedForYou = [...first, ...sixty].filter((entry) => isHidden(entry.presaleId)).length;
  console.log(`For You: first page ${first.length} entries, ${first.filter((entry) => isHidden(entry.presaleId)).length} of hidden sales; ${leakedForYou} hidden in the first 80`);
  if (leakedForYou) problems.push(`For You: ${leakedForYou} entries of hidden sales in the first pages`);
  const scan = (text: string) => text.includes("FROM social_feed_entries e") && text.includes("LIMIT $8");
  const forYou = (before: typeof after60 | null) => (db: ReadableDatabase) => forYouEntries(db, { config, nowMs, limit: 20, before, hiddenKinds: SOCIAL_FEED_TRADE_KINDS });
  await read("For You scan step: first page (the newest 1,000 activity rows are hidden sales', 1,000 by named accounts)", replica, replicaPool, forYou(null), scan);
  timings.push(await timed("For You selection: first page (every scan step)", () => forYou(null)(replica)));
  timings.push(await timed("For You selection: the page after 60", () => forYou(after60)(replica)));
  const fresh = (db: ReadableDatabase) => forYouNewEntries(db, { config, nowMs, sinceMs: newestMs - 3_600_000, max: 50, actors: 3, hiddenKinds: SOCIAL_FEED_TRADE_KINDS });
  console.log(`For You new since an hour before the newest row: ${JSON.stringify(await fresh(replica))}`);
  await read("For You scan step: new count since an hour back", replica, replicaPool, fresh, scan);
  timings.push(await timed("For You new count since an hour back (every scan step)", () => fresh(replica)));

  // A profile: the items, calls and theses of an account that committed to the excluded sales.
  const items = await personEntriesOf(replica, [account(BACKER)], { limit: 20 });
  console.log(`profile items: ${items.length}, ${items.filter((entry) => isHidden(entry.presaleId)).length} of hidden sales`);
  if (items.some((entry) => isHidden(entry.presaleId))) problems.push("profile items: hidden sales' entries");
  await read("profile items (personEntriesOf, newest 20)", replica, replicaPool,
    (db) => personEntriesOf(db, [account(BACKER)], { limit: 20 }), (text) => text.includes("e.actor IN (SELECT o.address"));
  const callsStatement = await capture(replica, (db) => readCalls(db, account(BACKER), nowMs), (text) => text.includes("GROUP BY e.presale_id"));
  const callRows = (await replicaPool.query<{ presale_id: string }>(callsStatement.text, [...callsStatement.values])).rows;
  console.log(`profile calls statement: ${callRows.length} presales, ${callRows.filter((row) => isHidden(row.presale_id)).length} hidden`);
  if (callRows.some((row) => isHidden(row.presale_id))) problems.push("profile calls: a hidden sale takes a place");
  timings.push(await explained(replicaPool, "profile calls (named commits per presale)", callsStatement, plans));
  const theses = await thesisEntriesOf(replica, account(BACKER), { limit: 20, before: null });
  console.log(`theses: ${theses.length}, ${theses.filter((entry) => isHidden(entry.presaleId)).length} of hidden sales`);
  if (theses.some((entry) => isHidden(entry.presaleId))) problems.push("theses: hidden sales' whys");
  await read("profile theses (20, most rockets first; the hidden ones have the rockets)", replica, replicaPool,
    (db) => thesisEntriesOf(db, account(BACKER), { limit: 20, before: null }), (text) => text.includes("FROM social_whys w"));

  // Single entries: a permalink or reaction check of a hidden and a shown commit; the presale-post selection.
  const entryOf = async (hidden: boolean) => (await admin.query<{ id: string }>(
    `SELECT activity_id AS id FROM chain_read_v1.activity WHERE actor = $1 AND kind = 'presale_commit' AND (presale_id = ANY($2::text[])) = $3
     ORDER BY timestamp_ms DESC LIMIT 1`, [walletOf(BACKER), hiddenSales, hidden],
  )).rows[0]!.id;
  const thresholds = { bigCommitUsd: config.big_commit_usd, bigTradeUsd: config.big_trade_usd };
  async function benchEntryVisibility(): Promise<void> {
    for (const hidden of [true, false]) {
      const id = `a:${await entryOf(hidden)}`;
      const visible = await isVisible(replica, id, thresholds);
      console.log(`${hidden ? "hidden" : "shown"} entry ${id}: visible ${visible}`);
      if (visible === hidden) problems.push(`isVisible(${hidden ? "hidden" : "shown"} entry) = ${visible}`);
      await read(`visible entry (permalink), a ${hidden ? "hidden" : "shown"} sale's commit`, replica, replicaPool,
        (db) => visibleEntry(db, id, thresholds), () => true);
      const source = { text: INTENT_STATEMENTS.sourceActivity, values: [id, id.slice(2)] };
      const shown = (await watcherPool.query<{ shown?: boolean; lifecycle: string | null }>(source.text, [...source.values])).rows[0];
      console.log(`intent source of the ${hidden ? "hidden" : "shown"} commit: ${JSON.stringify(shown)}`);
      timings.push(await explained(watcherPool, `intent source read (worker), a ${hidden ? "hidden" : "shown"} sale's commit`, source, plans));
    }
  }
  await benchEntryVisibility();
  const posts = await presalePostEntriesOf(replica, "all", thresholds, { limit: 20 });
  if (posts.some((entry) => isHidden(entry.presaleId))) problems.push("presale posts: hidden sales' entries");
  await read("presale posts of every presale (presalePostEntriesOf, 20)", replica, replicaPool,
    (db) => presalePostEntriesOf(db, "all", thresholds, { limit: 20 }), (text) => text.includes("e.source IN ('lifecycle', 'milestone')"));

  // Viewer state: followed backers of the excluded sales and of a shown sale the backer committed to, for a viewer who
  // follows every account that committed to the excluded sales.
  const backed = (await admin.query<{ presale_id: string }>(
    `SELECT presale_id FROM chain_read_v1.activity WHERE actor = $1 AND kind = 'presale_commit' AND presale_id <> ALL($2::text[])
     ORDER BY timestamp_ms DESC LIMIT 1`, [walletOf(BACKER), hiddenSales],
  )).rows[0]!.presale_id;
  const backers = { text: FOLLOWED_BACKERS_SQL, values: [account(FOLLOWER), [...hiddenSales, backed]] };
  const backerRows = (await webPool.query<{ presale_id: string }>(backers.text, [...backers.values])).rows;
  console.log(`followed backers: ${backerRows.length} faces, ${backerRows.filter((row) => isHidden(row.presale_id)).length} on hidden sales`);
  if (backerRows.some((row) => isHidden(row.presale_id))) problems.push("viewer state: followed backers of a hidden sale");
  timings.push(await explained(webPool, "viewer-state followed backers (three hidden sales and a shown one)", backers, plans));

  // Notifications: the reader's page and unread count (300 newest rows are the excluded sales').
  const [page, unread] = await Promise.all([
    readNotificationItems(web, account(READER), { limit: 30, before: null }, nowMs),
    readUnreadCount(web, account(READER)),
  ]);
  const notified = (href: string) => href.slice("/presale/".length);
  console.log(`notifications: page ${page.items.length}, ${page.items.filter((item) => isHidden(notified(item.href))).length} of hidden sales; unread ${unread}`);
  if (page.items.some((item) => isHidden(notified(item.href)))) problems.push("notifications: hidden sales' rows on the page");
  await read("notifications page (30)", web, webPool, (db) => readNotificationItems(db, account(READER), { limit: 30, before: null }, nowMs),
    (text) => text.includes("FROM social_notifications n") && text.includes("LIMIT $4"));
  await read("notifications unread count (capped)", web, webPool, (db) => readUnreadCount(db, account(READER)), (text) => text.includes("AS unread"));

  // The worker's steps over two batches: the newest 500 commits (the default SOCIAL_NOTIFICATION_BATCH, all of them
  // the excluded sales'), and the newest 1,500 (those and about 500 shown ones). The seed's checkpoints do not follow
  // its times, so a batch is bounded by time alone and runs to the newest commit.
  const batchOf = async (size: number) => {
    const { rows } = await admin.query<{ from_ms: string; n: number; hidden: number }>(
      `SELECT min(timestamp_ms)::text AS from_ms, count(*)::int AS n, count(*) FILTER (WHERE presale_id = ANY($2::text[]))::int AS hidden
       FROM (SELECT timestamp_ms, presale_id FROM blast_infra_fixture.activity WHERE kind = 'presale_commit'
             ORDER BY timestamp_ms DESC LIMIT $1::int) b`,
      [size, hiddenSales],
    );
    return rows[0]!;
  };
  const MAX_POSITION = [9_000_000_000, 2_147_483_647, 2_147_483_647, 2_147_483_647];
  const milestones = [...config.participant_milestones];
  const counted = (table: string) => async (client: pg.PoolClient) => {
    const { rows } = await client.query<{ n: number; hidden: number }>(
      `SELECT count(*)::int AS n, count(*) FILTER (WHERE presale_id = ANY($1::text[]))::int AS hidden FROM ${table}`, [hiddenSales],
    );
    return [rows[0]!.n, rows[0]!.hidden] as const;
  };
  async function benchNotificationWrites(): Promise<void> {
    for (const size of [500, 1_500]) {
      const batch = await batchOf(size);
      const label = `the newest ${batch.n} commits, ${batch.hidden} of hidden sales`;
      console.log(`batch ${label}`);
      const range = [batch.from_ms, 6_000_000, -1, -1, -1, -1, ...MAX_POSITION];
      const writes: [string, Statement, string][] = [
        [`notify follow step (${label})`, { text: NOTIFICATION_STATEMENTS.follow, values: range }, "social_notifications"],
        [`notify fill step (${label})`, { text: NOTIFICATION_STATEMENTS.fill, values: [...range, milestones] }, "social_notifications"],
        [`milestone commits step (${label})`, { text: MILESTONE_STATEMENTS.commits, values: [...range, newestMs, milestones] }, "social_milestones"],
      ];
      for (const [step, statement, table] of writes) {
        const { timing, written } = await explainedWrite(watcherPool, step, statement, plans, counted(table));
        console.log(`  ${step}: wrote ${written[0]} ${table} rows, ${written[1]} of hidden sales`);
        timings.push(timing);
        if (written[1]) problems.push(`${step}: ${written[1]} ${table} rows of hidden sales`);
      }
    }
  }
  await benchNotificationWrites();

  const load = fs.readFileSync("/proc/loadavg", "utf8").trim();
  fs.mkdirSync("loadtest/results", { recursive: true });
  fs.writeFileSync("loadtest/results/social-feed-hidden-scale-timings.json", JSON.stringify({ at: new Date().toISOString(), runs: RUNS, writeRuns: WRITE_RUNS, load, timings, problems }, null, 1));
  fs.writeFileSync("loadtest/results/social-feed-hidden-scale-plans.txt",
    Object.entries(plans).map(([label, plan]) => `== ${label}\n${plan}\n`).join("\n"));
  console.log(`host load ${load}`);
  await Promise.all([admin.end(), replicaPool.end(), webPool.end(), watcherPool.end()]);
  if (problems.length) throw new Error(`hidden sales reached a reader:\n${problems.join("\n")}`);
}

const command = process.argv[2];
if (command === "seed") await seed();
else if (command === "bench") await bench();
else if (command === "bench-happening") await benchHappening();
else if (command === "bench-feed") await benchFeed();
else throw new Error("usage: social-activity-scale.ts seed|bench|bench-happening|bench-feed");
