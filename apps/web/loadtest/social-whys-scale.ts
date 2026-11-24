// Social feed T-021..T-023 scale evidence: the why writes, reports and
// moderation at launch scale, with their plans.
//
//   SOCIAL_SCALE_DATABASE_URL=postgresql://postgres:<pw>@127.0.0.1:<port>/<db> \
//     node --no-warnings --experimental-strip-types loadtest/social-scale.ts seed
//   SOCIAL_SCALE_DATABASE_URL=… node --no-warnings --experimental-strip-types loadtest/social-whys-scale.ts seed|bench
//
// The T-021 part times the why write; the T-022 part times the author's
// delete, a report and a repeated report. Moderation (T-023) comes next.
//
// `seed` adds the why volume to `social-scale.ts`'s launch-scale database (10k
// accounts, 1M activity rows, 100k follows): 60k why records over 40k items
// (active, deleted by their author, removed by the team; 3 records on 5k
// items) and 30k reports on 3k whys. `bench` times each statement as the role
// that runs it (`blast_web` for the routes, the owner for the operator CLI)
// inside a transaction it rolls back, so every run sees the same data, and
// writes loadtest/results/social-whys-timings.json and -plans.txt.
import fs from "node:fs";

import pg from "pg";

import { urlAs } from "../../../packages/core/test/fixtures/modules/database/role-fixtures.ts";
import type { ReadableDatabase } from "@blast/core/modules/database/transaction.ts";
import { visibleEntry } from "@blast/core/modules/social/read-model/entries.ts";
import {
  WHY_BY_ID_SQL,
  WHY_DELETE_SQL,
  WHY_FOR_UPDATE_SQL,
  WHY_INSERT_SQL,
  WHY_ITEM_LOCK_SQL,
  WHY_ITEM_RECORDS_SQL,
  WHY_REPORT_SQL,
} from "@blast/server/modules/social/whys/store.ts";

const URL_ = process.env.SOCIAL_SCALE_DATABASE_URL ?? "";
if (!/^postgres(ql)?:\/\/[^@]+@(127\.0\.0\.1|localhost):\d+\/\w+$/.test(URL_)) {
  throw new Error("SOCIAL_SCALE_DATABASE_URL must name a disposable loopback database.");
}
const ACCOUNTS = 10_000;
const THRESHOLDS = { bigCommitUsd: "1000", bigTradeUsd: "1000" };
const account = (n: string) => `('00000000-0000-4000-8000-' || lpad(to_hex(${n}), 12, '0'))::uuid`;

async function seed() {
  const admin = new pg.Pool({ connectionString: URL_, max: 2 });
  // 40k items with one record each (75% active, 15% deleted, 10% removed), then 5k of them with two more deleted records.
  await admin.query(
    `INSERT INTO social_whys (why_id, entry_id, author_account_id, text, state, deleted_at, removed_at, removed_by, removal_reason)
     SELECT gen_random_uuid(), 'a:' || (300000 + i * 17) || ':0:0:0', ${account(`1 + i % ${ACCOUNTS}`)}, 'Scale reason ' || i,
       s, CASE WHEN s = 'deleted' THEN now() END, CASE WHEN s = 'removed' THEN now() END,
       CASE WHEN s = 'removed' THEN 'ops.scale' END, CASE WHEN s = 'removed' THEN 'spam' END
     FROM (SELECT i, CASE WHEN i % 20 < 15 THEN 'active' WHEN i % 20 < 18 THEN 'deleted' ELSE 'removed' END AS s
           FROM generate_series(1, 40000) i) g`,
  );
  await admin.query(
    `INSERT INTO social_whys (why_id, entry_id, author_account_id, text, state, deleted_at)
     SELECT gen_random_uuid(), 'a:' || (300000 + i * 17) || ':0:0:0', ${account(`1 + i % ${ACCOUNTS}`)}, 'Earlier reason ' || i || '-' || k,
       'deleted', now() - interval '1 hour'
     FROM generate_series(1, 5000) i CROSS JOIN generate_series(1, 2) k`,
  );
  // 30k reports on 3k active whys (10 reporters each, some with a reason).
  await admin.query(
    `INSERT INTO social_why_reports (why_id, reporter_account_id, reason, created_at)
     SELECT w.why_id, ${account(`1 + (w.n * 13 + r) % ${ACCOUNTS}`)}, CASE WHEN r % 3 = 0 THEN 'Spam ' || r END,
       now() - (w.n || ' minutes')::interval - (r || ' seconds')::interval
     FROM (SELECT why_id, row_number() OVER (ORDER BY why_id) AS n FROM social_whys WHERE state = 'active' LIMIT 3000) w
     CROSS JOIN generate_series(1, 10) r
     ON CONFLICT DO NOTHING`,
  );
  await admin.query("ANALYZE social_whys; ANALYZE social_why_reports");
  console.log((await admin.query(
    `SELECT (SELECT count(*) FROM social_whys) whys, (SELECT count(DISTINCT entry_id) FROM social_whys) items,
       (SELECT count(*) FROM social_why_reports) reports`,
  )).rows[0]);
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

type Client = pg.PoolClient;
const reader = (client: Client): ReadableDatabase =>
  ({ read: (text: string, values?: readonly unknown[]) => client.query(text, values as unknown[]) }) as unknown as ReadableDatabase;

/** Runs `body` in a transaction on `pool` and rolls it back. */
async function rolledBack(pool: pg.Pool, body: (client: Client) => Promise<unknown>): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await body(client);
  } finally {
    await client.query("ROLLBACK");
    client.release();
  }
}

