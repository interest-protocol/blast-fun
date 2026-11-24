import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import test from "node:test";
import pg from "pg";

import { autocommitReader, type ReadableDatabase } from "@blast/core/modules/database/transaction.ts";
import { urlAs } from "../../../../../core/test/fixtures/modules/database/role-fixtures.ts";
import { freshTestDatabase } from "../../../../../core/test/fixtures/modules/database/template.ts";
import { SIZE, HUB, accountId, seedLargeLists } from "../../../../../core/test/fixtures/modules/social/follows/large-connections.ts";
import type { ConnectionTab } from "@blast/core/modules/social/contracts/connections.ts";
import { parseConnectionQuery, readConnectionCounts, readConnections } from "@blast/server/modules/social/profiles/connections.ts";

const databaseUrl = process.env.MISSION_CONTROL_TEST_DATABASE_URL;
const BASE = "https://blast.fun/api/social/profiles/hub/connections";
const migration = (direction: "up" | "down", name = "0114_social_connection_pages") => readFile(new URL(`../../../../../../packages/core/src/modules/database/migrations/${name}.${direction}.sql`, import.meta.url), "utf8");
type Plan = { "Node Type": string; "Relation Name"?: string; "Index Name"?: string; "Index Cond"?: string; "Actual Rows": number; "Actual Loops"?: number; "Rows Removed by Filter"?: number; Plans?: Plan[] };
type Explanation = { Plan: Plan; "Planning Time": number; "Execution Time": number };
type Statement = { sql: string; values: readonly unknown[] };

function nodes(plan: Plan): Plan[] {
  return [plan, ...(plan.Plans ?? []).flatMap(nodes)];
}

