// Social feed scale evidence (UI-02/03): seed a launch-scale disposable
// database (10k accounts, 1M activity rows, 100k follows, 200k rockets) and
// time the feed's reads and writes with their plans.
//
//   SOCIAL_SCALE_DATABASE_URL=postgresql://postgres:<pw>@127.0.0.1:<port>/<db> \
//     node --no-warnings --experimental-strip-types loadtest/social-scale.ts seed|bench
//
// The database must be a disposable loopback Postgres (seed resets it). bench
// writes loadtest/results/social-scale-timings.json and -plans.txt; the same
// database serves `loadtest/scenarios/social-feed.js` through `next start`.
import fs from "node:fs";

import pg from "pg";

import { migrateDatabase } from "@blast/core/modules/database/migrations.ts";
import { createPool } from "@blast/core/modules/database/pool.ts";
import { CHAIN_FIXTURE, advanceWatermark, resetSharedDatabase, urlAs } from "../../../packages/core/test/fixtures/modules/database/role-fixtures.ts";
import { autocommitReader, type ReadableDatabase } from "@blast/core/modules/database/transaction.ts";
import { SOCIAL_CONFIG_DEFAULTS } from "@blast/core/modules/social/contracts/config.ts";
import { SOCIAL_FEED_TRADE_KINDS } from "@blast/core/modules/social/contracts/feed.ts";
import { forYouEntries, forYouNewEntries } from "@blast/server/modules/social/feed/for-you.ts";
import { readForYouPage, readForYouNew } from "@blast/server/modules/social/feed/feed-reader.ts";
import { readItemLookups } from "@blast/server/modules/social/items/mapper.ts";
import { readPost } from "@blast/server/modules/social/posts/read.ts";
import { isVisible, visibleEntry } from "@blast/core/modules/social/read-model/entries.ts";

const URL_ = process.env.SOCIAL_SCALE_DATABASE_URL ?? "";
if (!/^postgres(ql)?:\/\/[^@]+@(127\.0\.0\.1|localhost):\d+\/\w+$/.test(URL_)) {
  throw new Error("SOCIAL_SCALE_DATABASE_URL must name a disposable loopback database (seed resets it).");
}
const DAY = 86_400_000;
const NOW = Date.now();
const ACCOUNTS = 10_000, ACTIVITY = 1_000_000, FOLLOWS = 100_000, REACTIONS = 200_000, PRESALES = 60;
const config = SOCIAL_CONFIG_DEFAULTS;


