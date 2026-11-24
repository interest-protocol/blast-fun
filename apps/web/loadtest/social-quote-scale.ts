// R3-40/R3-42 scale evidence: the reads that learned a sale's quote coin, at
// launch scale, with a third of the sales quoted in SUI. Over the database
// `loadtest/social-panel-scale.ts seed` builds (10k accounts each with a
// linked wallet, 2,000 sales, 160k positions, 1M activity rows over 60 days,
// 100k follows, 5k theses, one heavy viewer following 1,000 accounts).
//
//   SOCIAL_SCALE_DATABASE_URL=postgresql://postgres:<pw>@127.0.0.1:<port>/<db> \
//     node --no-warnings --import ./scripts/test-tsx-hooks.mjs --experimental-strip-types loadtest/social-quote-scale.ts prepare|bench
//
// `prepare` quotes the busiest open sale and a third of the others in SUI
// (9 decimals: every amount of theirs × 1,000 — sales, positions, activity)
// and adds a SUI price row. `bench` runs every statement of each read under
// EXPLAIN (ANALYZE), SCALE_RUNS times after 3 warm-ups, and the whole reads
// by wall time: the list page, the sale page and the viewer read (summary,
// momentum, raise and backers now carry atoms; the sale page reads the quote's
// price), a post's backers and viewer-state's followed backers (now summing
// the quote amount), Home's tape (the quote amount and symbol), a profile's
// calls and own presales (joined to the quote's price) and Create's SUI price
// probe. Writes loadtest/results/social-quote-scale-timings.json and -plans.txt.
import fs from "node:fs";

import pg from "pg";

import { urlAs } from "../../../packages/core/test/fixtures/modules/database/role-fixtures.ts";
import { autocommitReader, type ReadableDatabase } from "@blast/core/modules/database/transaction.ts";
import { SOCIAL_CONFIG_DEFAULTS } from "@blast/core/modules/social/contracts/config.ts";
import { SOCIAL_FEED_TRADE_KINDS } from "@blast/core/modules/social/contracts/feed.ts";
import { PRESALE_LIST_DEFAULT_LIMIT, PRESALE_LIST_SORTS } from "@blast/core/modules/social/contracts/presales.ts";
import {  } from "@blast/server/modules/social/create/route.ts";
import { readSuiQuotePrice } from "@blast/server/modules/social/create/quote-price.ts";
import { readHappening } from "@blast/server/modules/social/happening/read.ts";
import { BACKERS_SQL } from "@blast/server/modules/social/items/mapper.ts";
import { readAccountAddresses } from "@blast/server/modules/social/accounts/read-wallet-addresses.ts";
import { readPresaleListPage, readPresalePage } from "@blast/server/modules/social/presales/route.ts";
import { chainViewsOnly } from "@blast/core/modules/social/presales/sql.ts";
import { readViewerPresales } from "@blast/server/modules/social/presales/viewer.ts";
import { readCalls } from "@blast/server/modules/social/profiles/calls.ts";
import { readMePresales } from "@blast/server/modules/social/profiles/viewer.ts";
import { FOLLOWED_BACKERS_SQL } from "@blast/server/modules/social/viewer-state/store.ts";

const URL_ = process.env.SOCIAL_SCALE_DATABASE_URL ?? "";
if (!/^postgres(ql)?:\/\/[^@]+@(127\.0\.0\.1|localhost):\d+\/\w+$/.test(URL_)) {
  throw new Error("SOCIAL_SCALE_DATABASE_URL must name a disposable loopback database.");
}
const RUNS = Number(process.env.SCALE_RUNS ?? 50);
const SUI = `0x${"2".padStart(64, "0")}::sui::SUI`;
/** The panel seed's heavy viewer (follows 1,000 accounts). */
const HEAVY_VIEWER = "00000000-0000-4000-8000-000000000001";

async function busiestOpen(pool: pg.Pool): Promise<string> {
  return (await pool.query<{ presale_id: string }>(
    `SELECT a.presale_id FROM chain_read_v1.activity a JOIN chain_read_v1.presales p USING (presale_id)
     WHERE p.lifecycle = 'open' GROUP BY 1 ORDER BY count(*) DESC, 1 LIMIT 1`,
  )).rows[0]!.presale_id;
}

