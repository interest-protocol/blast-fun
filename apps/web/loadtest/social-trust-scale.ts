// R3-23 scale evidence: a sale's trust flags at launch scale. `seed` builds a
// disposable database: 10k accounts, 2,000 sales (a fifth upcoming), 160k
// positions, 1M activity rows over 60 days, 100k presale follows, and the
// trust flags pessimistically dense — a third of the sales verified, a fifth
// audited, every sale with a trust row (2,000 rows, the table's ceiling; no
// LP-lock flag, OA-26). The operator log holds 100,000 rows: 20,000
// trust changes spread over the sales with 400 on one (the longest history),
// the rest other commands. `bench` runs, under EXPLAIN (ANALYZE), planning +
// execution, SCALE_RUNS times after 3 warm-ups, and the whole reads as the
// routes run them:
//
// - as `blast_replica`: each tab's first sort, unfiltered and with
//   `verified_team=true`, `audited=true` and both (the key statement, where
//   the filter is, and the whole read), a filtered tab's second page (keyset),
//   and the summary statement for 50 sales (where the flags are joined);
// - as the owner (the operator CLI's login): `sale trust list` (first page and
//   a page after a cursor) and `sale trust history` for the sale with the
//   longest history (first page and one after a cursor), each also with
//   `social_operator_log_sale_trust_idx` dropped inside a rolled-back
//   transaction, so the plan that decides the index is recorded beside it.
//
//   SOCIAL_SCALE_DATABASE_URL=postgresql://postgres:<pw>@127.0.0.1:<port>/<db> \
//     node --no-warnings --import ./scripts/test-tsx-hooks.mjs --experimental-strip-types loadtest/social-trust-scale.ts seed|bench
//
// The database must be a disposable loopback Postgres (seed resets it). bench
// writes loadtest/results/social-trust-scale-timings.json and -plans.txt.
import fs from "node:fs";

import pg from "pg";

import { migrateDatabase } from "@blast/core/modules/database/migrations.ts";
import { createPool } from "@blast/core/modules/database/pool.ts";
import { CHAIN_FIXTURE, advanceWatermark, resetSharedDatabase, urlAs } from "../../../packages/core/test/fixtures/modules/database/role-fixtures.ts";
import { autocommitReader, type ReadableDatabase } from "@blast/core/modules/database/transaction.ts";
import { PRESALE_LIST_SORTS, type PresaleListStatus, type PresaleListTrustFilter } from "@blast/core/modules/social/contracts/presales.ts";
import { TRUST_HISTORY_SQL, TRUST_LIST_SQL } from "@blast/server/modules/social/operator/trust.ts";
import { readPresaleListPage } from "@blast/server/modules/social/presales/route.ts";
import { readSummaries } from "@blast/server/modules/social/presales/summary.ts";

const URL_ = process.env.SOCIAL_SCALE_DATABASE_URL ?? "";
if (!/^postgres(ql)?:\/\/[^@]+@(127\.0\.0\.1|localhost):\d+\/\w+$/.test(URL_)) {
  throw new Error("SOCIAL_SCALE_DATABASE_URL must name a disposable loopback database (seed resets it).");
}
const DAY = 86_400_000;
const NOW = Date.now();
const RUNS = Number(process.env.SCALE_RUNS ?? 50);
const ACCOUNTS = 10_000, PRESALES = 2_000, ACTIVITY = 1_000_000, FOLLOWS = 100_000, POSITIONS_PER_SALE = 100;
const LOG_ROWS = 100_000, TRUST_CHANGES = 20_000, HEAVY_HISTORY = 400;
const presaleId = (n: string) => `'0x' || lpad('5a1e' || to_hex(${n}), 64, '0')`;
const accountId = (n: string) => `('00000000-0000-4000-8000-' || lpad(to_hex(${n}), 12, '0'))::uuid`;
/** Lifecycle by `n % 10`: 0-1 pending (400), 2-3 open (400), 4 funded (200), 5-8 migrated (800), 9 cancelled (200). */
const LIFECYCLE = `(ARRAY['pending','pending','open','open','funded','migrated','migrated','migrated','migrated','cancelled'])[1 + n % 10]`;

