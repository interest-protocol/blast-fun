// Home's live reads at launch scale (UI-05: GET /api/social/happening and
// viewer-state's follows_you): EXPLAIN (ANALYZE) and p50/p95 of every
// statement over the database `loadtest/social-scale.ts seed` builds (10k
// accounts, 1M activity rows over 60 days, 100k follows, blast-infra's
// activity indexes).
//
//   SOCIAL_SCALE_DATABASE_URL=postgresql://postgres:<pw>@127.0.0.1:<port>/<db> \
//     node --no-warnings --import ./scripts/test-tsx-hooks.mjs --experimental-strip-types loadtest/social-happening-scale.ts prepare|bench
//
// `prepare` adds 30k presale follows and moves both watermarks to the newest
// activity (a live indexer); `bench` writes loadtest/results/social-happening-*.
import fs from "node:fs";

import pg from "pg";

import { urlAs } from "../../../packages/core/test/fixtures/modules/database/role-fixtures.ts";
import { autocommitReader, type ReadableDatabase } from "@blast/core/modules/database/transaction.ts";
import { SOCIAL_CONFIG_DEFAULTS } from "@blast/core/modules/social/contracts/config.ts";
import { SOCIAL_FEED_TRADE_KINDS } from "@blast/core/modules/social/contracts/feed.ts";
import { readHappening } from "@blast/server/modules/social/happening/read.ts";
import { FOLLOWERS_OF_CALLER } from "@blast/server/modules/social/viewer-state/store.ts";

const URL_ = process.env.SOCIAL_SCALE_DATABASE_URL ?? "";
if (!/^postgres(ql)?:\/\/[^@]+@(127\.0\.0\.1|localhost):\d+\/\w+$/.test(URL_)) {
  throw new Error("SOCIAL_SCALE_DATABASE_URL must name a disposable loopback database.");
}
const RUNS = 30;

async function prepare() {
  const admin = new pg.Pool({ connectionString: URL_, max: 2 });
  await admin.query(`
    INSERT INTO social_follows (follower_account_id, target_kind, target_id, source)
    SELECT DISTINCT ON (a, p) ('00000000-0000-4000-8000-' || lpad(to_hex(a), 12, '0'))::uuid, 'presale', '0x' || lpad('5a1e' || to_hex(p), 64, '0'), 'user'
    FROM (SELECT 1 + abs(hashtext('pf' || i)) % 10000 AS a, abs(hashtext('pp' || i)) % 60 AS p FROM generate_series(1, 31000) i) s
    ON CONFLICT DO NOTHING`);
  await admin.query(`
    UPDATE watermarks SET checkpoint_hi_inclusive = (SELECT max(checkpoint) FROM blast_infra_fixture.activity),
      timestamp_ms_hi_inclusive = (SELECT max(timestamp_ms) FROM blast_infra_fixture.activity)`);
  await admin.query("ANALYZE");
  const counts = await admin.query(`SELECT (SELECT count(*) FROM social_follows WHERE target_kind = 'presale') AS presale_follows,
    (SELECT count(*) FROM blast_infra_fixture.activity a, watermarks w WHERE w.pipeline = 'presale' AND a.timestamp_ms > w.timestamp_ms_hi_inclusive - 3600000) AS last_hour`);
  console.log(counts.rows[0]);
  await admin.end();
}

type Timing = { label: string; p50: number; p95: number; max: number; runs: number };

async function time(label: string, run: () => Promise<unknown>): Promise<Timing> {
  const samples: number[] = [];
  for (let i = 0; i < RUNS + 3; i += 1) {
    const start = performance.now();
    // react-doctor-disable-next-line react-doctor/async-await-in-loop -- Measure benchmark cases and warm-up samples serially; overlapping queries would contaminate their latency.
    await run();
    if (i >= 3) samples.push(performance.now() - start);
  }
  samples.sort((a, b) => a - b);
  const at = (q: number) => +samples[Math.min(samples.length - 1, Math.ceil(q * samples.length) - 1)]!.toFixed(2);
  const result = { label, p50: at(0.5), p95: at(0.95), max: +samples.at(-1)!.toFixed(2), runs: RUNS };
  console.log(JSON.stringify(result));
  return result;
}

