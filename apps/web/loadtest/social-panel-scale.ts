// R3-53 scale evidence: Blast mode's side panel at launch scale. The panel
// adds **no new query**: every open makes the two reads the sale page already
// makes — `GET /api/social/presales/{id}` (`readPresalePage`) and, signed in,
// `POST /api/social/presales/viewer` `{ presale_ids: [id] }`
// (`readViewerPresales`, after `readAccountAddresses`). Blast mode turns them
// into a hot path (one per card opened), so this measures both, statement by
// statement under EXPLAIN (ANALYZE), and as whole reads.
//
// `seed` builds a disposable database at launch scale — 10k accounts (every
// one with a linked wallet, so every commit is named: pessimistic for the
// naming joins), 2,000 sales, 160k positions, 1M activity rows over 60 days,
// 100k follows (50k account, 50k presale), 5k theses on the busiest sales and
// 50k rockets — plus one heavy viewer who follows 1,000 accounts. `bench`
// runs, as `blast_replica`, the panel's reads for the busiest open sale, the
// busiest funded sale and the busiest migrated sale, SCALE_RUNS times after 3
// warm-ups.
//
//   SOCIAL_SCALE_DATABASE_URL=postgresql://postgres:<pw>@127.0.0.1:<port>/<db> \
//     node --no-warnings --import ./scripts/test-tsx-hooks.mjs --experimental-strip-types loadtest/social-panel-scale.ts seed|bench
//
// The database must be a disposable loopback Postgres (seed resets it). bench
// writes loadtest/results/social-panel-scale-timings.json and -plans.txt.
import fs from "node:fs";

import pg from "pg";

import { migrateDatabase } from "@blast/core/modules/database/migrations.ts";
import { createPool } from "@blast/core/modules/database/pool.ts";
import { CHAIN_FIXTURE, advanceWatermark, resetSharedDatabase, urlAs } from "../../../packages/core/test/fixtures/modules/database/role-fixtures.ts";
import { autocommitReader, type ReadableDatabase } from "@blast/core/modules/database/transaction.ts";
import { SOCIAL_CONFIG_DEFAULTS } from "@blast/core/modules/social/contracts/config.ts";
import { readAccountAddresses } from "@blast/server/modules/social/accounts/read-wallet-addresses.ts";
import { readPresalePage } from "@blast/server/modules/social/presales/route.ts";
import { chainViewsOnly } from "@blast/core/modules/social/presales/sql.ts";
import { readViewerPresales } from "@blast/server/modules/social/presales/viewer.ts";

const URL_ = process.env.SOCIAL_SCALE_DATABASE_URL ?? "";
if (!/^postgres(ql)?:\/\/[^@]+@(127\.0\.0\.1|localhost):\d+\/\w+$/.test(URL_)) {
  throw new Error("SOCIAL_SCALE_DATABASE_URL must name a disposable loopback database (seed resets it).");
}
const DAY = 86_400_000;
const NOW = Date.now();
const RUNS = Number(process.env.SCALE_RUNS ?? 50);
const ACCOUNTS = 10_000, PRESALES = 2_000, ACTIVITY = 1_000_000, POSITIONS_PER_SALE = 100;
const ACCOUNT_FOLLOWS = 50_000, PRESALE_FOLLOWS = 50_000, HEAVY_FOLLOWS = 1_000, THESES = 5_000, ROCKETS = 50_000;
const presaleId = (n: string) => `'0x' || lpad('5a1e' || to_hex(${n}), 64, '0')`;
const accountId = (n: string) => `('00000000-0000-4000-8000-' || lpad(to_hex(${n}), 12, '0'))::uuid`;
const wallet = (n: string) => `'0x' || lpad('a11e7' || to_hex(${n}), 64, '0')`;
/** The viewer the bench reads as: account 1, who follows 1,000 accounts. */
const HEAVY_VIEWER = "00000000-0000-4000-8000-000000000001";
/** Lifecycle by `n % 10`: 0-1 pending (400), 2-3 open (400), 4 funded (200), 5-8 migrated (800), 9 cancelled (200). */
const LIFECYCLE = `(ARRAY['pending','pending','open','open','funded','migrated','migrated','migrated','migrated','cancelled'])[1 + n % 10]`;

