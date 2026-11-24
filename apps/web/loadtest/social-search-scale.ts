// Social feed search and watchlist scale evidence (UI-12): seed a launch-scale
// disposable database (about 10k accounts: 6k Mission Control members, 3k of
// them with Blast rows and 300 renamed on Blast, 4k new accounts, 5% private;
// PRESALES sales, default 2,000 to stay pessimistic; 50k stars with one
// account at the 500 limit; 100k follows, 30k of them presales, the same
// account following every sale: UI-12b's card) and time search's and the
// watchlist's statements with EXPLAIN (ANALYZE) planning + execution, each
// run SCALE_RUNS times.
//
//   SOCIAL_SCALE_DATABASE_URL=postgresql://postgres:<pw>@127.0.0.1:<port>/<db> \
//     node --no-warnings --import ./scripts/test-tsx-hooks.mjs --experimental-strip-types loadtest/social-search-scale.ts seed|bench
//
// The database must be a disposable loopback Postgres (seed resets it); run it
// on tmpfs (`--tmpfs /var/lib/postgresql/data:size=3g`). bench writes
// loadtest/results/social-search-scale-timings.json and -plans.txt.
import fs from "node:fs";

import pg from "pg";

import { migrateDatabase } from "@blast/core/modules/database/migrations.ts";
import { createPool } from "@blast/core/modules/database/pool.ts";
import { CHAIN_FIXTURE, advanceWatermark, resetSharedDatabase, urlAs } from "../../../packages/core/test/fixtures/modules/database/role-fixtures.ts";
import { autocommitReader, withTransaction } from "@blast/core/modules/database/transaction.ts";
import { normalizeSearchQuery } from "@blast/core/modules/social/contracts/search.ts";
import { PEOPLE_CONTAINS_MIN, SEARCH_SQL, likeLiteral, readSearch } from "@blast/server/modules/social/search/read.ts";
import { WATCHLIST_ENTRIES_SQL, readWatchlistIds, readWatchlistPage, star, unstar } from "@blast/server/modules/social/watchlist/store.ts";

const URL_ = process.env.SOCIAL_SCALE_DATABASE_URL ?? "";
if (!/^postgres(ql)?:\/\/[^@]+@(127\.0\.0\.1|localhost):\d+\/\w+$/.test(URL_)) {
  throw new Error("SOCIAL_SCALE_DATABASE_URL must name a disposable loopback database (seed resets it).");
}
const NOW = Date.now();
const PRESALES = Number(process.env.PRESALES ?? 2_000);
const RUNS = Number(process.env.SCALE_RUNS ?? 50);
const MEMBERS = 6_000, MEMBER_ACCOUNTS = 3_000, RENAMED = 300, NEW_ACCOUNTS = 4_000, STARS = 50_000;
const ACCOUNT_FOLLOWS = 70_000, PRESALE_FOLLOWS = 30_000;
const uuid = (n: string) => `('00000000-0000-4000-8000-' || lpad(to_hex(${n}), 12, '0'))::uuid`;
const FIRST = ["Luca", "Mira", "Ana", "Ivy", "Theo", "Rio", "Omar", "Sam", "Nadia", "Kai", "Lena", "Marco", "Yuki", "Zoe", "Ben", "Eli", "Noor", "Aria", "Leo", "Maya",
  "Ravi", "Sofia", "Hugo", "Iris", "Jon", "Kira", "Liam", "Nina", "Oscar", "Pia", "Quinn", "Rosa", "Sven", "Tara", "Uma", "Vic", "Wren", "Xavi", "Yara", "Zed"];
const LAST = ["Romano", "Chen", "Souza", "Laurent", "Park", "Nakamura", "Haddad", "Okafor", "Petrova", "Moreno", "Silva", "Kim", "Novak", "Ito", "Berg", "Costa",
  "Diaz", "Evans", "Fischer", "Garcia", "Hansen", "Ivanov", "Jensen", "Kowal", "Lopez", "Meyer", "Nagy", "Olsen", "Popov", "Quirk"];
const WORDS = ["Meridian", "Tidal", "Sable", "Ondine", "Cobalt", "Kestrel", "Lumen", "Halcyon", "Aster", "Boreal", "Cinder", "Delta", "Ember", "Fjord", "Gale",
  "Harbor", "Indigo", "Jade", "Kelvin", "Lattice", "Mosaic", "Nimbus", "Orbit", "Prism", "Quartz", "Riven", "Solace", "Tundra", "Umbra", "Vertex"];