async function bench() {
  const replicaPool = new pg.Pool({ connectionString: urlAs(URL_, "blast_replica"), max: 4 });
  const webPool = new pg.Pool({ connectionString: urlAs(URL_, "blast_web"), max: 4 });
  const replica = autocommitReader(replicaPool, "social");
  const timings: Timing[] = [];
  const plans: string[] = [];
  const request = { config: SOCIAL_CONFIG_DEFAULTS, nowMs: Date.now(), hiddenKinds: SOCIAL_FEED_TRADE_KINDS };

  // Every statement of one read, captured with its values.
  const statements: { text: string; values: readonly unknown[] }[] = [];
  const capturing: ReadableDatabase = { read: (text, values = []) => { statements.push({ text, values }); return replica.read(text, values); } } as ReadableDatabase;
  const body = await readHappening(capturing, request);
  console.log(`tape ${body.tape.length}, last hour ${body.last_hour.wallets} wallets $${body.last_hour.usd}, fastest ${body.fastest.length}, soon ${body.opening_soon.length}, today ${body.today.length}`);

  timings.push(await time("happening: the whole read (7 statements, 2 waves)", () => readHappening(replica, request)));
  const names = ["watermark bounds", "as_of", "last hour", "tape", "candidate presales", "presale chips", "velocity window", "interested"];
  for (const [n, statement] of statements.entries()) {
    const label = `happening: ${names[n] ?? `statement ${n}`}`;
    const first = statement.text.trim().split("\n")[0]!.slice(0, 80);
    timings.push(await time(`${label} — ${first}`, () => replicaPool.query(statement.text, statement.values as unknown[])));
    const plan = await replicaPool.query<{ "QUERY PLAN": string }>(`EXPLAIN (ANALYZE, BUFFERS) ${statement.text}`, statement.values as unknown[]);
    plans.push(`### ${label}\n${plan.rows.map((row) => row["QUERY PLAN"]).join("\n")}`);
  }

  // follows_you for the most-followed account and 50 callsigns, as the web role on the primary.
  const busiest = (await webPool.query<{ id: string }>(
    "SELECT target_id AS id FROM social_follows WHERE target_kind = 'account' GROUP BY 1 ORDER BY count(*) DESC LIMIT 1",
  )).rows[0]!.id;
  const callsigns = (await webPool.query<{ callsign: string }>(
    `SELECT c.callsign FROM social_follows f JOIN social_account_callsigns c ON c.account_id = f.follower_account_id
     WHERE f.target_kind = 'account' AND f.target_id = $1 AND c.callsign IS NOT NULL LIMIT 25`, [busiest],
  )).rows.map((row) => row.callsign);
  const others = (await webPool.query<{ callsign: string }>("SELECT callsign FROM social_accounts WHERE callsign IS NOT NULL ORDER BY account_id DESC LIMIT 25")).rows.map((row) => row.callsign);
  const values = [busiest, [...callsigns, ...others]];
  timings.push(await time("viewer-state follows_you (most-followed account, 50 callsigns)", () => webPool.query(FOLLOWERS_OF_CALLER, values)));
  const plan = await webPool.query<{ "QUERY PLAN": string }>(`EXPLAIN (ANALYZE, BUFFERS) ${FOLLOWERS_OF_CALLER}`, values);
  plans.push(`### viewer-state follows_you\n${plan.rows.map((row) => row["QUERY PLAN"]).join("\n")}`);

  fs.mkdirSync("loadtest/results", { recursive: true });
  fs.writeFileSync("loadtest/results/social-happening-timings.json", `${JSON.stringify(timings, null, 1)}\n`);
  fs.writeFileSync("loadtest/results/social-happening-plans.txt", `${plans.join("\n\n")}\n`);
  await replicaPool.end();
  await webPool.end();
}

if (process.argv[2] === "prepare") await prepare();
else await bench();