async function seed() {
  const admin = createPool(URL_, { max: 2 });
  await resetSharedDatabase(admin);
  await admin.query(CHAIN_FIXTURE);
  await migrateDatabase(admin);
  // blast-infra's activity access paths (spec AC-148).
  await admin.query(`
    CREATE INDEX activity_time ON blast_infra_fixture.activity (timestamp_ms DESC);
    CREATE INDEX activity_actor_time ON blast_infra_fixture.activity (actor, timestamp_ms DESC);
    CREATE INDEX activity_presale_time ON blast_infra_fixture.activity (presale_id, timestamp_ms DESC);
    CREATE INDEX activity_coin_time ON blast_infra_fixture.activity (coin_type, timestamp_ms DESC);`);
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
     SELECT p.presale_id, '0x' || lpad('a11e7' || to_hex(1 + (w * 97 + abs(hashtext(p.presale_id))) % ${ACCOUNTS}), 64, '0'), 2500000000,
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
           '0x' || lpad('a11e7' || to_hex(1 + abs(hashtext('w' || i)) % ${ACCOUNTS}), 64, '0') AS actor
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
    `INSERT INTO social_follows (follower_account_id, target_kind, target_id, source)
     SELECT DISTINCT ON (a, p) ${accountId("a")}, 'presale', ${presaleId("p")}, 'user'
     FROM (
       SELECT 1 + abs(hashtext('fa' || i)) % ${ACCOUNTS} AS a, abs(hashtext('fp' || i)) % ${PRESALES} AS p
       FROM generate_series(1, ${Math.round(FOLLOWS * 1.05)}) i
     ) s
     LIMIT ${FOLLOWS}`,
  );
  // The trust rows (the operator's own login writes them): every sale has one, dense flags.
  await admin.query(
    `INSERT INTO social_sale_trust (presale_id, verified_team, audited, verified_by, verified_at_ms, audited_by, audited_at_ms, note, updated_at_ms)
     SELECT ${presaleId("n")}, n % 3 = 0, n % 5 = 0,
       CASE WHEN n % 3 = 0 THEN 'ops.scale' END, CASE WHEN n % 3 = 0 THEN $1::bigint - n * 1000 END,
       CASE WHEN n % 5 = 0 THEN 'ops.scale' END, CASE WHEN n % 5 = 0 THEN $1::bigint - n * 1000 END,
       'scale seed ' || n, $1::bigint - n * 1000
     FROM generate_series(0, ${PRESALES - 1}) n`,
    [NOW],
  );
  // The operator log: trust changes (sale 1 has the longest history), then other commands. It is append-only.
  await admin.query(
    `INSERT INTO social_operator_log (operator_id, action, target, before, after, reason, acted_at)
     SELECT 'ops.scale', CASE WHEN i % 4 = 0 THEN 'sale.trust.clear' ELSE 'sale.trust.set' END,
       CASE WHEN i <= ${HEAVY_HISTORY} THEN ${presaleId("1")} ELSE ${presaleId(`(i % ${PRESALES})`)} END,
       '{"verified_team":false,"audited":false}'::jsonb, '{"verified_team":true,"audited":false}'::jsonb,
       'scale change ' || i, now() - (i || ' minutes')::interval
     FROM generate_series(1, ${TRUST_CHANGES}) i`,
  );
  await admin.query(
    `INSERT INTO social_operator_log (operator_id, action, target, before, after, reason, acted_at)
     SELECT 'ops.scale', (ARRAY['config.get', 'config.set', 'terms.add', 'sale.trust.list', 'sale.trust.history'])[1 + i % 5],
       CASE WHEN i % 5 = 4 THEN ${presaleId("1")} ELSE 'k' || (i % 50) END, NULL, NULL, NULL, now() - (i || ' seconds')::interval
     FROM generate_series(1, ${LOG_ROWS - TRUST_CHANGES}) i`,
  );
  await admin.query(advanceWatermark(2_000_000, 0, "market"));
  await admin.query(advanceWatermark(2_000_000, 0, "presale"));
  await admin.query("VACUUM ANALYZE");
  const counts = await admin.query(`SELECT
    (SELECT count(*) FROM social_accounts) accounts, (SELECT count(*) FROM blast_infra_fixture.presales) presales,
    (SELECT count(*) FROM blast_infra_fixture.presale_positions) positions, (SELECT count(*) FROM blast_infra_fixture.activity) activity,
    (SELECT count(*) FROM social_follows) follows, (SELECT count(*) FROM social_sale_trust) trust_rows,
    (SELECT count(*) FILTER (WHERE verified_team) FROM social_sale_trust) verified, (SELECT count(*) FILTER (WHERE audited) FROM social_sale_trust) audited,
    (SELECT count(*) FROM social_operator_log) log_rows,
    (SELECT count(*) FROM social_operator_log WHERE target = ${presaleId("1")} AND action IN ('sale.trust.set', 'sale.trust.clear')) heavy_history`);
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
type Querier = { query: pg.Pool["query"] };

