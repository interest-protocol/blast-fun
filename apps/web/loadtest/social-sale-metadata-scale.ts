// R3-24 scale evidence: a sale's public details (social_sale_metadata, 0090) at launch scale. `seed`
// builds a disposable database: 10k accounts each with a wallet, 2,000 sales, 160k positions, 1M
// activity rows over 60 days, 100k follows, details for 1,800 of the sales (every field and a cover;
// pessimistic: nearly every row the join probes exists), 5 edits each (9k edit rows), and 4,000
// vesting schedules over 2,000 beneficiaries. `bench` runs the statements the details add or change
// under EXPLAIN (ANALYZE), planning + execution, SCALE_RUNS times after 3 warm-ups, each against
// the same statement without the details ("before"), and the whole reads as the routes run them:
//
// - the summary statement for a list page (50 sales) and for one sale, as `blast_replica`;
// - the lists (live by ending, ended by recent, 50) and the sale page, whole reads;
// - the portfolio's vesting entry for a beneficiary of 8 schedules, as `blast_web`;
// - the creator's write: the shown-sale probe, the stored row, and the write transaction; and the
//   operator's history of a sale's edits.
//
//   SOCIAL_SCALE_DATABASE_URL=postgresql://postgres:<pw>@127.0.0.1:<port>/<db> \
//     node --no-warnings --import ./scripts/test-tsx-hooks.mjs --experimental-strip-types loadtest/social-sale-metadata-scale.ts seed|bench
//
// `seed-drafts` and `bench-drafts` (R3-25) add Create's drafts to the same database and time them.
//
// The database must be a disposable loopback Postgres (seed resets it). bench writes
// loadtest/results/social-sale-metadata-scale-timings.json and -plans.txt, and fails if any plan
// scans social_sale_metadata or its edits sequentially.
import fs from "node:fs";

import pg from "pg";

import { migrateDatabase } from "@blast/core/modules/database/migrations.ts";
import { createPool } from "@blast/core/modules/database/pool.ts";
import { CHAIN_FIXTURE, advanceWatermark, resetSharedDatabase, urlAs } from "../../../packages/core/test/fixtures/modules/database/role-fixtures.ts";
import { autocommitReader, withTransaction, type ReadableDatabase } from "@blast/core/modules/database/transaction.ts";
import { SOCIAL_CONFIG_DEFAULTS } from "@blast/core/modules/social/contracts/config.ts";
import { readPortfolioVesting } from "@blast/server/modules/social/portfolio/holdings.ts";
import { readPresaleListPage, readPresalePage } from "@blast/server/modules/social/presales/route.ts";
import { readSummaries } from "@blast/server/modules/social/presales/summary.ts";
import { SALE_METADATA_COLUMNS, readShownSaleLifecycle, readStoredSaleMetadata, saleMetadataJoinSql, writeSaleMetadata } from "@blast/server/modules/social/sales/store.ts";

const URL_ = process.env.SOCIAL_SCALE_DATABASE_URL ?? "";
if (!/^postgres(ql)?:\/\/[^@]+@(127\.0\.0\.1|localhost):\d+\/\w+$/.test(URL_)) {
  throw new Error("SOCIAL_SCALE_DATABASE_URL must name a disposable loopback database (seed resets it).");
}
const DAY = 86_400_000;
const NOW = Date.now();
const RUNS = Number(process.env.SCALE_RUNS ?? 50);
const ACCOUNTS = 10_000, PRESALES = 2_000, ACTIVITY = 1_000_000, FOLLOWS = 100_000, POSITIONS_PER_SALE = 100;
const WITH_DETAILS = 1_800, EDITS_PER_SALE = 5, SCHEDULES = 4_000;
const presaleId = (n: string) => `'0x' || lpad('5a1e' || to_hex(${n}), 64, '0')`;
const accountId = (n: string) => `('00000000-0000-4000-8000-' || lpad(to_hex(${n}), 12, '0'))::uuid`;
const walletOf = (n: string) => `'0x' || lpad('a11e7' || to_hex(${n}), 64, '0')`;
/** Lifecycle by `n % 10`: 0-1 pending, 2-3 open, 4 funded, 5-8 migrated, 9 cancelled. */
const LIFECYCLE = `(ARRAY['pending','pending','open','open','funded','migrated','migrated','migrated','migrated','cancelled'])[1 + n % 10]`;