async function prepare() {
  const admin = new pg.Pool({ connectionString: URL_, max: 2 });
  const [busiest, client] = await Promise.all([busiestOpen(admin), admin.connect()]);
  try {
    await client.query("BEGIN");
    await client.query("CREATE TEMP TABLE sui_sales ON COMMIT DROP AS SELECT presale_id FROM blast_infra_fixture.presales WHERE abs(hashtext(presale_id)) % 3 = 0 OR presale_id = $1", [busiest]);
    await client.query(
      `UPDATE blast_infra_fixture.presales SET quote_type = $1, quote_symbol = 'SUI', quote_decimals = 9,
         raise_target = raise_target * 1000, min_commitment = min_commitment * 1000, wallet_cap = wallet_cap * 1000, total_commitments = total_commitments * 1000
       WHERE presale_id IN (SELECT presale_id FROM sui_sales) AND quote_symbol = 'USDC'`,
      [SUI],
    );
    await client.query(
      `UPDATE blast_infra_fixture.presale_positions SET commitment = commitment * 1000, claimed_quote_refund = claimed_quote_refund * 1000
       WHERE presale_id IN (SELECT presale_id FROM sui_sales)`,
    );
    await client.query(
      `UPDATE blast_infra_fixture.activity SET quote_type = $1, quote_amount = quote_amount * 1000, quote_refund = quote_refund * 1000,
         total_commitments_after = total_commitments_after * 1000
       WHERE presale_id IN (SELECT presale_id FROM sui_sales) AND quote_type <> $1`,
      [SUI],
    );
    await client.query(
      `INSERT INTO blast_infra_fixture.prices (coin_type, usd_price, as_of_ms, source) VALUES ($1, 3.42, $2, 'pyth')
       ON CONFLICT (coin_type) DO UPDATE SET usd_price = EXCLUDED.usd_price, as_of_ms = EXCLUDED.as_of_ms`,
      [SUI, Date.now()],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  await admin.query("VACUUM ANALYZE");
  const counts = await admin.query(`SELECT quote_symbol, count(*) AS sales FROM blast_infra_fixture.presales GROUP BY 1 ORDER BY 1`);
  console.log(`busiest open sale ${busiest} is SUI-quoted;`, counts.rows);
  await admin.end();
}

type Timing = { label: string; p50: number; p95: number; max: number; runs: number };
type Statement = { text: string; values: readonly unknown[] };

function summarize(label: string, samples: number[]): Timing {
  samples.sort((a, b) => a - b);
  const at = (q: number) => +samples[Math.min(samples.length - 1, Math.ceil(q * samples.length) - 1)]!.toFixed(2);
  const result = { label, p50: at(0.5), p95: at(0.95), max: +samples.at(-1)!.toFixed(2), runs: samples.length };
  console.log(JSON.stringify(result));
  return result;
}

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
    // One EXPLAIN at a time: each sample is one statement's own planning and execution.
    // react-doctor-disable-next-line react-doctor/async-await-in-loop
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
    // One run at a time: each sample is one read's own wall time.
    // react-doctor-disable-next-line react-doctor/async-await-in-loop
    await run();
    if (i >= 3) samples.push(performance.now() - start);
  }
  return summarize(label, samples);
}

function nameOf(statement: Statement, index: number): string {
  const text = statement.text.replace(/\s+/g, " ");
  const from = text.match(/FROM (chain_read_v1\.\w+|social_\w+)/)?.[1] ?? "statement";
  return `${index + 1}. ${from} — ${text.slice(0, 90)}`;
}