async function seed() {
  const admin = createPool(URL_, { max: 2 });
  await resetSharedDatabase(admin);
  await admin.query(CHAIN_FIXTURE);
  await migrateDatabase(admin);
  // blast-infra's activity access paths (spec AC-148: by actor set and time, by presale and time, by coin and time, by time).
  await admin.query(`
    CREATE INDEX activity_time ON blast_infra_fixture.activity (timestamp_ms DESC);
    CREATE INDEX activity_actor_time ON blast_infra_fixture.activity (actor, timestamp_ms DESC);
    CREATE INDEX activity_presale_time ON blast_infra_fixture.activity (presale_id, timestamp_ms DESC);
    CREATE INDEX activity_coin_time ON blast_infra_fixture.activity (coin_type, timestamp_ms DESC);
    -- Asked of blast-infra (UI-02 record): a presale's commits as an index-only scan for the backers read.
    CREATE INDEX activity_presale_kind_cover ON blast_infra_fixture.activity (presale_id, kind) INCLUDE (actor, usd_value, timestamp_ms);`);
  // Presales: 15 open, 10 funded, 25 migrated (10 recently), 5 cancelled, 5 pending.
  await admin.query(
    `INSERT INTO blast_infra_fixture.presales
     SELECT '0x' || lpad('5a1e' || to_hex(n), 64, '0'), '0x' || lpad('5a1e' || to_hex(n), 64, '0') || '::coin::S' || n,
       '0x' || lpad('dba3', 64, '0') || '::usdc::USDC', 'S' || n, 'Sale ' || n, 'https://cdn.blast.fun/s' || n || '.png', 9, 'USDC', 6,
       (ARRAY['open','funded','migrated','cancelled','pending'])[CASE WHEN n < 15 THEN 1 WHEN n < 25 THEN 2 WHEN n < 50 THEN 3 WHEN n < 55 THEN 4 ELSE 5 END],
       $1::bigint - 20 * 86400000, $1::bigint + (CASE WHEN n < 15 THEN 3 ELSE -2 END) * 86400000,
       250000000000, 10000000, 25000000000, 300000000000, 2000, CASE WHEN n % 2 = 0 THEN 'cetus' ELSE 'bluefin' END, NULL, 1
     FROM generate_series(0, ${PRESALES - 1}) n`,
    [NOW],
  );
  await admin.query(
    `INSERT INTO blast_infra_fixture.presale_lifecycle
     SELECT '0x' || lpad('5a1e' || to_hex(n), 64, '0'), s.state, 'Life' || n || s.state, $1::bigint - (n % 12) * 86400000 - s.k * 3600000, 1
     FROM generate_series(0, ${PRESALES - 1}) n
     CROSS JOIN LATERAL (VALUES ('opened', 3), ('funded', 2), ('migrated', 1), ('cancelled', 0)) s(state, k)
     WHERE (s.state = 'opened' AND n < 55) OR (s.state = 'funded' AND n BETWEEN 15 AND 49) OR (s.state = 'migrated' AND n BETWEEN 25 AND 49)
       OR (s.state = 'cancelled' AND n BETWEEN 50 AND 54)`,
    [NOW],
  );
  await admin.query(
    `INSERT INTO blast_infra_fixture.prices
     SELECT '0x' || lpad('5a1e' || to_hex(n), 64, '0') || '::coin::S' || n, 0.0005 + n * 0.00001, $1::bigint, 'pool'
     FROM generate_series(25, 49) n
     UNION ALL SELECT '0x' || lpad('dba3', 64, '0') || '::usdc::USDC', 1, $1::bigint, 'pyth'`,
    [NOW],
  );
  // Accounts: 10k; 80% public and sharing for a year, 10% private, 10% never onboarded; one wallet each.
  await admin.query(
    `INSERT INTO social_accounts (account_id, privy_did, callsign, display_name, x_subject, x_handle, privacy, sharing_since, onboarded_at)
     SELECT ('00000000-0000-4000-8000-' || lpad(to_hex(n), 12, '0'))::uuid, 'did:privy:scale-' || n, 'acct_' || n, 'Account ' || n,
       CASE WHEN n % 3 = 0 THEN NULL ELSE 'x-' || n END, 'acct_' || n,
       CASE WHEN n % 10 = 1 THEN 'private' ELSE 'public' END,
       CASE WHEN n % 10 IN (1, 2) THEN NULL ELSE now() - interval '400 days' END,
       CASE WHEN n % 10 = 2 THEN NULL ELSE now() - interval '400 days' END
     FROM generate_series(1, ${ACCOUNTS}) n`,
  );
  await admin.query(
    `INSERT INTO social_account_wallets (address, account_id, verified_at)
     SELECT '0x' || lpad('a11e7' || to_hex(n), 64, '0'), ('00000000-0000-4000-8000-' || lpad(to_hex(n), 12, '0'))::uuid, now() - interval '400 days'
     FROM generate_series(1, ${ACCOUNTS}) n`,
  );
  // 1M activity rows over 60 days: 70% by account wallets, 30% by 50k unowned wallets; 85% commits, 10% claims, 5% trades.
  for (let start = 0; start < ACTIVITY; start += 200_000) {
    await admin.query(
      `INSERT INTO blast_infra_fixture.activity
       SELECT 100000 + i, 0, 0, 0, $1::bigint - (hashint % 5184000000), 'Dg' || i,
         CASE WHEN k < 85 THEN 'presale_commit' WHEN k < 95 THEN 'presale_claim' WHEN k < 98 THEN 'trade_buy' ELSE 'trade_sell' END,
         CASE WHEN k < 95 THEN 'presale' ELSE 'market' END,
         actor, actor, '0x' || lpad('5a1e' || to_hex(p), 64, '0'), NULL, '0x' || lpad('dba3', 64, '0') || '::usdc::USDC',
         (10 + (hashint % 5000))::bigint * 1000000, CASE WHEN k >= 85 AND k < 95 THEN 1000000000000 ELSE NULL END, CASE WHEN k >= 85 AND k < 95 THEN 0 ELSE NULL END,
         CASE WHEN k >= 85 AND k < 95 THEN NULL ELSE 10 + (hashint % 5000) END, $1::bigint, NULL, NULL, NULL
       FROM (
         SELECT i, abs(hashtext(i::text)) AS hashint, abs(hashtext('k' || i)) % 100 AS k, abs(hashtext('p' || i)) % 55 AS p,
           CASE WHEN abs(hashtext('a' || i)) % 10 < 7
             THEN '0x' || lpad('a11e7' || to_hex(1 + abs(hashtext('w' || i)) % ${ACCOUNTS}), 64, '0')
             ELSE '0x' || lpad('b0b' || to_hex(abs(hashtext('u' || i)) % 50000), 64, '0') END AS actor
         FROM generate_series($2::int, $3::int) i
       ) s`,
      [NOW, start, Math.min(start + 200_000, ACTIVITY) - 1],
    );
    console.log(`activity ${Math.min(start + 200_000, ACTIVITY)}`);
  }
  // 100k follows (10 per account on average), 200k rockets on recent activity, whys, attributions, milestones.
  await admin.query(
    `INSERT INTO social_follows (follower_account_id, target_kind, target_id, source)
     SELECT DISTINCT ON (f, t) ('00000000-0000-4000-8000-' || lpad(to_hex(f), 12, '0'))::uuid, 'account',
       ('00000000-0000-4000-8000-' || lpad(to_hex(t), 12, '0'))::uuid::text, 'user'
     FROM (SELECT 1 + abs(hashtext('f' || i)) % ${ACCOUNTS} AS f, 1 + abs(hashtext('t' || i)) % ${ACCOUNTS} AS t FROM generate_series(1, ${Math.round(FOLLOWS * 1.02)}) i) s
     WHERE f <> t LIMIT ${FOLLOWS}`,
  );
  await admin.query(
    `INSERT INTO social_reactions (entry_id, account_id, reaction)
     SELECT DISTINCT ON (e, a) 'a:' || (100000 + e) || ':0:0:0', ('00000000-0000-4000-8000-' || lpad(to_hex(a), 12, '0'))::uuid, 'rocket'
     FROM (SELECT abs(hashtext('re' || i)) % 20000 AS e, 1 + abs(hashtext('ra' || i)) % ${ACCOUNTS} AS a FROM generate_series(1, ${Math.round(REACTIONS * 1.01)}) i) s
     LIMIT ${REACTIONS}`,
  );
  await admin.query(
    `INSERT INTO social_whys (why_id, entry_id, author_account_id, text)
     SELECT gen_random_uuid(), 'a:' || (100000 + i * 37) || ':0:0:0', ('00000000-0000-4000-8000-' || lpad(to_hex(1 + i % ${ACCOUNTS}), 12, '0'))::uuid, 'Reason ' || i
     FROM generate_series(1, 5000) i`,
  );
  await admin.query(
    `INSERT INTO social_attributions (tx_digest, entry_id, author_account_id, actor_account_id, action, presale_id, quote_amount, usd_value, occurred_at_ms)
     SELECT 'At' || i, 'a:' || (100000 + abs(hashtext('at' || i)) % 20000) || ':0:0:0', NULL,
       ('00000000-0000-4000-8000-' || lpad(to_hex(1 + i % ${ACCOUNTS}), 12, '0'))::uuid, 'commit', '0x' || lpad('5a1e1', 64, '0'), 1000000, 1, $1::bigint
     FROM generate_series(1, 20000) i`,
    [NOW],
  );
  await admin.query(
    `INSERT INTO social_milestones (entry_id, presale_id, kind, value, timestamp_ms)
     SELECT 'm:' || p || ':participants:' || v, p, 'participants', v, $1::bigint - abs(hashtext(p || v)) % 2592000000
     FROM (SELECT '0x' || lpad('5a1e' || to_hex(n), 64, '0') AS p FROM generate_series(0, 54) n) ps
     CROSS JOIN unnest(ARRAY[10, 50, 100, 250, 500, 1000, 2500]) v`,
    [NOW],
  );
  await admin.query(advanceWatermark(2_000_000, 0, "market"));
  await admin.query(advanceWatermark(2_000_000, 0, "presale"));
  await admin.query("ANALYZE");
  const counts = await admin.query(`SELECT
    (SELECT count(*) FROM social_accounts) accounts, (SELECT count(*) FROM blast_infra_fixture.activity) activity,
    (SELECT count(*) FROM social_follows) follows, (SELECT count(*) FROM social_reactions) reactions,
    (SELECT count(*) FROM social_feed_entries WHERE occurred_at_ms >= ${NOW - 30 * DAY}) in_window`);
  console.log(counts.rows[0]);
  await admin.end();
}

