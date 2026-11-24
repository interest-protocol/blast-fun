// Social feed profile scale evidence (UI-06): seed a launch-scale disposable
// database (10k accounts, 1M activity rows, 100k follows, 200k rockets, the
// positions those commits make) and time the profile page's reads with their
// plans (EXPLAIN ANALYZE, BUFFERS).
//
//   SOCIAL_SCALE_DATABASE_URL=postgresql://postgres:<pw>@127.0.0.1:<port>/<db> \
//     node --no-warnings --import ./scripts/test-tsx-hooks.mjs --experimental-strip-types loadtest/social-profile-scale.ts seed|bench
//
// The database must be a disposable loopback Postgres (seed resets it). bench
// writes loadtest/results/social-profile-scale-timings.json and -plans.txt.
// The data has the shape of UI-02/03's `social-scale.ts` (same accounts,
// activity mix and follows) plus presale positions, presale follows, whys and
// Mission Control members, so both sections' numbers compare.
import fs from "node:fs";

import pg from "pg";

import { migrateDatabase } from "@blast/core/modules/database/migrations.ts";
import { createPool } from "@blast/core/modules/database/pool.ts";
import { CHAIN_FIXTURE, advanceWatermark, resetSharedDatabase, urlAs } from "../../../packages/core/test/fixtures/modules/database/role-fixtures.ts";
import { autocommitReader, withTransaction, type ReadableDatabase } from "@blast/core/modules/database/transaction.ts";
import { SOCIAL_CONFIG_DEFAULTS } from "@blast/core/modules/social/contracts/config.ts";
import { readCalls } from "@blast/server/modules/social/profiles/calls.ts";
import { ensureMemberAccount, readProfile, readProfileItemsPage } from "@blast/server/modules/social/profiles/read.ts";
import { thesisEntriesOf } from "@blast/server/modules/social/profiles/theses.ts";
import { readMePresales, readMutuals } from "@blast/server/modules/social/profiles/viewer.ts";

const URL_ = process.env.SOCIAL_SCALE_DATABASE_URL ?? "";
if (!/^postgres(ql)?:\/\/[^@]+@(127\.0\.0\.1|localhost):\d+\/\w+$/.test(URL_)) {
  throw new Error("SOCIAL_SCALE_DATABASE_URL must name a disposable loopback database (seed resets it).");
}
const NOW = Date.now();
const ACCOUNTS = 10_000, ACTIVITY = 1_000_000, FOLLOWS = 100_000, REACTIONS = 200_000, PRESALES = 60, MEMBERS = 1_000;
const uuid = (n: string) => `('00000000-0000-4000-8000-' || lpad(to_hex(${n}), 12, '0'))::uuid`;