test("100k connections: indexed first/deep pages, separate exact counts and live privacy", { skip: !databaseUrl, timeout: 180_000 }, async (t) => {
  const database = await freshTestDatabase();
  const admin = new pg.Pool({ connectionString: database.url, max: 1 });
  const web = new pg.Pool({ connectionString: urlAs(database.url, "blast_web"), max: 1 });
  t.after(async () => { await web.end(); await admin.end(); await database.drop(); });
  await seedLargeLists(admin);
  const reader = autocommitReader(web, "social");
  let statement: Statement | undefined;
  const db: ReadableDatabase = { read(sql, values = []) {
    statement = { sql, values };
    return reader.read(sql, values);
  } };
  const page = (tab: ConnectionTab, before: readonly [string, string] | null = null, viewer: string | null = null, q = "") =>
    readConnections(db, "hub", viewer, { tab, before, q, limit: 50 });
  const evidence: Record<string, Explanation[]> = {};
  async function explain(label: string, query: Statement): Promise<Explanation> {
    const samples: Explanation[] = [];
    for (let run = 0; run < 5; run++) {
      const result = await web.query<{ "QUERY PLAN": Explanation[] }>(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${query.sql}`, [...query.values]);
      samples.push(result.rows[0]!["QUERY PLAN"][0]!);
    }
    evidence[label] = samples;
    if (process.env.CONNECTION_SCALE_REPORT) await writeFile(process.env.CONNECTION_SCALE_REPORT, JSON.stringify({ accounts: SIZE + 1, accountRelationships: SIZE * 2, evidence }, null, 2));
    t.diagnostic(`${label}: execution ms ${samples.map((sample) => sample["Execution Time"].toFixed(2)).join(", ")}`);
    return samples.at(-1)!;
  }

  assert.deepEqual(await readConnectionCounts(db, "hub", null), { followers: 90_000, following: 90_000 });
  assert.ok(statement);
  assert.doesNotMatch(statement.sql, /social_account_identities|ORDER BY/);
  const countsPlan = await explain("counts-public", statement);
  const accountWork = (plan: Explanation) => nodes(plan.Plan)
    .filter((node) => node["Relation Name"] === "social_accounts")
    .reduce((total, node) => total + (node["Actual Rows"] + (node["Rows Removed by Filter"] ?? 0)) * (node["Actual Loops"] ?? 1), 0);
  assert.ok(accountWork(countsPlan) <= SIZE + 5, "counts must share one account pass across both directions");
  assert.deepEqual(await readConnectionCounts(db, "hub", HUB), { followers: 90_000, following: SIZE });
  assert.ok(accountWork(await explain("counts-owner", statement!)) <= SIZE + 5, "owner counts must share one account pass");
  // Account targets have no foreign key: even owners must not count missing accounts.
  const missing = "00000000-0000-4000-8000-ffffffffffff";
  await admin.query("INSERT INTO social_follows (follower_account_id, target_kind, target_id, source) VALUES ($1, 'account', $2, 'user')", [HUB, missing]);
  assert.deepEqual(await readConnectionCounts(db, "hub", null), { followers: 90_000, following: 90_000 });
  assert.deepEqual(await readConnectionCounts(db, "hub", HUB), { followers: 90_000, following: SIZE });
  await admin.query("DELETE FROM social_follows WHERE follower_account_id=$1 AND target_kind='account' AND target_id=$2", [HUB, missing]);

  for (const tab of ["followers", "following"] as const) {
    const first = await page(tab);
    assert.equal(first.accounts.length, 50);
    assert.ok(first.next_cursor);
    assert.ok(first.accounts.every((account) => !account.private));
    assert.deepEqual(Object.keys(first).sort(), ["accounts", "next_cursor"]);
    const next = parseConnectionQuery(new URL(`${BASE}?tab=${tab}&cursor=${first.next_cursor}`), "hub");
    const second = await page(tab, next.before);
    assert.equal(second.accounts.length, 50);
    assert.equal(new Set([...first.accounts, ...second.accounts].map((account) => account.callsign)).size, 100);
    const final = await page(tab, ["2026-10-14T12:00:00.123456Z", accountId(6)]);
    assert.deepEqual(final.accounts.map((account) => account.callsign), ["person5", "person4", "person3", "person2", "person1"]);
    assert.equal(final.next_cursor, null);
    // Jump past 90k relationships, with timestamp ties, without walking prior pages.
    for (const [label, before] of [["first", null], ["deep", ["2026-10-14T12:01:40.123456Z", accountId(10_001)]]] as const) {
      const result = await page(tab, before);
      assert.equal(result.accounts.length, 50);
      assert.ok(statement);
      assert.doesNotMatch(statement.sql, /count\(|MATERIALIZED|UNION ALL/);
      const plan = await explain(`${tab}-${label}`, statement);
      const all = nodes(plan.Plan);
      const index = all.find((node) => node["Index Name"] === `social_follows_${tab}_page_idx`);
      assert.ok(index, JSON.stringify(plan));
      assert.ok(index["Actual Rows"] <= 100, JSON.stringify(plan));
      assert.ok(!all.some((node) => node["Node Type"] === "Seq Scan" && node["Relation Name"] === "social_accounts"), "the bounded profile lookup must not scan all accounts");
      assert.ok(!all.some((node) => node["Node Type"] === "Sort" && nodes(node).some((child) => child["Relation Name"] === "social_follows")), "pages must not sort the entire follow list");
      if (before) assert.match(index["Index Cond"] ?? "", /ROW/);
    }
  }

  // Owner visibility changes only following; private actors stay hidden from recipients.
  const own = await page("following", null, HUB);
  assert.ok(own.accounts.some((account) => account.private));
  assert.ok((await page("followers", null, HUB)).accounts.every((account) => !account.private));
  assert.deepEqual((await page("following", null, null, "person99990")).accounts, []);
  assert.equal((await page("following", null, HUB, "person99990")).accounts[0]?.private, true);
  const sparse = await explain("search-private-owner", statement!);
  assert.ok(nodes(sparse.Plan).filter((node) => node["Relation Name"] === "social_follows")
    .every((node) => node["Actual Rows"] * (node["Actual Loops"] ?? 1) <= 256), "sparse search must start from matches rather than walk the follow list");
  assert.deepEqual((await page("followers", null, null, "no_match_anywhere")).accounts, []);
  const noMatch = await explain("search-no-match", statement!);
  assert.ok(nodes(noMatch.Plan).filter((node) => node["Relation Name"] === "social_follows")
    .every((node) => node["Actual Rows"] * (node["Actual Loops"] ?? 1) <= 256), "no-match search must not walk the follow list");

  for (const tab of ["followers", "following"] as const) {
    assert.deepEqual((await page(tab, null, null, "person12345")).accounts.map((account) => account.callsign), ["person12345"]);
    const sparsePlan = await explain(`${tab}-search-sparse`, statement!);
    assert.ok(nodes(sparsePlan.Plan).filter((node) => node["Relation Name"] === "social_follows")
      .every((node) => node["Actual Rows"] * (node["Actual Loops"] ?? 1) <= 256));
    const broad = await page(tab, null, null, "person9");
    assert.equal(broad.accounts.length, 50);
    assert.ok(broad.next_cursor);
    const broadPlan = await explain(`${tab}-search-broad`, statement!);
    assert.ok(nodes(broadPlan.Plan).filter((node) => node["Relation Name"] === "social_follows")
      .every((node) => node["Actual Rows"] * (node["Actual Loops"] ?? 1) <= 512), "broad search must retain a bounded ordered page");
    const next = parseConnectionQuery(new URL(`${BASE}?tab=${tab}&q=person9&cursor=${broad.next_cursor}`), "hub");
    const more = await page(tab, next.before, null, "person9");
    assert.equal(more.accounts.length, 50);
    assert.equal(new Set([...broad.accounts, ...more.accounts].map((account) => account.callsign)).size, 100);
  }

  // A common global term must not trigger 100k membership probes for a tiny list.
  for (const tab of ["followers", "following"] as const) {
    assert.deepEqual((await readConnections(db, "person1", null, { tab, before: null, q: "person", limit: 50 })).accounts, []);
    const small = await explain(`${tab}-small-list-global-match`, statement!);
    assert.ok(nodes(small.Plan).filter((node) => node["Relation Name"] === "social_follows")
      .every((node) => node["Actual Rows"] * (node["Actual Loops"] ?? 1) <= 2), "small lists must not probe every unrelated global match");
  }

  // Hide a previously public row after a cursor was issued.
  const first = await page("followers");
  const cursor = parseConnectionQuery(new URL(`${BASE}?tab=followers&cursor=${first.next_cursor}`), "hub").before;
  const next = await page("followers", cursor);
  const hidden = next.accounts[0]!.callsign;
  await admin.query("UPDATE social_accounts SET privacy='private', sharing_since=NULL WHERE callsign=$1", [hidden]);
  assert.ok(!(await page("followers", cursor)).accounts.some((account) => account.callsign === hidden));
  assert.deepEqual(await readConnectionCounts(db, "hub", null), { followers: 89_999, following: 89_999 });
  let lookups = 0;
  const privacyChangedDuringLookup: ReadableDatabase = {
    async read<Row extends pg.QueryResultRow>(sql: string, values?: readonly unknown[]) {
      const result = await reader.read<Row>(sql, values);
      if (++lookups === 1) await admin.query("UPDATE social_accounts SET privacy='private', sharing_since=NULL WHERE account_id=$1", [HUB]);
      return result;
    },
  };
  await assert.rejects(() => readConnectionCounts(privacyChangedDuringLookup, "hub", null), { code: "not_found" });
  await assert.rejects(() => page("followers", cursor), { code: "not_found" });
  await assert.rejects(() => readConnectionCounts(db, "hub", null), { code: "not_found" });
  assert.equal((await readConnectionCounts(db, "hub", HUB)).following, SIZE);
  await admin.query("UPDATE social_accounts SET privacy='public' WHERE account_id=$1", [HUB]);

  // Rehearse rollback and show the same query's work without the new indexes.
  await page("followers");
  const withoutIndexes = statement!;
  await admin.query(await migration("down"));
  await explain("followers-first-without-page-indexes", withoutIndexes);
  await admin.query(await migration("up"));
  assert.equal((await page("followers")).accounts.length, 50);
  await admin.query(await migration("down", "0115_social_connection_search"));
  assert.equal((await page("following", null, HUB, "person99990")).accounts[0]?.private, true);
  await admin.query(await migration("up", "0115_social_connection_search"));
  assert.equal((await page("following", null, HUB, "person99990")).accounts[0]?.private, true);
  const searchIndex = await admin.query("SELECT pg_get_indexdef('social_accounts_connection_search_trgm_idx'::regclass) AS definition");
  t.diagnostic(`migration 0115 rollback/reapply: ${searchIndex.rows[0]!.definition}`);
});