type Timing = { label: string; p50: number; p95: number; max: number; runs: number };

async function time(label: string, runs: number, run: (i: number) => Promise<unknown>): Promise<Timing> {
  const samples: number[] = [];
  for (let i = 0; i < runs + 3; i += 1) {
    const start = performance.now();
    // react-doctor-disable-next-line react-doctor/async-await-in-loop -- Measure benchmark cases and warm-up samples serially; overlapping queries would contaminate their latency.
    await run(i);
    if (i >= 3) samples.push(performance.now() - start);
  }
  samples.sort((a, b) => a - b);
  const at = (q: number) => +samples[Math.min(samples.length - 1, Math.ceil(q * samples.length) - 1)]!.toFixed(1);
  const result = { label, p50: at(0.5), p95: at(0.95), max: +samples.at(-1)!.toFixed(1), runs };
  console.log(JSON.stringify(result));
  return result;
}

/** Collects the plans of every statement a read runs (EXPLAIN goes to the pool: the reader takes SELECT only). */
function explaining(pool: pg.Pool, db: ReadableDatabase, plans: string[]): ReadableDatabase {
  return {
    read: async (text: string, values?: readonly unknown[]) => {
      const plan = await pool.query<{ "QUERY PLAN": string }>(`EXPLAIN (ANALYZE, BUFFERS) ${text}`, values as unknown[]);
      plans.push(plan.rows.map((row) => row["QUERY PLAN"]).join("\n"));
      return db.read(text, values);
    },
  } as ReadableDatabase;
}