async function bench() {
  const replicaPool = new pg.Pool({ connectionString: urlAs(URL_, "blast_replica"), max: 4 });
  const webPool = new pg.Pool({ connectionString: urlAs(URL_, "blast_web"), max: 4 });
  const replica = autocommitReader(replicaPool, "social");
  const web = autocommitReader(webPool, "social");
  const timings: Timing[] = [];
  const plans: Record<string, string> = {};
  const nowMs = Date.now();
  const sale = await busiestOpen(replicaPool);
  const quote = (await replicaPool.query<{ quote_symbol: string }>("SELECT quote_symbol FROM chain_read_v1.presales WHERE presale_id = $1", [sale])).rows[0]!.quote_symbol;
  if (quote !== "SUI") throw new Error("run `prepare` first: the busiest open sale is not SUI-quoted");
  const each = async (label: string, pool: pg.Pool, db: ReadableDatabase, run: (db: ReadableDatabase) => Promise<unknown>) => {
    timings.push(await timed(`${label} (whole read, wall)`, () => run(db)));
    for (const [index, statement] of (await capture(db, run)).entries()) {
      timings.push(await explained(pool, `${label} ${nameOf(statement, index)}`, statement, plans));
    }
  };

  // Create's picker: SUI's price row, one primary-key probe.
  await each("create: SUI price", replicaPool, replica, (db) => readSuiQuotePrice(db));
  // The presales list's first live page (summaries carry the quote and atoms; a claimed price in the quote).
  const live = { status: "live" as const, sort: PRESALE_LIST_SORTS.live[0], cursor: null, limit: PRESALE_LIST_DEFAULT_LIMIT };
  await each("list: live, first page", replicaPool, replica, (db) => readPresaleListPage(db, live, nowMs));
  // The busiest open sale's page (SUI): momentum and raise in atoms, backers' atoms, the quote's price.
  const options = { nowMs, config: SOCIAL_CONFIG_DEFAULTS, terms: async () => null };
  const detail = await readPresalePage(replica, sale, options);
  console.log(`sale ${sale.slice(-6)} (${quote}): ${detail?.backers.top.length} backers, ${detail?.raise.points.length} points, quote price ${detail?.quote_price?.usd_price}`);
  await each("sale page (SUI)", replicaPool, replica, (db) => readPresalePage(db, sale, options));
  // The viewer read for the heavy viewer: followed backers' atoms and own position.
  await each("viewer read (SUI sale, heavy viewer)", replicaPool, replica, async (db) => {
    const scoped = chainViewsOnly(db);
    await readViewerPresales(scoped, HEAVY_VIEWER, await readAccountAddresses(scoped, HEAVY_VIEWER), [sale]);
  });
  // A post's backers (items) and viewer-state's followed backers: the quote amount summed beside the dollars.
  await each("post backers (SUI sale)", replicaPool, replica, (db) => db.read(BACKERS_SQL, [[sale]]));
  await each("viewer-state followed backers (SUI sale, heavy viewer)", webPool, web, (db) => db.read(FOLLOWED_BACKERS_SQL, [HEAVY_VIEWER, [sale]]));
  // Home's tape: the quote amount and symbol.
  await each("happening", replicaPool, replica, (db) => readHappening(db, { config: SOCIAL_CONFIG_DEFAULTS, nowMs, hiddenKinds: SOCIAL_FEED_TRADE_KINDS }));
  // The account with the most positions: its calls (replica) and own presales (primary), joined to the quote's price.
  const busiestAccount = (await replicaPool.query<{ account_id: string }>(
    `SELECT w.account_id::text FROM chain_read_v1.presale_positions pp JOIN social_account_wallets w ON w.address = pp.wallet
     GROUP BY 1 ORDER BY count(*) DESC, 1 LIMIT 1`,
  )).rows[0]!.account_id;
  await each("profile calls (busiest account)", replicaPool, replica, (db) => readCalls(db, busiestAccount, nowMs));
  await each("me presales (busiest account)", webPool, web, (db) => readMePresales(db, busiestAccount, nowMs));

  const load = fs.readFileSync("/proc/loadavg", "utf8").trim();
  fs.mkdirSync("loadtest/results", { recursive: true });
  fs.writeFileSync("loadtest/results/social-quote-scale-timings.json", JSON.stringify({ at: new Date().toISOString(), runs: RUNS, load, timings }, null, 1));
  fs.writeFileSync("loadtest/results/social-quote-scale-plans.txt", Object.entries(plans).map(([label, plan]) => `== ${label}\n${plan}\n`).join("\n"));
  console.log(`host load ${load}`);
  await Promise.all([replicaPool.end(), webPool.end()]);
}

const command = process.argv[2];
if (command === "prepare") await prepare();
else if (command === "bench") await bench();
else throw new Error("usage: social-quote-scale.ts prepare|bench");