const arr = (values: readonly string[]) => `ARRAY[${values.map((value) => `'${value}'`).join(",")}]`;

async function seed() {
  const admin = createPool(URL_, { max: 2 });
  await resetSharedDatabase(admin);
  await admin.query(CHAIN_FIXTURE);
  await migrateDatabase(admin);
  // Sales: two-word names ("Meridian Prism 12"), a four-letter symbol; a third live, a tenth upcoming, the rest ended.
  await admin.query(
    `INSERT INTO blast_infra_fixture.presales
     SELECT '0x' || lpad('5a1e' || to_hex(n), 64, '0'), '0x' || lpad('5a1e' || to_hex(n), 64, '0') || '::coin::S' || n,
       '0x' || lpad('dba3', 64, '0') || '::usdc::USDC',
       upper(substr(w.a, 1, 2) || substr(w.b, 1, 2)), w.a || ' ' || w.b || CASE WHEN n >= 900 THEN ' ' || n ELSE '' END,
       'https://cdn.blast.fun/s' || n || '.png', 9, 'USDC', 6,
       CASE WHEN n % 3 = 0 THEN 'open' WHEN n % 10 = 1 THEN 'pending' WHEN n % 10 = 2 THEN 'cancelled' WHEN n % 10 IN (4, 5) THEN 'funded' ELSE 'migrated' END,
       $1::bigint - (n % 40)::bigint * 86400000, $1::bigint + (CASE WHEN n % 3 = 0 THEN 1 + n % 5 ELSE -1 - n % 30 END)::bigint * 86400000,
       250000000000, 10000000, 25000000000, 100000000000, 900, 'cetus', NULL, 1
     FROM generate_series(0, ${PRESALES - 1}) n,
       LATERAL (SELECT (${arr(WORDS)})[1 + n % ${WORDS.length}] AS a, (${arr(WORDS)})[1 + (n / ${WORDS.length}) % ${WORDS.length}] AS b) w`,
    [NOW],
  );
  await admin.query(advanceWatermark(70_000, 0, "market"));
  await admin.query(`UPDATE watermarks SET timestamp_ms_hi_inclusive = ${NOW} WHERE pipeline IN ('market', 'presale')`);
  // Members: callsign from the name and a number; display names "First Last".
  await admin.query(
    `INSERT INTO mission_control_profiles (profile_id, privy_did, x_subject, sui_address, provider_wallet_reference, callsign, display_name,
       disclosure_version, disclosure_accepted_at)
     SELECT ${uuid("n")}, 'did:privy:m' || n, 'x' || n, '0x' || lpad(to_hex(n + 1), 64, '0'), 'w' || n,
       lower(f.f || l.l) || n, f.f || ' ' || l.l, 'v1', now()
     FROM generate_series(1, ${MEMBERS}) n,
       LATERAL (SELECT (${arr(FIRST)})[1 + n % ${FIRST.length}] AS f) f,
       LATERAL (SELECT (${arr(LAST)})[1 + (n / ${FIRST.length}) % ${LAST.length}] AS l) l`,
  );
  // Half the members opened Blast; 300 renamed themselves there; 5% of accounts are private.
  await admin.query(
    `INSERT INTO social_accounts (account_id, profile_id, display_name, privacy)
     SELECT ${uuid("100000 + n")}, ${uuid("n")}, CASE WHEN n <= ${RENAMED} THEN 'Nova ' || n END,
       CASE WHEN n % 20 = 0 THEN 'private' ELSE 'public' END
     FROM generate_series(1, ${MEMBER_ACCOUNTS}) n`,
  );
  await admin.query(
    `INSERT INTO social_accounts (account_id, privy_did, callsign, display_name, privacy, x_subject)
     SELECT ${uuid("200000 + n")}, 'did:privy:a' || n, lower(f.f || '_' || l.l) || n, f.f || ' ' || l.l,
       CASE WHEN n % 20 = 0 THEN 'private' ELSE 'public' END, CASE WHEN n % 3 = 0 THEN 'xs' || n END
     FROM generate_series(1, ${NEW_ACCOUNTS}) n,
       LATERAL (SELECT (${arr(FIRST)})[1 + (n * 7) % ${FIRST.length}] AS f) f,
       LATERAL (SELECT (${arr(LAST)})[1 + (n * 11) % ${LAST.length}] AS l) l`,
  );
  await admin.query(`INSERT INTO social_default_accounts (position, account_id) SELECT n, ${uuid("200000 + n")} FROM generate_series(1, 5) n`);
  // Stars: 50k spread over the accounts, and one account at the limit (500).
  await admin.query(
    `INSERT INTO social_watchlist (account_id, presale_id, created_at)
     SELECT a, '0x' || lpad('5a1e' || to_hex(p), 64, '0'), now() - (n || ' seconds')::interval
     FROM (SELECT n, ${uuid("200000 + 1 + n % " + NEW_ACCOUNTS)} AS a, ((n / ${NEW_ACCOUNTS}) * 157 + (n % ${NEW_ACCOUNTS}) * 13) % ${PRESALES} AS p
       FROM generate_series(1, ${STARS}) n WHERE 1 + n % ${NEW_ACCOUNTS} <> 7) s
     ON CONFLICT DO NOTHING`,
  );
  await admin.query(
    `INSERT INTO social_watchlist (account_id, presale_id, created_at)
     SELECT ${uuid("200000 + 7")}, '0x' || lpad('5a1e' || to_hex(p), 64, '0'), now() - (p || ' seconds')::interval
     FROM generate_series(0, 499) p ON CONFLICT DO NOTHING`,
  );
  // Follows (UI-12b): 70k between accounts, 30k of presales spread over the
  // accounts, and the account at the star limit following every sale (its
  // card: 500 stars, then the rest of the sales).
  await admin.query(
    `INSERT INTO social_follows (follower_account_id, target_kind, target_id, source, created_at)
     SELECT ${uuid("200000 + 1 + n % " + NEW_ACCOUNTS)}, 'account', ${uuid("200000 + 1 + (n * 31 + n / " + NEW_ACCOUNTS + ") % " + NEW_ACCOUNTS)}::text,
       'user', now() - (n || ' seconds')::interval
     FROM generate_series(1, ${ACCOUNT_FOLLOWS}) n ON CONFLICT DO NOTHING`,
  );
  await admin.query(
    `INSERT INTO social_follows (follower_account_id, target_kind, target_id, source, created_at)
     SELECT ${uuid("200000 + 1 + n % " + NEW_ACCOUNTS)}, 'presale', '0x' || lpad('5a1e' || to_hex(((n / ${NEW_ACCOUNTS}) * 211 + (n % ${NEW_ACCOUNTS}) * 7) % ${PRESALES}), 64, '0'),
       'user', now() - (n || ' seconds')::interval
     FROM generate_series(1, ${PRESALE_FOLLOWS}) n WHERE 1 + n % ${NEW_ACCOUNTS} <> 7 ON CONFLICT DO NOTHING`,
  );
  await admin.query(
    `INSERT INTO social_follows (follower_account_id, target_kind, target_id, source, created_at)
     SELECT ${uuid("200000 + 7")}, 'presale', '0x' || lpad('5a1e' || to_hex(p), 64, '0'), 'user', now() - (p || ' seconds')::interval
     FROM generate_series(0, ${PRESALES - 1}) p ON CONFLICT DO NOTHING`,
  );
  // Flush the trigram indexes' pending lists (bulk-loaded here; production inserts trickle in) and gather statistics.
  await admin.query("VACUUM ANALYZE");
  const counts = await admin.query(`SELECT (SELECT count(*) FROM mission_control_profiles) members, (SELECT count(*) FROM social_accounts) accounts,
    (SELECT count(*) FROM social_account_search) searchable, (SELECT count(*) FROM chain_read_v1.presales) presales,
    (SELECT count(*) FROM social_watchlist) stars, (SELECT count(*) FROM social_watchlist WHERE account_id = ${uuid("200007")}) heavy,
    (SELECT count(*) FROM social_follows) follows, (SELECT count(*) FROM social_follows WHERE target_kind = 'presale') presale_follows,
    (SELECT count(*) FROM social_follows WHERE follower_account_id = ${uuid("200007")}) heavy_follows`);
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

/** One statement under EXPLAIN (ANALYZE): planning + execution per run (3 warm-ups), and its plan once. */
async function explained(pool: pg.Pool, label: string, text: string, values: unknown[], plans: Record<string, string>): Promise<Timing> {
  const samples: number[] = [];
  for (let i = 0; i < RUNS + 3; i += 1) {
    const { rows } = await pool.query<{ "QUERY PLAN": [{ "Planning Time": number; "Execution Time": number }] }>(
      `EXPLAIN (ANALYZE, FORMAT JSON) ${text}`, values,
    );
    const [plan] = rows[0]!["QUERY PLAN"];
    if (i >= 3) samples.push(plan["Planning Time"] + plan["Execution Time"]);
  }
  const text_ = await pool.query<{ "QUERY PLAN": string }>(`EXPLAIN (ANALYZE, BUFFERS) ${text}`, values);
  plans[label] = text_.rows.map((row) => row["QUERY PLAN"]).join("\n");
  return summarize(label, samples);
}

/** A whole read as the route runs it (wall time, all statements). */
async function timed(label: string, run: (i: number) => Promise<unknown>): Promise<Timing> {
  const samples: number[] = [];
  for (let i = 0; i < RUNS + 3; i += 1) {
    const start = performance.now();
    // react-doctor-disable-next-line react-doctor/async-await-in-loop -- Measure benchmark cases and warm-up samples serially; overlapping queries would contaminate their latency.
    await run(i);
    if (i >= 3) samples.push(performance.now() - start);
  }
  return summarize(label, samples);
}

async function benchSearchStatements(replicaPool: pg.Pool, timings: Timing[], plans: Record<string, string>): Promise<void> {
  const people = (term: string) => {
    const like = likeLiteral(term);
    return [`%${like}%`, term, `${like}%`, `% ${like}%`];
  };
  const presales = (term: string) => {
    const like = likeLiteral(term);
    return [`%${like}%`, term, `${like}%`, NOW];
  };
  // Statements (EXPLAIN ANALYZE, as the replica role).
  for (const raw of ["a", "lu", "luc", "luca", "romano", "luca rom", "@luca_romano12", "nova 1", "zzzz"]) {
    const term = normalizeSearchQuery(raw)!;
    const short = [...term].length < PEOPLE_CONTAINS_MIN;
    const like = likeLiteral(term);
    timings.push(await explained(
      replicaPool,
      `search people "${raw}"${short ? " (word starts)" : ""}`,
      short ? SEARCH_SQL.peoplePrefix : SEARCH_SQL.people,
      short ? [term, `${like}%`, `% ${like}%`] : people(term),
      plans,
    ));
  }
  timings.push(await explained(replicaPool, "search people: suggestions (default accounts)", SEARCH_SQL.suggestedPeople, [], plans));
  for (const raw of ["m", "me", "meridian", "prism 12", "zzzz"]) {
    timings.push(await explained(replicaPool, `search presales "${raw}" (${PRESALES} sales)`, SEARCH_SQL.presales, presales(normalizeSearchQuery(raw)!), plans));
  }
  timings.push(await explained(replicaPool, `search presales: suggestions (${PRESALES} sales)`, SEARCH_SQL.suggestedPresales, [NOW], plans));
}

async function bench() {
  const replicaPool = new pg.Pool({ connectionString: urlAs(URL_, "blast_replica"), max: 4 });
  const webPool = new pg.Pool({ connectionString: urlAs(URL_, "blast_web"), max: 4 });
  const replica = autocommitReader(replicaPool, "social");
  const web = autocommitReader(webPool, "social");
  const timings: Timing[] = [];
  const plans: Record<string, string> = {};
  await benchSearchStatements(replicaPool, timings, plans);
  // Whole reads.
  const terms = ["", "a", "lu", "luca", "romano", "me", "zzzz"];
  timings.push(await timed("search route read (watermark + presales + people), mixed terms (replica)", (i) => readSearch(replica, terms[i % terms.length]!, NOW)));
  const heavy = "00000000-0000-4000-8000-" + (200007).toString(16).padStart(12, "0");
  const typical = "00000000-0000-4000-8000-" + (200100).toString(16).padStart(12, "0");
  timings.push(await timed("watchlist ids, account at the limit (500) (primary)", () => readWatchlistIds(web, heavy)));
  timings.push(await timed("watchlist first page (20), account at the limit (primary)", () => readWatchlistPage(web, heavy, { limit: 20, cursor: null, includeFollows: false }, NOW)));
  const deep = await readWatchlistPage(web, heavy, { limit: 50, cursor: null, includeFollows: false }, NOW);
  let cursor = deep.next_cursor;
  for (let page = 0; page < 7 && cursor; page += 1) {
    const { decodeWatchlistCursor } = await import("@blast/server/modules/social/watchlist/route.ts");
    cursor = (await readWatchlistPage(web, heavy, { limit: 50, cursor: decodeWatchlistCursor(cursor), includeFollows: false }, NOW)).next_cursor;
  }
  const { decodeWatchlistCursor } = await import("@blast/server/modules/social/watchlist/route.ts");
  const deepCursor = cursor ? decodeWatchlistCursor(cursor) : null;
  timings.push(await timed("watchlist deep page (50 after 400), account at the limit (primary)", () => readWatchlistPage(web, heavy, { limit: 50, cursor: deepCursor, includeFollows: false }, NOW)));
  timings.push(await timed("watchlist first page (20), typical account (primary)", () => readWatchlistPage(web, typical, { limit: 20, cursor: null, includeFollows: false }, NOW)));
  // UI-12b (OA-17): the card's read, stars then followed sales not starred.
  const entries = (account: string, part: number | null, atUs: string | null, presaleId: string | null, limit: number) =>
    [account, true, part, atUs, presaleId, limit];
  timings.push(await explained(webPool, "watchlist+follows entries and total (11), heavy: 500 stars + every sale followed", WATCHLIST_ENTRIES_SQL, entries(heavy, null, null, null, 11), plans));
  timings.push(await explained(webPool, "watchlist+follows entries and total (11), typical account", WATCHLIST_ENTRIES_SQL, entries(typical, null, null, null, 11), plans));
  const card = (account: string) => readWatchlistPage(web, account, { limit: 10, cursor: null, includeFollows: true }, NOW);
  timings.push(await timed("watchlist+follows card read (10), heavy (primary)", () => card(heavy)));
  timings.push(await timed("watchlist+follows card read (10), typical account (primary)", () => card(typical)));
  // Deep into the follows: 50 after 1,000 (past the 500 stars).
  let follows: string | null = null;
  for (let page = 0; page < 20; page += 1) {
    follows = (await readWatchlistPage(web, heavy, { limit: 50, cursor: follows ? decodeWatchlistCursor(follows) : null, includeFollows: true }, NOW)).next_cursor;
  }
  const followsCursor = follows ? decodeWatchlistCursor(follows) : null;
  if (!followsCursor?.followed) throw new Error("expected a cursor among the followed sales");
  timings.push(await explained(webPool, "watchlist+follows entries (51) after 1,000, heavy (in the follows)", WATCHLIST_ENTRIES_SQL,
    entries(heavy, 1, followsCursor.atUs, followsCursor.presaleId, 51), plans));
  timings.push(await timed("watchlist+follows deep page (50 after 1,000), heavy (primary)", () =>
    readWatchlistPage(web, heavy, { limit: 50, cursor: followsCursor, includeFollows: true }, NOW)));
  const sale = (n: number) => `0x${("5a1e" + (1000 + n).toString(16)).padStart(64, "0")}`;
  timings.push(await timed("watchlist star (lock, count, insert; one transaction) (primary)", (i) =>
    withTransaction(webPool, (transaction) => star(transaction.forModule("social"), typical, sale(i)))));
  timings.push(await timed("watchlist unstar (one transaction) (primary)", (i) =>
    withTransaction(webPool, (transaction) => unstar(transaction.forModule("social"), typical, sale(i)))));
  timings.push(await timed("watchlist star at the limit (refused) (primary)", async (i) => {
    await withTransaction(webPool, (transaction) => star(transaction.forModule("social"), heavy, sale(600 + i))).catch(() => undefined);
  }));
  fs.mkdirSync("loadtest/results", { recursive: true });
  fs.writeFileSync("loadtest/results/social-search-scale-timings.json", JSON.stringify({ at: new Date().toISOString(), presales: PRESALES, runs: RUNS, timings }, null, 1));
  fs.writeFileSync("loadtest/results/social-search-scale-plans.txt", Object.entries(plans).map(([label, plan]) => `## ${label}\n${plan}\n`).join("\n"));
  await Promise.all([replicaPool.end(), webPool.end()]);
}

const command = process.argv[2];
if (command === "seed") await seed();
else if (command === "bench") await bench();
else throw new Error("usage: social-search-scale.ts seed|bench");