async function seed() {
  const admin = createPool(URL_, { max: 2 });
  await resetSharedDatabase(admin);
  await admin.query(CHAIN_FIXTURE);
  await migrateDatabase(admin);
  // blast-infra's access paths (spec AC-148) and its beneficiary index.
  await admin.query(`
    CREATE INDEX activity_time ON blast_infra_fixture.activity (timestamp_ms DESC);
    CREATE INDEX activity_actor_time ON blast_infra_fixture.activity (actor, timestamp_ms DESC);
    CREATE INDEX activity_presale_time ON blast_infra_fixture.activity (presale_id, timestamp_ms DESC);
    CREATE INDEX activity_coin_time ON blast_infra_fixture.activity (coin_type, timestamp_ms DESC);
    CREATE INDEX vesting_beneficiary ON blast_infra_fixture.vesting_schedules (beneficiary);`);
  await admin.query(
    `INSERT INTO blast_infra_fixture.presales
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
  await admin.query(
    `INSERT INTO blast_infra_fixture.presale_positions
     SELECT p.presale_id, ${walletOf(`1 + (w * 97 + abs(hashtext(p.presale_id))) % ${ACCOUNTS}`)}, 2500000000,
       p.start_ms + w::bigint * 60000,
       CASE WHEN p.lifecycle = 'migrated' THEN 'Claim' || w END, CASE WHEN p.lifecycle = 'migrated' THEN 5000000000000 END,
       CASE WHEN p.lifecycle = 'migrated' THEN 0 END, CASE WHEN p.lifecycle = 'migrated' THEN p.end_ms + 86400000 END
     FROM blast_infra_fixture.presales p CROSS JOIN generate_series(0, ${POSITIONS_PER_SALE - 1}) w
     WHERE p.lifecycle <> 'pending'
     ON CONFLICT DO NOTHING`,
  );
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
           ${walletOf(`1 + abs(hashtext('w' || i)) % ${ACCOUNTS}`)} AS actor
         FROM generate_series($2::int, $3::int) i
       ) s`,
      [NOW, start, Math.min(start + 200_000, ACTIVITY) - 1],
    );
    console.log(`activity ${Math.min(start + 200_000, ACTIVITY)}`);
  }
  // Vesting: 4,000 schedules, two per beneficiary over 2,000 wallets; beneficiary 1 is paid by 8.
  await admin.query(
    `INSERT INTO blast_infra_fixture.vesting_schedules
     SELECT '0x' || lpad('7e57' || to_hex(i), 64, '0'), ${presaleId(`(i * 7) % ${PRESALES}`)}, ${walletOf(`1 + i % 2000`)},
       100000000000, 0, $1::bigint - 30::bigint * ${DAY}, 0, $1::bigint + (30 + i % 300)::bigint * ${DAY}
     FROM generate_series(0, ${SCHEDULES - 1}) i
     UNION ALL
     SELECT '0x' || lpad('7e58' || to_hex(i), 64, '0'), ${presaleId(`(i * 13 + 5) % ${PRESALES}`)}, ${walletOf("1")},
       100000000000, 0, $1::bigint - 30::bigint * ${DAY}, 0, $1::bigint + (40 + i)::bigint * ${DAY}
     FROM generate_series(0, 5) i`,
    [NOW],
  );
  await admin.query(
    `INSERT INTO social_accounts (account_id, privy_did, callsign, display_name, privacy, sharing_since, onboarded_at)
     SELECT ${accountId("n")}, 'did:privy:scale-' || n, 'acct_' || n, 'Account ' || n,
       CASE WHEN n % 10 = 1 THEN 'private' ELSE 'public' END, CASE WHEN n % 10 = 1 THEN NULL ELSE now() - interval '400 days' END,
       now() - interval '400 days'
     FROM generate_series(1, ${ACCOUNTS}) n`,
  );
  await admin.query(
    `INSERT INTO social_account_wallets (address, account_id, kind, verified_at)
     SELECT ${walletOf("n")}, ${accountId("n")}, 'external', now() - interval '400 days' FROM generate_series(1, ${ACCOUNTS}) n`,
  );
  await admin.query(
    `INSERT INTO social_follows (follower_account_id, target_kind, target_id, source)
     SELECT DISTINCT ON (a, p) ${accountId("a")}, 'presale', ${presaleId("p")}, 'user'
     FROM (SELECT 1 + abs(hashtext('fa' || i)) % ${ACCOUNTS} AS a, abs(hashtext('fp' || i)) % ${PRESALES} AS p
           FROM generate_series(1, ${Math.round(FOLLOWS * 1.05)}) i) s
     LIMIT ${FOLLOWS}`,
  );
  // Details for 1,800 sales (every field and a cover), authored by account n, and their edit history.
  await admin.query(
    `INSERT INTO social_sale_metadata (presale_id, tagline, site, x_handle, telegram, docs_url, audit_url, launch_at_ms,
       cover_key, cover_url, cover_width, cover_height, updated_by_account_id, updated_at_ms)
     SELECT ${presaleId("n")}, 'Sale ' || n || ' does one thing well', 'https://sale' || n || '.example', 'sale' || n, 'salechat' || n,
       'https://docs.sale' || n || '.example/intro', 'https://audits.example/sale' || n || '.pdf',
       CASE WHEN n % 10 = 4 THEN $1::bigint + 7::bigint * ${DAY} END,
       'sale-covers/' || ${presaleId("n")} || '/' || md5(n::text) || md5(n::text) || '.webp',
       'https://blob.example/sale-covers/' || n || '.webp', 1536, 512, ${accountId(`1 + n % ${ACCOUNTS}`)}, $1::bigint
     FROM generate_series(0, ${WITH_DETAILS - 1}) n`,
    [NOW],
  );
  await admin.query(
    `INSERT INTO social_sale_metadata_edits (presale_id, account_id, at_ms, before)
     SELECT ${presaleId("n")}, ${accountId(`1 + n % ${ACCOUNTS}`)}, $1::bigint - (${EDITS_PER_SALE} - e)::bigint * 3600000,
       jsonb_build_object('tagline', 'Line ' || e, 'site', NULL, 'x_handle', NULL, 'telegram', NULL, 'docs_url', NULL, 'audit_url', NULL,
         'launch_at_ms', NULL, 'cover_key', NULL, 'cover_url', NULL, 'cover_width', NULL, 'cover_height', NULL)
     FROM generate_series(0, ${WITH_DETAILS - 1}) n CROSS JOIN generate_series(1, ${EDITS_PER_SALE}) e
     ORDER BY n, e`,
    [NOW],
  );
  await admin.query(advanceWatermark(2_000_000, 0, "market"));
  await admin.query(advanceWatermark(2_000_000, 0, "presale"));
  await admin.query("VACUUM ANALYZE");
  const counts = await admin.query(`SELECT
    (SELECT count(*) FROM social_accounts) accounts, (SELECT count(*) FROM blast_infra_fixture.presales) presales,
    (SELECT count(*) FROM blast_infra_fixture.presale_positions) positions, (SELECT count(*) FROM blast_infra_fixture.activity) activity,
    (SELECT count(*) FROM social_follows) follows, (SELECT count(*) FROM social_sale_metadata) details,
    (SELECT count(*) FROM social_sale_metadata_edits) edits, (SELECT count(*) FROM blast_infra_fixture.vesting_schedules) schedules`);
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

