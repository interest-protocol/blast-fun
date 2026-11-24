// Social feed milestone scale evidence (T-027, T-029): seed a launch-scale
// disposable database (1M activity rows, 700k of them commits across 200
// presales, with blast-infra's activity indexes, plus 200k holder-history
// rows for those presales' sale coins) and time the milestone steps as the
// watcher login, each run rolled back, with their plans.
//
//   SOCIAL_SCALE_DATABASE_URL=postgresql://postgres:<pw>@127.0.0.1:<port>/<db> \
//     node --no-warnings --experimental-strip-types apps/workers/loadtest/social-milestones-scale.ts seed|bench
//
// The database must be a disposable loopback Postgres (seed resets it). bench
// writes loadtest/results/social-milestones-timings.json and -plans.txt.
import fs from "node:fs";

import pg from "pg";

import { migrateDatabase } from "@blast/core/modules/database/migrations.ts";
import { createPool } from "@blast/core/modules/database/pool.ts";
import { CHAIN_FIXTURE, resetSharedDatabase, urlAs } from "../../../packages/core/test/fixtures/modules/database/role-fixtures.ts";
import { withTransaction } from "@blast/core/modules/database/transaction.ts";
import { SOCIAL_CONFIG_DEFAULTS } from "@blast/core/modules/social/contracts/config.ts";
import { MILESTONE_STATEMENTS, milestoneSteps } from "#workers/modules/social/milestones/generate.ts";
import type { SocialWorkerBounds, SocialWorkerStep } from "#workers/modules/social/worker/steps.ts";

const URL_ = process.env.SOCIAL_SCALE_DATABASE_URL ?? "";
if (!/^postgres(ql)?:\/\/[^@]+@(127\.0\.0\.1|localhost):\d+\/\w+$/.test(URL_)) {
  throw new Error("SOCIAL_SCALE_DATABASE_URL must name a disposable loopback database (seed resets it).");
}
const NOW = Date.now();
const ACTIVITY = 1_000_000, PRESALES = 200, BATCH = 500, HOLDER_ROWS = 200_000;
const SLOT_MAX = 2_147_483_647;