async function bench() {
  const owner = new pg.Pool({ connectionString: URL_, max: 2 });
  const web = new pg.Pool({ connectionString: urlAs(URL_, "blast_web"), max: 2 });
  const timings: Timing[] = [];
  const plans: Record<string, string> = {};
  const explain = async (label: string, pool: pg.Pool, text: string, values: unknown[]) => {
    await rolledBack(pool, async (client) => {
      const plan = await client.query<{ "QUERY PLAN": string }>(`EXPLAIN (ANALYZE, BUFFERS) ${text}`, values);
      plans[label] = plan.rows.map((row) => row["QUERY PLAN"]).join("\n");
    });
  };

  // A named commit by an account wallet (the author's own item) and the item with three records.
  const named = (await owner.query<{ entry_id: string; account_id: string }>(
    `SELECT 'a:' || a.activity_id AS entry_id, w.account_id::text
     FROM chain_read_v1.activity a JOIN social_account_wallets w ON w.address = a.actor
     JOIN social_accounts s ON s.account_id = w.account_id AND s.privacy = 'public' AND s.sharing_since IS NOT NULL
     WHERE a.kind = 'presale_commit' ORDER BY a.timestamp_ms DESC LIMIT 1`,
  )).rows[0]!;
  const crowded = (await owner.query<{ entry_id: string }>(
    "SELECT entry_id FROM social_whys GROUP BY entry_id HAVING count(*) = 3 LIMIT 1",
  )).rows[0]!.entry_id;

  // T-021: POST …/why's transaction (naming read, lock, the item's records, insert).
  timings.push(await time("T-021 why POST transaction (visibleEntry + lock + records + insert, blast_web)", 50, (i) =>
    rolledBack(web, async (client) => {
      await visibleEntry(reader(client), named.entry_id, THRESHOLDS);
      await client.query(WHY_ITEM_LOCK_SQL, [named.entry_id]);
      await client.query(WHY_ITEM_RECORDS_SQL, [named.entry_id]);
      await client.query(WHY_INSERT_SQL, [`00000000-0000-4000-9000-${String(i).padStart(12, "0")}`, named.entry_id, named.account_id, "Scale"]);
    })));
  timings.push(await time("T-021 an item's why records (3 records)", 50, () => web.query(WHY_ITEM_RECORDS_SQL, [crowded])));
  await explain("T-021 an item's why records", web, WHY_ITEM_RECORDS_SQL, [crowded]);
  await explain("T-021 why insert", web, WHY_INSERT_SQL, ["00000000-0000-4000-9000-ffffffffffff", named.entry_id, named.account_id, "Scale"]);

  // T-022: an active why with the most reports, and an account that has not reported it.
  const reported = (await owner.query<{ why_id: string; author_account_id: string }>(
    `SELECT w.why_id::text, w.author_account_id::text FROM social_whys w
     JOIN (SELECT why_id, count(*) AS n FROM social_why_reports GROUP BY why_id ORDER BY n DESC LIMIT 1) r USING (why_id)
     WHERE w.state = 'active'`,
  )).rows[0]!;
  const reporter = (await owner.query<{ account_id: string }>(
    `SELECT a.account_id::text FROM social_accounts a
     WHERE a.account_id <> $2::uuid
       AND NOT EXISTS (SELECT 1 FROM social_why_reports r WHERE r.why_id = $1::uuid AND r.reporter_account_id = a.account_id)
     LIMIT 1`,
    [reported.why_id, reported.author_account_id],
  )).rows[0]!.account_id;

  // T-022: DELETE /api/social/whys/{why_id}'s transaction (the locked row, then the retraction).
  timings.push(await time("T-022 why DELETE transaction (locked row + retraction, blast_web)", 50, () =>
    rolledBack(web, async (client) => {
      await client.query(WHY_FOR_UPDATE_SQL, [reported.why_id]);
      await client.query(WHY_DELETE_SQL, [reported.why_id]);
    })));
  // T-022: POST …/reports' transaction (the why, then the one report row).
  timings.push(await time("T-022 why report transaction (why read + report insert, blast_web)", 50, () =>
    rolledBack(web, async (client) => {
      await client.query(WHY_BY_ID_SQL, [reported.why_id]);
      await client.query(WHY_REPORT_SQL, [reported.why_id, reporter, "Scale report"]);
    })));
  // And the repeat that stores nothing (the 200 answer), on a why this account has reported.
  const repeat = (await owner.query<{ reporter_account_id: string }>(
    "SELECT reporter_account_id::text FROM social_why_reports WHERE why_id = $1::uuid LIMIT 1",
    [reported.why_id],
  )).rows[0]!.reporter_account_id;
  timings.push(await time("T-022 why report repeat (ON CONFLICT DO NOTHING, blast_web)", 50, () =>
    rolledBack(web, (client) => client.query(WHY_REPORT_SQL, [reported.why_id, repeat, "Scale report"]))));
  await explain("T-022 one why by its id, locked", web, WHY_FOR_UPDATE_SQL, [reported.why_id]);
  await explain("T-022 the author's retraction", web, WHY_DELETE_SQL, [reported.why_id]);
  await explain("T-022 one report, inserted once", web, WHY_REPORT_SQL, [reported.why_id, reporter, "Scale report"]);

  fs.mkdirSync("loadtest/results", { recursive: true });
  fs.writeFileSync("loadtest/results/social-whys-timings.json", JSON.stringify(timings, null, 1));
  fs.writeFileSync("loadtest/results/social-whys-plans.txt", Object.entries(plans).map(([k, v]) => `### ${k}\n${v}`).join("\n\n"));
  await owner.end();
  await web.end();
}

if (process.argv[2] === "seed") await seed();
else await bench();