async function capture(db: ReadableDatabase, run: (db: ReadableDatabase) => Promise<unknown>): Promise<Statement[]> {
  const statements: Statement[] = [];
  await run({ read: (text, values = []) => { statements.push({ text, values }); return db.read(text, values); } } as ReadableDatabase);
  return statements;
}

const SEQ_SCAN = /Seq Scan on social_sale_metadata/;

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
  if (SEQ_SCAN.test(plans[label]!)) throw new Error(`${label}: a sequential scan of the details`);
  return summarize(label, samples);
}

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

/** The summary statement as it was before R3-24: no details columns, no join. */
function withoutDetails(statement: Statement): Statement {
  const text = statement.text
    .replace(`${SALE_METADATA_COLUMNS("m")},`, "")
    .replace(saleMetadataJoinSql("p.presale_id"), "");
  if (text === statement.text || /social_sale_metadata/.test(text)) throw new Error("the details could not be removed from the summary statement");
  return { text, values: statement.values };
}

async function bench() {
  const replicaPool = new pg.Pool({ connectionString: urlAs(URL_, "blast_replica"), max: 4 });
  const webPool = new pg.Pool({ connectionString: urlAs(URL_, "blast_web"), max: 4 });
  const replica = autocommitReader(replicaPool, "social");
  const web = autocommitReader(webPool, "social");
  const timings: Timing[] = [];
  const plans: Record<string, string> = {};
  const nowMs = Date.now();

  // A list page's 50 sales (every one with details) and one sale.
  const ids = (await replicaPool.query<{ presale_id: string }>(
    "SELECT presale_id FROM social_sale_metadata ORDER BY presale_id LIMIT 50",
  )).rows.map((row) => row.presale_id);
  const [page] = await capture(replica, (db) => readSummaries(db, ids));
  timings.push(await explained(replicaPool, "summary statement, 50 sales: before (no details)", withoutDetails(page!), plans));
  timings.push(await explained(replicaPool, "summary statement, 50 sales: after (details joined)", page!, plans));
  const [one] = await capture(replica, (db) => readSummaries(db, [ids[7]!]));
  timings.push(await explained(replicaPool, "summary statement, 1 sale: before (no details)", withoutDetails(one!), plans));
  timings.push(await explained(replicaPool, "summary statement, 1 sale: after (details joined)", one!, plans));
  const rows = await readSummaries(replica, ids);
  if (rows.length !== 50 || rows.some((row) => row.tagline === null || row.cover_url === null)) throw new Error("50 rows with details expected");

  for (const [status, sort] of [["live", "ending"], ["ended", "recent"], ["upcoming", "opening"]] as const) {
    // react-doctor-disable-next-line react-doctor/async-await-in-loop -- Measure benchmark cases and warm-up samples serially; overlapping queries would contaminate their latency.
    timings.push(await timed(`list ${status} by ${sort}, 50 (whole read, wall)`, () =>
      readPresaleListPage(replica, { status, sort, cursor: null, limit: 50 }, nowMs)));
  }
  timings.push(await timed("sale page (whole read, wall)", () =>
    readPresalePage(replica, ids[7]!, { nowMs, config: SOCIAL_CONFIG_DEFAULTS, terms: async () => null })));

  // The portfolio's vesting entry for the beneficiary of 8 schedules, as the web runtime on the primary.
  const beneficiary = [`0x${"a11e71".padStart(64, "0")}`];
  const [vesting] = await capture(web, (db) => readPortfolioVesting(db, beneficiary));
  timings.push(await explained(webPool, "portfolio vesting entry: has_schedule + website (8 schedules)", vesting!, plans));
  timings.push(await explained(webPool, "portfolio vesting entry: before (has_schedule only)", {
    text: "SELECT EXISTS (SELECT 1 FROM chain_read_v1.vesting_schedules WHERE beneficiary = ANY($1::text[])) AS has_schedule",
    values: [beneficiary],
  }, plans));

  // The creator's write path and the operator's history.
  const sale = ids[9]!;
  const [lifecycle] = await capture(web, (db) => readShownSaleLifecycle(db, sale));
  timings.push(await explained(webPool, "write: the shown-sale probe", lifecycle!, plans));
  const [stored] = await capture(web, (db) => readStoredSaleMetadata(db, sale));
  timings.push(await explained(webPool, "write: the stored row", stored!, plans));
  let n = 0;
  timings.push(await timed("write: one changed edit (lock, read, edit row, upsert; wall)", () =>
    withTransaction(webPool, (transaction) =>
      writeSaleMetadata(transaction.forModule("social"), sale, { tagline: `Bench line ${n++}` }, { accountId: "00000000-0000-4000-8000-000000000001" }))));
  timings.push(await explained(webPool, "operator history: a sale's latest 50 edits", {
    text: "SELECT edit_id::text, account_id::text, operator_id, at_ms::text, before FROM social_sale_metadata_edits WHERE presale_id = $1 ORDER BY edit_id DESC LIMIT $2",
    values: [sale, 50],
  }, plans));

  const load = fs.readFileSync("/proc/loadavg", "utf8").trim();
  fs.mkdirSync("loadtest/results", { recursive: true });
  fs.writeFileSync("loadtest/results/social-sale-metadata-scale-timings.json", JSON.stringify({ at: new Date().toISOString(), runs: RUNS, load, timings }, null, 1));
  fs.writeFileSync("loadtest/results/social-sale-metadata-scale-plans.txt",
    Object.entries(plans).map(([label, plan]) => `== ${label}\n${plan}\n`).join("\n"));
  console.log(`host load ${load}`);
  await Promise.all([replicaPool.end(), webPool.end()]);
}