async function seed() {
  const admin = createPool(URL_, { max: 2 });
  await resetSharedDatabase(admin);
  await admin.query(CHAIN_FIXTURE);
  await migrateDatabase(admin);
  // blast-infra's activity access paths (spec AC-148), and its primary key.
  await admin.query(`
    CREATE INDEX activity_time ON blast_infra_fixture.activity (timestamp_ms DESC);
    CREATE INDEX activity_actor_time ON blast_infra_fixture.activity (actor, timestamp_ms DESC);
    CREATE INDEX activity_presale_time ON blast_infra_fixture.activity (presale_id, timestamp_ms DESC);
    CREATE INDEX activity_coin_time ON blast_infra_fixture.activity (coin_type, timestamp_ms DESC);`);
  await admin.query(
    `INSERT INTO blast_infra_fixture.presales
     SELECT ${presaleId("n")}, ${presaleId("n")} || '::coin::S' || n, '0x' || lpad('dba3', 64, '0') || '::usdc::USDC',
       'S' || n, 'Sale ' || n, 'https://cdn.blast.fun/s' || n || '.png', 9, 'USDC', 6, l.lifecycle,
       CASE l.lifecycle WHEN 'pending' THEN $1::bigint + (1 + n % 14)::bigint * ${DAY} WHEN 'open' THEN $1::bigint - 60::bigint * ${DAY} ELSE $1::bigint - (10 + n % 300)::bigint * ${DAY} END,
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
  await admin.query(
    `INSERT INTO blast_infra_fixture.presale_positions
     SELECT p.presale_id, ${wallet(`1 + (w * 97 + abs(hashtext(p.presale_id))) % ${ACCOUNTS}`)}, 2500000000,
       p.start_ms + w::bigint * 60000,
       CASE WHEN p.lifecycle = 'migrated' THEN 'Claim' || w END, CASE WHEN p.lifecycle = 'migrated' THEN 5000000000000 END,
       CASE WHEN p.lifecycle = 'migrated' THEN 0 END, CASE WHEN p.lifecycle = 'migrated' THEN p.end_ms + 86400000 END
     FROM blast_infra_fixture.presales p CROSS JOIN generate_series(0, ${POSITIONS_PER_SALE - 1}) w
     WHERE p.lifecycle <> 'pending'
     ON CONFLICT DO NOTHING`,
  );
  // A team schedule on every migrated sale (the Overview's team unlock).
  await admin.query(
    `INSERT INTO blast_infra_fixture.vesting_schedules
     SELECT 'V' || p.presale_id, p.presale_id, '0x' || lpad('7ea', 64, '0'), 200000000000000000, 0, p.end_ms + 172800000, 7776000000, p.end_ms + 172800000 + 31104000000
     FROM blast_infra_fixture.presales p WHERE p.lifecycle = 'migrated'`,
  );
  // 1M activity rows over 60 days on the started sales, each actor a linked wallet.
  for (let start = 0; start < ACTIVITY; start += 200_000) {
    await admin.query(
      `INSERT INTO blast_infra_fixture.activity
       SELECT 100000 + i, 0, 0, 0, $1::bigint - (hashint % 5184000000), 'Dg' || i,
         CASE WHEN k < 90 THEN 'presale_commit' ELSE 'presale_claim' END, 'presale',
         actor, actor, ${presaleId("p")}, NULL, '0x' || lpad('dba3', 64, '0') || '::usdc::USDC',
         (10 + (hashint % 5000))::bigint * 1000000, NULL, NULL, 10 + (hashint % 5000), $1::bigint,
         NULL, (1 + i % 400)::bigint, (10 + (hashint % 5000))::numeric * 1000000 * (1 + i % 300)
       FROM (
         SELECT i, abs(hashtext(i::text)) AS hashint, abs(hashtext('k' || i)) % 100 AS k,
           2 + (abs(hashtext('p' || i)) % ${PRESALES / 10}) * 10 + abs(hashtext('q' || i)) % 8 AS p,
           ${wallet(`1 + abs(hashtext('w' || i)) % ${ACCOUNTS}`)} AS actor
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
  await admin.query(
    `INSERT INTO social_account_wallets (address, account_id, kind, verified_at)
     SELECT ${wallet("n")}, ${accountId("n")}, 'external', now() - interval '400 days' FROM generate_series(1, ${ACCOUNTS}) n`,
  );
  // The heavy viewer follows 1,000 accounts; the rest of the account follows spread over everyone.
  await admin.query(
    `INSERT INTO social_follows (follower_account_id, target_kind, target_id, source)
     SELECT '${HEAVY_VIEWER}'::uuid, 'account', ${accountId("n")}::text, 'user' FROM generate_series(2, ${HEAVY_FOLLOWS + 1}) n`,
  );
  await admin.query(
    `INSERT INTO social_follows (follower_account_id, target_kind, target_id, source)
     SELECT DISTINCT ON (f, t) ${accountId("f")}, 'account', ${accountId("t")}::text, 'user'
     FROM (SELECT 2 + abs(hashtext('f' || i)) % (${ACCOUNTS} - 1) AS f, 1 + abs(hashtext('t' || i)) % ${ACCOUNTS} AS t FROM generate_series(1, ${Math.round(ACCOUNT_FOLLOWS * 1.05)}) i) s
     WHERE f <> t LIMIT ${ACCOUNT_FOLLOWS - HEAVY_FOLLOWS}`,
  );
  await admin.query(
    `INSERT INTO social_follows (follower_account_id, target_kind, target_id, source)
     SELECT DISTINCT ON (a, p) ${accountId("a")}, 'presale', ${presaleId("p")}, 'user'
     FROM (SELECT 1 + abs(hashtext('fa' || i)) % ${ACCOUNTS} AS a, abs(hashtext('fp' || i)) % ${PRESALES} AS p FROM generate_series(1, ${Math.round(PRESALE_FOLLOWS * 1.05)}) i) s
     LIMIT ${PRESALE_FOLLOWS}`,
  );
  // Theses on commits (the trigger files each under its sale), and rockets on them.
  await admin.query(
    `INSERT INTO social_whys (why_id, entry_id, author_account_id, text)
     SELECT gen_random_uuid(), 'a:' || (100000 + a.i) || ':0:0:0', w.account_id, 'Reason ' || a.i
     FROM (SELECT i FROM generate_series(0, ${ACTIVITY - 1}) i WHERE abs(hashtext('k' || i)) % 100 < 90 ORDER BY abs(hashtext('th' || i)) LIMIT ${THESES}) a
     JOIN blast_infra_fixture.activity act ON act.checkpoint = 100000 + a.i
     JOIN social_account_wallets w ON w.address = act.actor`,
  );
  await admin.query(
    `INSERT INTO social_reactions (entry_id, account_id, reaction)
     SELECT DISTINCT ON (e, a) w.entry_id, ${accountId("a")}, 'rocket'
     FROM (SELECT abs(hashtext('re' || i)) % ${THESES} AS e, 1 + abs(hashtext('ra' || i)) % ${ACCOUNTS} AS a FROM generate_series(1, ${Math.round(ROCKETS * 1.02)}) i) s
     JOIN LATERAL (SELECT entry_id FROM social_whys ORDER BY why_id OFFSET s.e LIMIT 1) w ON true
     LIMIT ${ROCKETS}`,
  );
  await admin.query(advanceWatermark(2_000_000, 0, "market"));
  await admin.query(advanceWatermark(2_000_000, 0, "presale"));
  await admin.query("VACUUM ANALYZE");
  const counts = await admin.query(`SELECT
    (SELECT count(*) FROM social_accounts) accounts, (SELECT count(*) FROM social_account_wallets) wallets,
    (SELECT count(*) FROM blast_infra_fixture.presales) presales, (SELECT count(*) FROM blast_infra_fixture.presale_positions) positions,
    (SELECT count(*) FROM blast_infra_fixture.activity) activity, (SELECT count(*) FROM social_follows) follows,
    (SELECT count(*) FROM social_whys) theses, (SELECT count(*) FROM social_reactions) rockets`);
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

/** The statements one read sends, in order. */
async function capture(db: ReadableDatabase, run: (db: ReadableDatabase) => Promise<unknown>): Promise<Statement[]> {
  const statements: Statement[] = [];
  await run({ read: (text, values = []) => { statements.push({ text, values }); return db.read(text, values); } } as ReadableDatabase);
  return statements;
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

/** A short name for a statement, from what it reads. */
function nameOf(statement: Statement, index: number): string {
  const text = statement.text.replace(/\s+/g, " ");
  const from = text.match(/FROM (chain_read_v1\.\w+|social_\w+)/)?.[1] ?? "statement";
  return `${index + 1}. ${from} — ${text.slice(0, 90)}`;
}

async function bench() {
  const replicaPool = new pg.Pool({ connectionString: urlAs(URL_, "blast_replica"), max: 4 });
  const replica = autocommitReader(replicaPool, "social");
  const timings: Timing[] = [];
  const plans: Record<string, string> = {};
  const nowMs = Date.now();
  const options = { nowMs, config: SOCIAL_CONFIG_DEFAULTS, terms: async () => null };

  // The busiest sale of each started lifecycle: the most activity rows, theses and backers one panel reads.
  const busiest = async (lifecycle: string) =>
    (await replicaPool.query<{ presale_id: string; n: string }>(
      `SELECT a.presale_id, count(*) n FROM chain_read_v1.activity a JOIN chain_read_v1.presales p USING (presale_id)
       WHERE p.lifecycle = $1 GROUP BY 1 ORDER BY 2 DESC, 1 LIMIT 1`,
      [lifecycle],
    )).rows[0]!;
  const viewerDb = chainViewsOnly(replica);
  const own = await readAccountAddresses(viewerDb, HEAVY_VIEWER);
  for (const lifecycle of ["open", "funded", "migrated"]) {
    const sale = await busiest(lifecycle);
    const detail = await readPresalePage(replica, sale.presale_id, options);
    if (detail === null) throw new Error(`no detail for ${sale.presale_id}`);
    const viewer = await readViewerPresales(viewerDb, HEAVY_VIEWER, own, [sale.presale_id]);
    console.log(`${lifecycle} ${sale.presale_id.slice(-6)}: ${sale.n} activity rows, ${detail.backers.top.length} top backers, ${detail.theses.length} theses, ${detail.activity.length} activity items, ${detail.raise.points.length} raise points, ${viewer.presales[sale.presale_id]!.following.length} followed backers`);
    timings.push(await timed(`${lifecycle}: GET /api/social/presales/{id} (readPresalePage, whole read, wall)`, () => readPresalePage(replica, sale.presale_id, options)));
    timings.push(await timed(`${lifecycle}: POST /api/social/presales/viewer, one id (whole read, wall)`, async () => {
      await readViewerPresales(viewerDb, HEAVY_VIEWER, await readAccountAddresses(viewerDb, HEAVY_VIEWER), [sale.presale_id]);
    }));
    if (lifecycle !== "open") continue;
    const statements = await capture(replica, (db) => readPresalePage(db, sale.presale_id, options));
    for (const [index, statement] of statements.entries()) {
      timings.push(await explained(replicaPool, `open, detail ${nameOf(statement, index)}`, statement, plans));
    }
    const viewerStatements = await capture(replica, async (db) => {
      const scoped = chainViewsOnly(db);
      await readViewerPresales(scoped, HEAVY_VIEWER, await readAccountAddresses(scoped, HEAVY_VIEWER), [sale.presale_id]);
    });
    for (const [index, statement] of viewerStatements.entries()) {
      timings.push(await explained(replicaPool, `open, viewer ${nameOf(statement, index)}`, statement, plans));
    }
  }

  const load = fs.readFileSync("/proc/loadavg", "utf8").trim();
  fs.mkdirSync("loadtest/results", { recursive: true });
  fs.writeFileSync("loadtest/results/social-panel-scale-timings.json", JSON.stringify({ at: new Date().toISOString(), runs: RUNS, load, timings }, null, 1));
  fs.writeFileSync("loadtest/results/social-panel-scale-plans.txt",
    Object.entries(plans).map(([label, plan]) => `== ${label}\n${plan}\n`).join("\n"));
  console.log(`host load ${load}`);
  await replicaPool.end();
}

const command = process.argv[2];
if (command === "seed") await seed();
else if (command === "bench") await bench();
else throw new Error("usage: social-panel-scale.ts seed|bench");