async function seed() {
  const admin = createPool(URL_, { max: 2 });
  await resetSharedDatabase(admin);
  await admin.query(CHAIN_FIXTURE);
  await migrateDatabase(admin);
  // 200 presales: target 2,000 commits of $100 (USDC atoms), so each crosses its target once.
  await admin.query(
    `INSERT INTO blast_infra_fixture.presales
     SELECT '0x' || lpad('5a1e' || to_hex(n), 64, '0'), '0x' || lpad('5a1e' || to_hex(n), 64, '0') || '::coin::S' || n,
       '0x' || lpad('dba3', 64, '0') || '::usdc::USDC', 'S' || n, 'Sale ' || n, 'https://cdn.blast.fun/s' || n || '.png', 9, 'USDC', 6,
       CASE WHEN n < 150 THEN 'open' ELSE 'migrated' END, $1::bigint - 60 * 86400000::bigint, $1::bigint + 3 * 86400000,
       200000000000, 10000000, NULL, 350000000000, 3500, 'cetus', NULL, 1
     FROM generate_series(0, ${PRESALES - 1}) n`,
    [NOW],
  );
  // 1M rows over 60 days, one per checkpoint (time never goes back): 7 in 10 a commit to presale i % 200
  // (140 presales take commits; their k-th brings them to k participants and k × $100), the rest trades and claims.
  await admin.query(
    `INSERT INTO blast_infra_fixture.activity
     SELECT 10000000 + i, 0, 0, 0, $1::bigint - 60 * 86400000::bigint + i::bigint * 5184, 'Dg' || i,
       CASE WHEN i % 10 < 7 THEN 'presale_commit' WHEN i % 10 < 9 THEN 'trade_buy' ELSE 'presale_claim' END,
       CASE WHEN i % 10 = 7 OR i % 10 = 8 THEN 'market' ELSE 'presale' END,
       '0x' || lpad(to_hex(i % 50000), 64, '0'), '0x' || lpad(to_hex(i % 50000), 64, '0'),
       CASE WHEN i % 10 = 7 OR i % 10 = 8 THEN NULL ELSE '0x' || lpad('5a1e' || to_hex(i % ${PRESALES}), 64, '0') END,
       CASE WHEN i % 10 = 7 OR i % 10 = 8 THEN '0x' || lpad('5a1e' || to_hex(i % ${PRESALES}), 64, '0') || '::coin::S' || (i % ${PRESALES}) END,
       '0x' || lpad('dba3', 64, '0') || '::usdc::USDC', 100000000, NULL, NULL, 100, NULL, NULL,
       CASE WHEN i % 10 < 7 THEN i / ${PRESALES} + 1 END, CASE WHEN i % 10 < 7 THEN (i / ${PRESALES} + 1)::numeric * 100000000 END
     FROM generate_series(0, ${ACTIVITY - 1}) i`,
    [NOW],
  );
  // blast-infra's activity access paths (T-033 / AC-148).
  await admin.query(`
    CREATE INDEX activity_time ON blast_infra_fixture.activity (timestamp_ms DESC);
    CREATE INDEX activity_actor_time ON blast_infra_fixture.activity (actor, timestamp_ms DESC);
    CREATE INDEX activity_presale_time ON blast_infra_fixture.activity (presale_id, timestamp_ms DESC);
    CREATE INDEX activity_coin_time ON blast_infra_fixture.activity (coin_type, timestamp_ms DESC);
    CREATE INDEX activity_digest ON blast_infra_fixture.activity (digest);`);
  await admin.query("VACUUM ANALYZE blast_infra_fixture.activity");
  await admin.query("ANALYZE blast_infra_fixture.presales");
  // 200k holder-history rows (T-029): each of the 200 sale coins gains a row every 200th position,
  // its holder count rising 1 → 1,000, so each crosses 100, 250, 500 and 1,000 exactly once. Rows are
  // dated and numbered as the activity rows are, so checkpoint order is time order. blast-infra's only
  // access path is the `(coin_type, checkpoint)` primary key (T-037).
  await admin.query(
    `INSERT INTO blast_infra_fixture.coin_holder_history
     SELECT '0x' || lpad('5a1e' || to_hex(j % ${PRESALES}), 64, '0') || '::coin::S' || (j % ${PRESALES}),
       10000000 + j * 5, $1::bigint - 60 * 86400000::bigint + (j * 5)::bigint * 5184, j / ${PRESALES} + 1
     FROM generate_series(0, ${HOLDER_ROWS - 1}) j`,
    [NOW],
  );
  await admin.query("VACUUM ANALYZE blast_infra_fixture.coin_holder_history");
  await admin.query(`UPDATE watermarks SET checkpoint_hi_inclusive = m.c, timestamp_ms_hi_inclusive = m.ts
    FROM (SELECT max(checkpoint) c, max(timestamp_ms) ts FROM blast_infra_fixture.activity) m`);
  const counts = await admin.query(`SELECT count(*) activity, count(*) FILTER (WHERE kind = 'presale_commit') commits FROM blast_infra_fixture.activity`);
  const holders = await admin.query("SELECT count(*) rows, count(DISTINCT coin_type) coins, max(holders) top FROM blast_infra_fixture.coin_holder_history");
  console.log({ ...counts.rows[0], holder_history: holders.rows[0] });
  await admin.end();
}

type Timing = { label: string; p50: number; p95: number; max: number; runs: number; written?: number };

class Rollback extends Error {}