async function capture(db: ReadableDatabase, run: (db: ReadableDatabase) => Promise<unknown>): Promise<Statement[]> {
  const statements: Statement[] = [];
  await run({ read: (text, values = []) => { statements.push({ text, values }); return db.read(text, values); } } as ReadableDatabase);
  return statements;
}

/** One statement under EXPLAIN (ANALYZE): planning + execution per run (3 warm-ups), and its plan once. */
async function explained(client: Querier, label: string, statement: Statement, plans: Record<string, string>): Promise<Timing> {
  const samples: number[] = [];
  for (let i = 0; i < RUNS + 3; i += 1) {
    const { rows } = await client.query<{ "QUERY PLAN": [{ "Planning Time": number; "Execution Time": number }] }>(
      `EXPLAIN (ANALYZE, FORMAT JSON) ${statement.text}`, [...statement.values],
    );
    const [plan] = rows[0]!["QUERY PLAN"];
    if (i >= 3) samples.push(plan["Planning Time"] + plan["Execution Time"]);
  }
  const text = await client.query<{ "QUERY PLAN": string }>(`EXPLAIN (ANALYZE, BUFFERS) ${statement.text}`, [...statement.values]);
  plans[label] = text.rows.map((row) => row["QUERY PLAN"]).join("\n");
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

const FILTERS: readonly (readonly PresaleListTrustFilter[])[] = [[], ["verified_team"], ["audited"], ["verified_team", "audited"]];
const filterName = (trust: readonly PresaleListTrustFilter[]) => (trust.length === 0 ? "unfiltered" : trust.join("+"));

function checkTrustFlags(page: Awaited<ReturnType<typeof readPresaleListPage>>, status: PresaleListStatus, trust: readonly PresaleListTrustFilter[]): void {
  const requiresVerifiedTeam = trust.includes("verified_team");
  const requiresAudit = trust.includes("audited");
  for (const row of page.presales) {
    if ((requiresVerifiedTeam && !row.verified_team) || (requiresAudit && !row.audited)) {
      throw new Error(`${status} ${filterName(trust)} returned an unflagged sale`);
    }
  }
}

async function benchPresaleList(replica: ReadableDatabase, replicaPool: pg.Pool, timings: Timing[], plans: Record<string, string>, nowMs: number, status: PresaleListStatus, trust: readonly PresaleListTrustFilter[]): Promise<void> {
  const sort = PRESALE_LIST_SORTS[status][0];
  const request = { status, sort, cursor: null, limit: 50, ...(trust.length > 0 ? { trust } : {}) } as const;
  const page = await readPresaleListPage(replica, request, nowMs);
  checkTrustFlags(page, status, trust);
  console.log(`${status} ${sort} ${filterName(trust)}: ${page.presales.length} rows, next ${page.next_cursor ? "yes" : "no"}`);
  // The key statement holds the status and trust conditions and the keyset order.
  const keyStatement = (await capture(replica, (db) => readPresaleListPage(db, request, nowMs))).find((statement) => /ORDER BY r\.sort_key/.test(statement.text));
  if (!keyStatement) throw new Error("key statement not captured");
  timings.push(await explained(replicaPool, `${status} by ${sort}, ${filterName(trust)}: key statement`, keyStatement, plans));
  timings.push(await timed(`${status} by ${sort}, ${filterName(trust)}, 50 (whole read, wall)`, () => readPresaleListPage(replica, request, nowMs)));
  if (trust.length > 0 && page.next_cursor) {
    const second = { ...request, cursor: page.next_cursor };
    const secondKey = (await capture(replica, (db) => readPresaleListPage(db, second, nowMs))).find((statement) => /ORDER BY r\.sort_key/.test(statement.text))!;
    timings.push(await explained(replicaPool, `${status} by ${sort}, ${filterName(trust)}: second page key statement (keyset)`, secondKey, plans));
  }
}

async function benchPresaleLists(replica: ReadableDatabase, replicaPool: pg.Pool, timings: Timing[], plans: Record<string, string>, nowMs: number): Promise<void> {
  for (const status of ["upcoming", "live", "ended"] as const satisfies readonly PresaleListStatus[]) {
    for (const trust of FILTERS) await benchPresaleList(replica, replicaPool, timings, plans, nowMs, status, trust);
  }
}

async function bench() {
  const replicaPool = new pg.Pool({ connectionString: urlAs(URL_, "blast_replica"), max: 4 });
  const owner = new pg.Pool({ connectionString: URL_, max: 2 });
  const replica = autocommitReader(replicaPool, "social");
  const timings: Timing[] = [];
  const plans: Record<string, string> = {};
  const nowMs = Date.now();

  await benchPresaleLists(replica, replicaPool, timings, plans, nowMs);

  // The summary statement (where the flags are joined), for the 50 sales of a page.
  const ids = Array.from({ length: 50 }, (_, n) => `0x${("5a1e" + (n * 37).toString(16)).padStart(64, "0")}`);
  const [summary] = await capture(replica, (db) => readSummaries(db, ids));
  timings.push(await explained(replicaPool, "summary statement, 50 sales (trust flags joined)", summary!, plans));

  // The operator's reads, as the owner login, with and without the history index.
  const heavy = `0x${"5a1e1".padStart(64, "0")}`;
  const listFirst = { text: TRUST_LIST_SQL, values: [null, 51] };
  timings.push(await explained(owner, "operator: sale trust list, first page (51)", listFirst, plans));
  const after = (await owner.query<{ presale_id: string }>(`${TRUST_LIST_SQL}`, [null, 1001])).rows.at(-1)!.presale_id;
  timings.push(await explained(owner, "operator: sale trust list, page after 1,000 (51)", { text: TRUST_LIST_SQL, values: [after, 51] }, plans));
  const historyFirst = { text: TRUST_HISTORY_SQL, values: [heavy, null, 51] };
  const cursor = (await owner.query<{ log_id: string }>(TRUST_HISTORY_SQL, [heavy, null, 201])).rows.at(-1)!.log_id;
  const historyDeep = { text: TRUST_HISTORY_SQL, values: [heavy, cursor, 51] };
  timings.push(await explained(owner, "operator: sale trust history, longest history, first page (51)", historyFirst, plans));
  timings.push(await explained(owner, "operator: sale trust history, longest history, page after 200 (51)", historyDeep, plans));
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query("DROP INDEX social_operator_log_sale_trust_idx");
    timings.push(await explained(client, "operator: sale trust history, first page, WITHOUT the 0088 index", historyFirst, plans));
    timings.push(await explained(client, "operator: sale trust history, page after 200, WITHOUT the 0088 index", historyDeep, plans));
  } finally {
    await client.query("ROLLBACK");
    client.release();
  }

  const load = fs.readFileSync("/proc/loadavg", "utf8").trim();
  fs.mkdirSync("loadtest/results", { recursive: true });
  fs.writeFileSync("loadtest/results/social-trust-scale-timings.json", JSON.stringify({ at: new Date().toISOString(), runs: RUNS, load, timings }, null, 1));
  fs.writeFileSync("loadtest/results/social-trust-scale-plans.txt", Object.entries(plans).map(([label, plan]) => `== ${label}\n${plan}\n`).join("\n"));
  console.log(`host load ${load}`);
  await Promise.all([replicaPool.end(), owner.end()]);
}

const command = process.argv[2];
if (command === "seed") await seed();
else if (command === "bench") await bench();
else throw new Error("usage: social-trust-scale.ts seed|bench");