// R3-25: Create's drafts at launch scale over the same database: 25,000 drafts over the 10k accounts
// (each with the checked links, a fifth with a cover), 1,800 of them published as the sales with
// details. `bench-drafts` runs, as `blast_web`, the statements R3-25 adds: the published sale's
// lookup (the partial unique index), the draft's row under its lock, and the cover's update.
const DRAFTS = 25_000;

async function seedDrafts() {
  const admin = createPool(URL_, { max: 2 });
  // 0091 on a database `seed` built before it.
  await migrateDatabase(admin);
  await admin.query(
    `INSERT INTO social_presale_drafts (draft_id, account_id, version, body, quote_type, site, x_handle, telegram, docs_url, audit_url,
       cover_key, cover_url, cover_width, cover_height, published_presale_id, published_at)
     SELECT ('00000000-0000-4000-9000-' || lpad(to_hex(n), 12, '0'))::uuid, ${accountId(`1 + n % ${ACCOUNTS}`)}, 1,
       jsonb_build_object('name', 'Draft ' || n, 'symbol', 'D' || n % 1000, 'target', 250000),
       '0x' || lpad('dba3', 64, '0') || '::usdc::USDC', 'https://draft' || n || '.example', 'draft' || n % 100000, 'draftchat' || n,
       NULL, NULL,
       CASE WHEN n % 5 = 0 THEN 'draft-covers/' || ('00000000-0000-4000-9000-' || lpad(to_hex(n), 12, '0')) || '/' || md5(n::text) || md5(n::text) || '.webp' END,
       CASE WHEN n % 5 = 0 THEN 'https://blob.example/d' || n || '.webp' END,
       CASE WHEN n % 5 = 0 THEN 1536 END, CASE WHEN n % 5 = 0 THEN 512 END,
       CASE WHEN n < ${WITH_DETAILS} THEN ${presaleId("n")} END, CASE WHEN n < ${WITH_DETAILS} THEN now() END
     FROM generate_series(0, ${DRAFTS - 1}) n`,
  );
  await admin.query("VACUUM ANALYZE social_presale_drafts");
  console.log((await admin.query("SELECT count(*) drafts, count(published_presale_id) published, count(cover_key) covers FROM social_presale_drafts")).rows[0]);
  await admin.end();
}