async function bench() {
  const replicaPool = new pg.Pool({ connectionString: urlAs(URL_, "blast_replica"), max: 4 });
  const webPool = new pg.Pool({ connectionString: urlAs(URL_, "blast_web"), max: 4 });
  const replica = autocommitReader(replicaPool, "social");
  const web = autocommitReader(webPool, "social");
  const hidden = SOCIAL_FEED_TRADE_KINDS;
  const timings: Timing[] = [];
  const plans: Record<string, string[]> = {};
  const plan = async (label: string, run: (db: ReadableDatabase) => Promise<unknown>) => {
    plans[label] = [];
    await run(explaining(replicaPool, replica, plans[label]));
  };

  // The feed's first page and a deep page.
  timings.push(await time("feed: first page (For You, 20, trades hidden)", 30, () => readForYouPage(replica, { config, nowMs: NOW, limit: 20, before: null, hiddenKinds: hidden })));
  const first = await forYouEntries(replica, { config, nowMs: NOW, limit: 60, hiddenKinds: hidden });
  const cursor = { rankMs: first.at(-1)!.rankMs, entryId: first.at(-1)!.entryId };
  timings.push(await time("feed: page 4 (keyset after 60)", 30, () => readForYouPage(replica, { config, nowMs: NOW, limit: 20, before: cursor, hiddenKinds: hidden })));
  timings.push(await time("feed selection only (forYouEntries, 20)", 30, () => forYouEntries(replica, { config, nowMs: NOW, limit: 20, hiddenKinds: hidden })));
  await plan("feed selection (forYouEntries, 20)", (db) => forYouEntries(db, { config, nowMs: NOW, limit: 20, hiddenKinds: hidden }));
  const entries = await forYouEntries(replica, { config, nowMs: NOW, limit: 20, hiddenKinds: hidden });
  timings.push(await time("item lookups for a page (presales+prices, identities, whys, reactions, through, backers)", 30, () => readItemLookups(replica, entries, config)));
  await plan("item lookups for a page", (db) => readItemLookups(db, entries, config));

  // New-posts count.
  for (const [label, since] of [["5 min", NOW - 5 * 60_000], ["1 hour", NOW - 3_600_000], ["0 (capped at 50)", 0]] as const) {
    // react-doctor-disable-next-line react-doctor/async-await-in-loop -- Measure benchmark cases and warm-up samples serially; overlapping queries would contaminate their latency.
    timings.push(await time(`new count: since ${label}`, 30, () => readForYouNew(replica, { config, nowMs: NOW, sinceMs: since, hiddenKinds: hidden })));
  }
  await plan("new count: since 1 hour", (db) => forYouNewEntries(db, { config, nowMs: NOW, sinceMs: NOW - 3_600_000, max: 50, actors: 3, hiddenKinds: hidden }));

  // Calls and backers: the busiest presale's post.
  const busiest = (await replica.read<{ presale_id: string; n: string }>(
    "SELECT presale_id, count(*) n FROM chain_read_v1.activity WHERE kind = 'presale_commit' GROUP BY 1 ORDER BY 2 DESC LIMIT 1")).rows[0]!;
  const lifecycleEntry = `l:${busiest.presale_id}:opened`;
  timings.push(await time(`post item with backers (presale with ${busiest.n} commits)`, 30, () => readPost(replica, lifecycleEntry, { config, nowMs: NOW, hiddenKinds: hidden })));
  await plan("post item with backers (busiest presale)", (db) => readPost(db, lifecycleEntry, { config, nowMs: NOW, hiddenKinds: hidden }));
  const migratedCommit = (await replica.read<{ entry_id: string }>(
    `SELECT 'a:' || a.activity_id AS entry_id FROM chain_read_v1.activity a JOIN chain_read_v1.presales p USING (presale_id)
     WHERE p.lifecycle = 'migrated' AND a.kind = 'presale_commit' AND a.actor LIKE '0x0000000000000000000000000000000000000000000000000000000a11e7%' LIMIT 1`)).rows[0]!.entry_id;
  timings.push(await time("call item (migrated presale, price and multiple)", 30, () => readPost(replica, migratedCommit, { config, nowMs: NOW, hiddenKinds: [] })));
  timings.push(await time("visible entry (permalink / reaction check)", 50, () => visibleEntry(replica, migratedCommit, { bigCommitUsd: "1000", bigTradeUsd: "1000" })));

  // Reactions: writes and the viewer's read.
  const viewer = "00000000-0000-4000-8000-000000000005";
  const recent = (await replica.read<{ entry_id: string }>("SELECT entry_id FROM social_reactions GROUP BY 1 ORDER BY count(*) DESC LIMIT 20")).rows.map((r) => r.entry_id);
  timings.push(await time("reaction PUT (isVisible + insert, one transaction)", 50, async (i) => {
    const client = await webPool.connect();
    try {
      await client.query("BEGIN");
      await isVisible({ read: (t: string, v?: readonly unknown[]) => client.query(t, v as unknown[]) } as unknown as ReadableDatabase, migratedCommit, { bigCommitUsd: "1000", bigTradeUsd: "1000" });
      await client.query("INSERT INTO social_reactions (entry_id, account_id, reaction) VALUES ($1, $2, 'rocket') ON CONFLICT DO NOTHING", [recent[i % 20], viewer]);
      await client.query("COMMIT");
    } finally {
      client.release();
    }
  }));
  timings.push(await time("reaction DELETE", 50, (i) => webPool.query("DELETE FROM social_reactions WHERE entry_id = $1 AND account_id = $2 AND reaction = 'rocket'", [recent[i % 20], viewer])));
  timings.push(await time("viewer-state reactions read (50 entries)", 50, () => web.read(
    "SELECT entry_id, array_agg(reaction ORDER BY reaction) FROM social_reactions WHERE account_id = $1 AND entry_id = ANY($2::text[]) GROUP BY entry_id",
    [viewer, entries.map((e) => e.entryId)])));
  timings.push(await time("reaction counts for a page (hottest entries)", 50, () => web.read(
    "SELECT entry_id, reaction, count(*)::int FROM social_reactions WHERE entry_id = ANY($1::text[]) AND reaction = ANY($2::text[]) GROUP BY 1, 2",
    [recent, ["rocket"]])));

  // Viewer-state followed backers (the facepile's "people you follow").
  const { FOLLOWED_BACKERS_SQL } = await import("@blast/server/modules/social/viewer-state/store.ts");
  const follower = (await replica.read<{ id: string }>("SELECT follower_account_id::text id FROM social_follows GROUP BY 1 ORDER BY count(*) DESC LIMIT 1")).rows[0]!.id;
  timings.push(await time("viewer-state followed backers (busiest presale, busiest follower)", 30, () => web.read(FOLLOWED_BACKERS_SQL, [follower, [busiest.presale_id]])));
  plans["viewer-state followed backers"] = [];
  await explaining(webPool, web, plans["viewer-state followed backers"]).read(FOLLOWED_BACKERS_SQL, [follower, [busiest.presale_id]]);

  fs.mkdirSync("loadtest/results", { recursive: true });
  fs.writeFileSync("loadtest/results/social-scale-timings.json", JSON.stringify(timings, null, 1));
  fs.writeFileSync("loadtest/results/social-scale-plans.txt", Object.entries(plans).map(([k, v]) => `### ${k}\n${v.join("\n---\n")}`).join("\n\n"));
  await replicaPool.end();
  await webPool.end();
}

if (process.argv[2] === "seed") await seed();
else await bench();