async function bench() {
  const admin = new pg.Pool({ connectionString: URL_, max: 2 });
  const watcher = new pg.Pool({ connectionString: urlAs(URL_, "blast_watcher"), max: 2 });
  const timings: Timing[] = [];
  const plans: string[] = [];
  const { rows: [mark] } = await admin.query<{ c: string; ts: string }>(
    "SELECT checkpoint_hi_inclusive::text c, timestamp_ms_hi_inclusive::text ts FROM watermarks WHERE pipeline = 'presale'");
  const bounds: SocialWorkerBounds = { pipeline: "presale", checkpoint: Number(mark!.c), timestampMs: Number(mark!.ts) };
  const marketBounds: SocialWorkerBounds = { ...bounds, pipeline: "market" };
  const [commits, holders] = milestoneSteps({
    batchSize: BATCH,
    participantMilestones: async () => SOCIAL_CONFIG_DEFAULTS.participant_milestones,
    holderMilestones: async () => SOCIAL_CONFIG_DEFAULTS.holder_milestones,
  }) as [SocialWorkerStep, SocialWorkerStep];

  /** The commit `offset` commits before the watermark (0 = the last), as a cursor. */
  async function cursorAt(fromEnd: number | "origin" | "tip"): Promise<unknown> {
    if (fromEnd === "origin") return null;
    if (fromEnd === "tip") return { c: bounds.checkpoint, t: SLOT_MAX, e: SLOT_MAX, p: SLOT_MAX, ts: bounds.timestampMs };
    const { rows } = await admin.query<{ c: string; ts: string }>(
      `SELECT checkpoint::text c, timestamp_ms::text ts FROM blast_infra_fixture.activity WHERE kind = 'presale_commit'
       ORDER BY checkpoint DESC OFFSET $1 LIMIT 1`, [fromEnd]);
    return { c: Number(rows[0]!.c), t: 0, e: 0, p: 0, ts: Number(rows[0]!.ts) };
  }

  /** The holder step's cursor `fromEnd` history rows before the watermark (0 = the last). */
  async function holderCursorAt(fromEnd: number | "origin" | "tip"): Promise<unknown> {
    if (fromEnd === "origin") return null;
    if (fromEnd === "tip") return { c: marketBounds.checkpoint };
    const { rows } = await admin.query<{ c: string }>(
      "SELECT checkpoint::text c FROM blast_infra_fixture.coin_holder_history ORDER BY checkpoint DESC OFFSET $1 LIMIT 1", [fromEnd]);
    return { c: Number(rows[0]!.c) };
  }

  async function setCursor(name: string, value: unknown) {
    await admin.query("DELETE FROM social_worker_state WHERE name = $1", [name]);
    if (value !== null) await admin.query("INSERT INTO social_worker_state (name, value) VALUES ($1, $2::jsonb)", [name, JSON.stringify(value)]);
  }

  /** The step's whole transaction as the watcher (cursor, batch end, insert, cursor write), rolled back. */
  async function pass(step: SocialWorkerStep, stepBounds: SocialWorkerBounds): Promise<number> {
    let written = 0;
    try {
      await withTransaction(watcher, async (tx) => {
        written = (await step.run(tx.forModule("social"), stepBounds, { now: Date.now })).milestones_written ?? 0;
        throw new Rollback();
      }, { label: "bench" });
    } catch (error) {
      if (!(error instanceof Rollback)) throw error;
    }
    return written;
  }

  async function time(label: string, runs: number, run: () => Promise<number>): Promise<Timing> {
    const samples: number[] = [];
    let written = 0;
    for (let i = 0; i < runs + 3; i += 1) {
      const start = performance.now();
      // react-doctor-disable-next-line react-doctor/async-await-in-loop -- Measure benchmark cases and warm-up samples serially; overlapping queries would contaminate their latency.
      written = await run();
      if (i >= 3) samples.push(performance.now() - start);
    }
    samples.sort((a, b) => a - b);
    const at = (q: number) => +samples[Math.min(samples.length - 1, Math.ceil(q * samples.length) - 1)]!.toFixed(1);
    const result = { label, p50: at(0.5), p95: at(0.95), max: +samples.at(-1)!.toFixed(1), runs, written };
    console.log(JSON.stringify(result));
    return result;
  }

  /** EXPLAIN ANALYZE of a statement with the step's parameters, rolled back. */
  async function explain(label: string, text: string, values: unknown[]) {
    const client = await admin.connect();
    try {
      await client.query("BEGIN");
      const { rows } = await client.query<{ "QUERY PLAN": string }>(`EXPLAIN (ANALYZE, BUFFERS) ${text}`, values);
      plans.push(`### ${label}\n${rows.map((row) => row["QUERY PLAN"]).join("\n")}`);
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  }

  const scenarios: [string, number | "origin" | "tip"][] = [
    ["commits: idle pass (cursor at the watermark)", "tip"],
    ["commits: 1 new commit (a typical 5 s pass at launch scale)", 1],
    ["commits: 500 new commits (a full batch at the tip)", BATCH],
    ["commits: backfill, first pass from the origin (500)", "origin"],
    ["commits: backfill, a batch mid-history (500 at 50%)", 350_000],
  ];
  for (const [label, at] of scenarios) {
    await setCursor("milestone-commits", await cursorAt(at));
    timings.push(await time(label, 30, () => pass(commits, bounds)));
  }

  // Plans for the full batch at the tip.
  const tip = (await cursorAt(BATCH)) as { c: number; t: number; e: number; p: number; ts: number };
  const from = [tip.ts, bounds.checkpoint, tip.c, tip.t, tip.e, tip.p];
  await explain("commits: batch end (500 at the tip)", MILESTONE_STATEMENTS.commitsBatchEnd, [...from, bounds.timestampMs, BATCH]);
  const end = [bounds.checkpoint, SLOT_MAX, SLOT_MAX, SLOT_MAX, bounds.timestampMs];
  await explain("commits: milestones insert (500 at the tip)", MILESTONE_STATEMENTS.commits, [...from, ...end, [...SOCIAL_CONFIG_DEFAULTS.participant_milestones]]);
  const mid = (await cursorAt(350_000)) as typeof tip;
  const { rows: [midEnd] } = await admin.query<{ c: string; ts: string }>(
    `SELECT checkpoint::text c, timestamp_ms::text ts FROM blast_infra_fixture.activity WHERE kind = 'presale_commit' AND checkpoint > $1
     ORDER BY checkpoint OFFSET ${BATCH - 1} LIMIT 1`, [mid.c]);
  await explain("commits: milestones insert (500 mid-history)", MILESTONE_STATEMENTS.commits,
    [mid.ts, bounds.checkpoint, mid.c, mid.t, mid.e, mid.p, Number(midEnd!.c), 0, 0, 0, Number(midEnd!.ts), [...SOCIAL_CONFIG_DEFAULTS.participant_milestones]]);

  // The holder step (T-029): the same scenarios over the holder history.
  const holderScenarios: [string, number | "origin" | "tip"][] = [
    ["holders: idle pass (cursor at the watermark)", "tip"],
    ["holders: 1 new history row (a typical 5 s pass at launch scale)", 1],
    ["holders: 500 new history rows (a full batch at the tip)", BATCH],
    ["holders: backfill, first pass from the origin (500)", "origin"],
    ["holders: backfill, a batch mid-history (500 at 50%)", HOLDER_ROWS / 2],
  ];
  for (const [label, at] of holderScenarios) {
    await setCursor("milestone-holders", await holderCursorAt(at));
    timings.push(await time(label, 30, () => pass(holders, marketBounds)));
  }

  // Plans for the holder step's full batch at the tip and mid-history.
  const holderTip = (await holderCursorAt(BATCH)) as { c: number };
  await explain("holders: batch end (500 at the tip)", MILESTONE_STATEMENTS.holdersBatchEnd, [holderTip.c, marketBounds.checkpoint, BATCH]);
  await explain("holders: milestones insert (500 at the tip)", MILESTONE_STATEMENTS.holders,
    [holderTip.c, marketBounds.checkpoint, marketBounds.checkpoint, [...SOCIAL_CONFIG_DEFAULTS.holder_milestones]]);
  const holderMid = (await holderCursorAt(HOLDER_ROWS / 2)) as { c: number };
  const { rows: [holderMidEnd] } = await admin.query<{ c: string }>(
    `SELECT checkpoint::text c FROM blast_infra_fixture.coin_holder_history WHERE checkpoint > $1
     ORDER BY checkpoint OFFSET ${BATCH - 1} LIMIT 1`, [holderMid.c]);
  await explain("holders: milestones insert (500 mid-history)", MILESTONE_STATEMENTS.holders,
    [holderMid.c, marketBounds.checkpoint, Number(holderMidEnd!.c), [...SOCIAL_CONFIG_DEFAULTS.holder_milestones]]);

  // A whole backfill: every pass from the origin to the watermark, committed (then removed).
  await setCursor("milestone-commits", null);
  await admin.query("DELETE FROM social_milestones");
  const started = performance.now();
  let passes = 0, written = 0;
  for (;;) {
    let report = 0;
    await withTransaction(watcher, async (tx) => {
      report = (await commits.run(tx.forModule("social"), bounds, { now: Date.now })).milestones_written ?? 0;
    }, { label: "bench" });
    passes += 1;
    written += report;
    const { rows } = await admin.query<{ t: number }>("SELECT (value->>'t')::int t FROM social_worker_state WHERE name = 'milestone-commits'");
    if (rows[0]?.t === SLOT_MAX) break;
  }
  const backfill = { label: `commits: whole backfill (${passes} passes of ${BATCH})`, total_ms: Math.round(performance.now() - started), written };
  console.log(JSON.stringify(backfill));
  // Expected: 140 presales with commits × (8 participant values up to 5,000 + 1 raise) = 1,260.
  const { rows: [check] } = await admin.query<{ n: number; raise: number }>(
    "SELECT count(*)::int n, count(*) FILTER (WHERE kind = 'raise')::int raise FROM social_milestones");
  console.log(JSON.stringify({ milestones: check }));
  await admin.query("DELETE FROM social_milestones");
  await setCursor("milestone-commits", null);

  // The holder step's whole backfill.
  await setCursor("milestone-holders", null);
  const holderStarted = performance.now();
  let holderPasses = 0, holderWritten = 0;
  for (;;) {
    let report = 0;
    await withTransaction(watcher, async (tx) => {
      report = (await holders.run(tx.forModule("social"), marketBounds, { now: Date.now })).milestones_written ?? 0;
    }, { label: "bench" });
    holderPasses += 1;
    holderWritten += report;
    const { rows } = await admin.query<{ c: string }>("SELECT (value->>'c')::bigint::text c FROM social_worker_state WHERE name = 'milestone-holders'");
    if (Number(rows[0]?.c ?? -1) >= marketBounds.checkpoint) break;
  }
  const holderBackfill = {
    label: `holders: whole backfill (${holderPasses} passes of ${BATCH})`,
    total_ms: Math.round(performance.now() - holderStarted), written: holderWritten,
  };
  console.log(JSON.stringify(holderBackfill));
  // Expected: 200 sale coins × (100, 250, 500, 1,000) = 800.
  const { rows: [holderCheck] } = await admin.query<{ n: number }>(
    "SELECT count(*)::int n FROM social_milestones WHERE kind = 'holders'");
  console.log(JSON.stringify({ holder_milestones: holderCheck }));
  await admin.query("DELETE FROM social_milestones");
  await setCursor("milestone-holders", null);

  fs.mkdirSync("loadtest/results", { recursive: true });
  fs.writeFileSync(
    "loadtest/results/social-milestones-timings.json",
    JSON.stringify({ timings, backfill, milestones: check, holderBackfill, holderMilestones: holderCheck }, null, 1),
  );
  fs.writeFileSync("loadtest/results/social-milestones-plans.txt", plans.join("\n\n"));
  await watcher.end();
  await admin.end();
}

const command = process.argv[2];
if (command === "seed") await seed();
else if (command === "bench") await bench();
else throw new Error("usage: social-milestones-scale.ts seed|bench");