async function benchDrafts() {
  const webPool = new pg.Pool({ connectionString: urlAs(URL_, "blast_web"), max: 4 });
  const timings: Timing[] = [];
  const plans: Record<string, string> = {};
  // Draft 25 (hex 19) belongs to account 26 (hex 1a).
  const draft = "00000000-0000-4000-9000-000000000019";
  const owner = "00000000-0000-4000-8000-00000000001a";
  timings.push(await explained(webPool, "published: is the sale another draft's (partial unique index)", {
    text: "SELECT draft_id::text FROM social_presale_drafts WHERE published_presale_id = $1",
    values: [`0x${"5a1e7".padStart(64, "0")}`],
  }, plans));
  timings.push(await explained(webPool, "cover and published: the draft's row (primary key)", {
    text: `SELECT draft_id::text, version, body, logo_url, cover_key, cover_url, cover_width, cover_height, published_presale_id, allowlist
      FROM social_presale_drafts WHERE draft_id = $1 AND account_id = $2`,
    values: [draft, owner],
  }, plans));
  if (/Seq Scan on social_presale_drafts/.test(Object.values(plans).join("\n"))) throw new Error("a sequential scan of the drafts");
  const load = fs.readFileSync("/proc/loadavg", "utf8").trim();
  fs.mkdirSync("loadtest/results", { recursive: true });
  fs.writeFileSync("loadtest/results/social-create-details-scale-timings.json", JSON.stringify({ at: new Date().toISOString(), runs: RUNS, load, timings }, null, 1));
  fs.writeFileSync("loadtest/results/social-create-details-scale-plans.txt",
    Object.entries(plans).map(([label, plan]) => `== ${label}\n${plan}\n`).join("\n"));
  console.log(`host load ${load}`);
  await webPool.end();
}

const command = process.argv[2];
if (command === "seed") await seed();
else if (command === "bench") await bench();
else if (command === "seed-drafts") await seedDrafts();
else if (command === "bench-drafts") await benchDrafts();
else throw new Error("usage: social-sale-metadata-scale.ts seed|bench|seed-drafts|bench-drafts");