async function seed() {
  const admin = createPool(URL_, { max: 2 });
  await resetSharedDatabase(admin);
  await admin.query(CHAIN_FIXTURE);
  await migrateDatabase(admin);
  // blast-infra's access paths: activity by actor and time (spec AC-148), positions by wallet (asked of blast-infra: T-019's portfolio and this profile's own presales read by wallet).
  await admin.query(`
    CREATE INDEX activity_time ON blast_infra_fixture.activity (timestamp_ms DESC);
    CREATE INDEX activity_actor_time ON blast_infra_fixture.activity (actor, timestamp_ms DESC);
    CREATE INDEX activity_presale_time ON blast_infra_fixture.activity (presale_id, timestamp_ms DESC);
    CREATE INDEX presale_positions_wallet ON blast_infra_fixture.presale_positions (wallet);
    CREATE INDEX vesting_schedules_beneficiary ON blast_infra_fixture.vesting_schedules (beneficiary);`);
  // Presales: 15 open, 10 funded, 25 migrated, 5 cancelled, 5 pending.
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
    `INSERT INTO blast_infra_fixture.prices
     SELECT '0x' || lpad('5a1e' || to_hex(n), 64, '0') || '::coin::S' || n, 0.0005 + n * 0.00001, $1::bigint, 'pool'
     FROM generate_series(25, 49) n`,
    [NOW],
  );
  await admin.query(
    `INSERT INTO social_accounts (account_id, privy_did, callsign, display_name, x_subject, x_handle, privacy, sharing_since, onboarded_at)
     SELECT ${uuid("n")}, 'did:privy:scale-' || n, 'acct_' || n, 'Account ' || n,
       CASE WHEN n % 3 = 0 THEN NULL ELSE 'x-' || n END, 'acct_' || n,
       CASE WHEN n % 10 = 1 THEN 'private' ELSE 'public' END,
       CASE WHEN n % 10 IN (1, 2) THEN NULL ELSE now() - interval '400 days' END,
       CASE WHEN n % 10 = 2 THEN NULL ELSE now() - interval '400 days' END
     FROM generate_series(1, ${ACCOUNTS}) n`,
  );
  await admin.query(
    `INSERT INTO social_account_wallets (address, account_id, verified_at)
     SELECT '0x' || lpad('a11e7' || to_hex(n), 64, '0'), ${uuid("n")}, now() - interval '400 days'
     FROM generate_series(1, ${ACCOUNTS}) n`,
  );
  // Mission Control members: half with an account row, half never opened Blast (the lazy path).
  await admin.query(
    `INSERT INTO mission_control_profiles (profile_id, privy_did, x_subject, sui_address, provider_wallet_reference, callsign,
       display_name, disclosure_version, disclosure_accepted_at)
     SELECT ('00000000-0000-4000-9000-' || lpad(to_hex(n), 12, '0'))::uuid, 'did:privy:member-' || n, 'xm-' || n,
       '0x' || lpad('3e3b' || to_hex(n), 64, '0'), 'wallet-m' || n, 'member_' || n, 'Member ' || n, 'fixture-v1', now()
     FROM generate_series(1, ${MEMBERS}) n`,
  );
  await admin.query(
    `INSERT INTO social_accounts (account_id, profile_id)
     SELECT ('00000000-0000-4000-a000-' || lpad(to_hex(n), 12, '0'))::uuid, ('00000000-0000-4000-9000-' || lpad(to_hex(n), 12, '0'))::uuid
     FROM generate_series(1, ${MEMBERS / 2}) n`,
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
  // The positions those commits make; 70% of trading sales' positions claimed (80% filled).
  await admin.query(
    `INSERT INTO blast_infra_fixture.presale_positions
     SELECT a.presale_id, a.actor, sum(a.quote_amount), max(a.timestamp_ms),
       CASE WHEN p.lifecycle = 'migrated' AND abs(hashtext(a.actor || a.presale_id)) % 10 < 7 THEN 'Cl' || min(a.checkpoint) END,
       CASE WHEN p.lifecycle = 'migrated' AND abs(hashtext(a.actor || a.presale_id)) % 10 < 7 THEN sum(a.quote_amount) * 1600 END,
       CASE WHEN p.lifecycle = 'migrated' AND abs(hashtext(a.actor || a.presale_id)) % 10 < 7 THEN sum(a.quote_amount) / 5 END,
       NULL
     FROM blast_infra_fixture.activity a JOIN blast_infra_fixture.presales p ON p.presale_id = a.presale_id
     WHERE a.kind = 'presale_commit'
     GROUP BY a.presale_id, a.actor, p.lifecycle`,
  );
  // Sale coins held: every claimed position's tokens, still in the wallet; 2,000 vesting schedules.
  await admin.query(
    `INSERT INTO blast_infra_fixture.coin_balances
     SELECT p.sale_token, pp.wallet, pp.claimed_tokens, 1
     FROM blast_infra_fixture.presale_positions pp JOIN blast_infra_fixture.presales p ON p.presale_id = pp.presale_id
     WHERE pp.claimed_tokens > 0`,
  );
  await admin.query(
    `INSERT INTO blast_infra_fixture.vesting_schedules
     SELECT 'vs' || n, '0x' || lpad('5a1e' || to_hex(25 + n % 25), 64, '0'), '0x' || lpad('a11e7' || to_hex(1 + n * 5), 64, '0'),
       400000000000000, 0, $1::bigint - 20::bigint * 86400000, $1::bigint + 160::bigint * 86400000
     FROM generate_series(1, 2000) n`,
    [NOW],
  );
  await admin.query(
    `INSERT INTO social_follows (follower_account_id, target_kind, target_id, source)
     SELECT DISTINCT ON (f, t) ${uuid("f")}, 'account', ${uuid("t")}::text, 'user'
     FROM (SELECT 1 + abs(hashtext('f' || i)) % ${ACCOUNTS} AS f, 1 + abs(hashtext('t' || i)) % ${ACCOUNTS} AS t FROM generate_series(1, ${Math.round(FOLLOWS * 1.02)}) i) s
     WHERE f <> t LIMIT ${FOLLOWS}`,
  );
  await admin.query(
    `INSERT INTO social_follows (follower_account_id, target_kind, target_id, source)
     SELECT DISTINCT ON (f, p) ${uuid("f")}, 'presale', '0x' || lpad('5a1e' || to_hex(p), 64, '0'), 'user'
     FROM (SELECT 1 + abs(hashtext('pf' || i)) % ${ACCOUNTS} AS f, abs(hashtext('pp' || i)) % 60 AS p FROM generate_series(1, 30000) i) s`,
  );
  await admin.query(
    `INSERT INTO social_reactions (entry_id, account_id, reaction)
     SELECT DISTINCT ON (e, a) 'a:' || (100000 + e) || ':0:0:0', ${uuid("a")}, 'rocket'
     FROM (SELECT abs(hashtext('re' || i)) % 20000 AS e, 1 + abs(hashtext('ra' || i)) % ${ACCOUNTS} AS a FROM generate_series(1, ${Math.round(REACTIONS * 1.01)}) i) s
     LIMIT ${REACTIONS}`,
  );
  // Whys by their entries' actors: ~20k, ~2 per sharing account.
  await admin.query(
    `INSERT INTO social_whys (why_id, entry_id, author_account_id, text)
     SELECT gen_random_uuid(), 'a:' || a.checkpoint || ':0:0:0', w.account_id, 'Reason ' || a.checkpoint
     FROM blast_infra_fixture.activity a JOIN social_account_wallets w ON w.address = a.actor
     WHERE a.kind = 'presale_commit' AND a.checkpoint % 50 = 0`,
  );
  await admin.query(advanceWatermark(2_000_000, 0, "market"));
  await admin.query(advanceWatermark(2_000_000, 0, "presale"));
  await admin.query("ANALYZE");
  const counts = await admin.query(`SELECT
    (SELECT count(*) FROM social_accounts) accounts, (SELECT count(*) FROM blast_infra_fixture.activity) activity,
    (SELECT count(*) FROM blast_infra_fixture.presale_positions) positions,
    (SELECT count(*) FROM blast_infra_fixture.coin_balances) coin_balances, (SELECT count(*) FROM blast_infra_fixture.vesting_schedules) vestings,
    (SELECT count(*) FROM social_follows) follows, (SELECT count(*) FROM social_reactions) reactions,
    (SELECT count(*) FROM social_whys) whys`);
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

/** Collects the plan of every statement a read runs. */
function explaining(pool: pg.Pool, db: ReadableDatabase, plans: string[]): ReadableDatabase {
  return {
    read: async (text: string, values?: readonly unknown[]) => {
      const plan = await pool.query<{ "QUERY PLAN": string }>(`EXPLAIN (ANALYZE, BUFFERS) ${text}`, values as unknown[]);
      plans.push(plan.rows.map((row) => row["QUERY PLAN"]).join("\n"));
      return db.read(text, values);
    },
  } as ReadableDatabase;
}

/** The busiest sharing accounts (most named commits), the worst case for calls and theses. */
async function heavyAccounts(pool: pg.Pool): Promise<{ id: string; callsign: string }[]> {
  const { rows } = await pool.query<{ id: string; callsign: string }>(
    `SELECT a.account_id::text AS id, a.callsign FROM social_accounts a
     JOIN social_account_wallets w ON w.account_id = a.account_id
     JOIN blast_infra_fixture.activity x ON x.actor = w.address
     WHERE a.privacy = 'public' AND a.sharing_since IS NOT NULL AND a.callsign IS NOT NULL
     GROUP BY a.account_id ORDER BY count(*) DESC LIMIT 30`,
  );
  return rows;
}

async function bench() {
  const ownerPool = new pg.Pool({ connectionString: URL_, max: 2 });
  const replicaPool = new pg.Pool({ connectionString: urlAs(URL_, "blast_replica"), max: 4 });
  const webPool = new pg.Pool({ connectionString: urlAs(URL_, "blast_web"), max: 4 });
  const replica = autocommitReader(replicaPool, "social");
  const web = autocommitReader(webPool, "social");
  const heavy = await heavyAccounts(ownerPool);
  const pick = (i: number) => heavy[i % heavy.length]!;
  const timings: Timing[] = [];
  const plans: Record<string, string[]> = {};
  const plan = async (label: string, pool: pg.Pool, db: ReadableDatabase, run: (db: ReadableDatabase) => Promise<unknown>) => {
    plans[label] = [];
    await run(explaining(pool, db, plans[label]));
  };
  const config = SOCIAL_CONFIG_DEFAULTS;

  timings.push(await time("profile: identity by callsign (replica)", 30, (i) => readProfile(replica, pick(i).callsign)));
  timings.push(await time("profile: a member's identity (replica)", 30, (i) => readProfile(replica, `member_${1 + (i % 500)}`)));
  timings.push(await time("profile: calls + track record, busiest accounts (replica)", 30, (i) => readCalls(replica, pick(i).id, NOW)));
  timings.push(await time("profile: theses page (20), busiest accounts (replica)", 30, (i) => thesisEntriesOf(replica, pick(i).id, { limit: 20, before: null })));
  timings.push(await time("profile: items page (20), busiest accounts (replica)", 30, (i) =>
    readProfileItemsPage(replica, pick(i).callsign, { config, nowMs: NOW, limit: 20, before: null })));
  timings.push(await time("viewer: mutuals (primary)", 30, (i) => readMutuals(web, pick(i).id, pick(i + 7).callsign)));
  timings.push(await time("viewer: own holdings: positions, watchlist, coins, vestings (primary)", 30, (i) => readMePresales(web, pick(i).id, NOW)));
  timings.push(await time("profile: unknown callsign, member check (primary write path)", 30, (i) =>
    withTransaction(webPool, (transaction) => ensureMemberAccount(transaction.forModule("social"), `nobody_${i}`))));
  timings.push(await time("profile: lazy member account creation (primary)", 30, (i) =>
    withTransaction(webPool, (transaction) => ensureMemberAccount(transaction.forModule("social"), `member_${600 + i}`))));

  await plan("identity", replicaPool, replica, (db) => readProfile(db, pick(0).callsign));
  await plan("calls", replicaPool, replica, (db) => readCalls(db, pick(0).id, NOW));
  await plan("theses", replicaPool, replica, (db) => thesisEntriesOf(db, pick(0).id, { limit: 20, before: null }));
  await plan("mutuals", webPool, web, (db) => readMutuals(db, pick(0).id, pick(7).callsign));
  await plan("me presales", webPool, web, (db) => readMePresales(db, pick(0).id, NOW));

  fs.mkdirSync("loadtest/results", { recursive: true });
  fs.writeFileSync("loadtest/results/social-profile-scale-timings.json", JSON.stringify({ at: new Date().toISOString(), timings }, null, 1));
  fs.writeFileSync(
    "loadtest/results/social-profile-scale-plans.txt",
    Object.entries(plans).map(([label, list]) => `===== ${label}\n${list.join("\n-----\n")}`).join("\n\n"),
  );
  await Promise.all([ownerPool.end(), replicaPool.end(), webPool.end()]);
}

const command = process.argv[2];
if (command === "seed") await seed();
else if (command === "bench") await bench();
else throw new Error("usage: social-profile-scale.ts seed|bench");
