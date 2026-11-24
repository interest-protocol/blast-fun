import assert from "node:assert/strict";
import test from "node:test";

import type { Pool } from "pg";

import { CREATE_TEST_SUI_QUOTE_TYPE } from "@blast/core/modules/social/contracts/create.ts";
import { CursorError, encodeCursor } from "@blast/core/modules/launchpad-contract/cursor.ts";
import { SocialQueryError, searchText } from "@blast/server/modules/launchpad-social/contracts.ts";
import { listLaunchTheses, searchTheses, thesisSearchCursorShape } from "@blast/server/modules/launchpad-social/reads.ts";
import { createPool, createRuntimePool } from "@blast/core/modules/database/pool.ts";
import {
  FIXTURE_CHECKPOINT,
  FIXTURE_FINGERPRINT,
  FIXTURE_NETWORK,
  advanceWatermark,
  urlAs,
} from "../../../../core/test/fixtures/modules/database/role-fixtures.ts";
import { freshTestDatabase } from "../../../../core/test/fixtures/modules/database/template.ts";
import { autocommitReader } from "@blast/core/modules/database/transaction.ts";
import { measureChainPosition, type ChainJoinDependencies } from "@blast/server/modules/read-routing/chain-join.ts";
import { parseSearchQuery } from "@blast/server/modules/launchpad-search/query.ts";
import type { LaunchMatch } from "@blast/core/modules/launchpad-search/contracts.ts";
import type { LaunchGroup } from "@blast/core/modules/launchpad-search/contracts.ts";
import { searchCursorShape, searchLaunchGroup } from "@blast/server/modules/launchpad-search/reads.ts";
import { databaseSearchSources, handleSearchRequest } from "@blast/server/modules/launchpad-search/resource.ts";

const databaseUrl = process.env.MISSION_CONTROL_TEST_DATABASE_URL;
const skip = databaseUrl ? false : "MISSION_CONTROL_TEST_DATABASE_URL is not set";

const EXPECTED = { network: FIXTURE_NETWORK, deployment: FIXTURE_FINGERPRINT } as const;
const SUI = "0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI";

function objectId(label: number): string {
  return `0x${label.toString(16).padStart(64, "0")}`;
}

const WALLET_1 = objectId(0xe1);
const WALLET_2 = objectId(0xe2);

type LaunchSpec = Readonly<{
  label: number;
  name: string | null;
  symbol: string | null;
  createdAtMs: number;
  creator?: string | null;
  lifecycle?: "opening_round" | "live" | "migration_ready" | "migrated";
  /** A migration pool of this venue, its ID `objectId(label + 0x1000)`. */
  migratedTo?: "cetus" | "bluefin";
  /** No curve pool: blast-infra lists the coin but it is no launch. */
  noCurve?: boolean;
}>;

function launchId(label: number) {
  return objectId(label);
}

function coinType(label: number) {
  return `${objectId(label + 0x100)}::coin${label}::COIN${label}`;
}

function migrationPoolId(label: number) {
  return objectId(label + 0x1000);
}

async function insertLaunches(admin: Pool, launches: readonly LaunchSpec[]) {
  for (const launch of launches) {
    const metadata = launch.name === null && launch.symbol === null
      ? null
      : JSON.stringify({ name: launch.name, symbol: launch.symbol, icon_url: `https://i/${launch.label}.png` });
    const curve = `blast_curve:${launchId(launch.label)}`;
    const creator = launch.creator === undefined ? WALLET_1 : launch.creator;
    await admin.query(
      `INSERT INTO coins (coin_type, decimals, launcher, creator, metadata, pool_key, created_checkpoint, created_at_ms)
       VALUES ($1, 9, $2, $3, $4, $5, 900, $6)`,
      [coinType(launch.label), creator ?? WALLET_2, creator, metadata, launch.noCurve ? null : curve, launch.createdAtMs],
    );
    if (!launch.noCurve) {
      await admin.query(
        `INSERT INTO pools (pool_key, venue, coin_type, quote_type, lifecycle, created_checkpoint, created_at_ms)
         VALUES ($1, 'blast_curve', $2, $3, $4, 900, $5)`,
        [curve, coinType(launch.label), SUI, launch.lifecycle ?? "live", launch.createdAtMs],
      );
    }
    if (launch.migratedTo) {
      await admin.query(
        `INSERT INTO pools (pool_key, venue, coin_type, quote_type, lifecycle, created_checkpoint, created_at_ms)
         VALUES ($1, $2, $3, $4, 'active', 950, $5)`,
        [`${launch.migratedTo}:${migrationPoolId(launch.label)}`, launch.migratedTo, coinType(launch.label), SUI, launch.createdAtMs + 5_000],
      );
    }
  }
}

interface Harness {
  admin: Pool;
  web: Pool;
  replica: Pool;
}

async function withHarness(launches: readonly LaunchSpec[], body: (harness: Harness) => Promise<void>): Promise<void> {
  const database = await freshTestDatabase();
  const admin = createPool(database.url, { max: 2 });
  await insertLaunches(admin, launches);
  const settings = {
    connectionTimeoutMs: 2_000,
    idleInTransactionMs: 5_000,
    idleTimeoutMs: 1_000,
    lockTimeoutMs: 1_000,
    max: 4,
    statementTimeoutMs: 4_000,
  };
  // Reads run as the replica role, with the web role as the primary, as in production.
  const web = createRuntimePool(urlAs(database.url, "blast_web"), settings);
  const replica = createRuntimePool(urlAs(database.url, "blast_replica"), settings, "blast-replica");
  try {
    await body({ admin, web, replica });
  } finally {
    await Promise.all([admin.end(), web.end(), replica.end()]);
    await database.drop();
  }
}

async function chainJoin(harness: Harness, ageMs = 0): Promise<ChainJoinDependencies> {
  await harness.admin.query(advanceWatermark(FIXTURE_CHECKPOINT, ageMs));
  return {
    replica: autocommitReader(harness.replica, "chain-read"),
    primary: autocommitReader(harness.web, "chain-read"),
    position: (source) => measureChainPosition(source === "replica" ? harness.replica : harness.web, source),
    now: Date.now,
    requireRecovery: false,
    expected: EXPECTED,
  };
}

async function page(
  harness: Harness,
  group: LaunchGroup,
  raw: string,
  request: Readonly<{ limit?: number; cursor?: string | null }> = {},
) {
  const answer = await searchLaunchGroup(group, parseSearchQuery(raw), { limit: request.limit ?? 25, cursor: request.cursor ?? null }, await chainJoin(harness));
  assert.equal(answer.status, "fresh");
  assert.equal(answer.provenance.source, "replica");
  assert.ok("data" in answer);
  return answer.data;
}

/** `[launch label, match]` per item, in served order. */
async function matches(harness: Harness, group: LaunchGroup, raw: string) {
  const data = await page(harness, group, raw);
  return data.items.map((item) => [item.launch.launchId, item.match]);
}

test("exact identifiers find their canonical launch and name the identifier they matched", { skip }, async () => {
  await withHarness([
    { label: 0xa1, name: "Alpha", symbol: "ALPHA", createdAtMs: 1_790_000_001_000 },
    { label: 0xa2, name: "Alpha", symbol: "ALPHA", createdAtMs: 1_790_000_002_000, creator: WALLET_2, lifecycle: "migrated", migratedTo: "cetus" },
    { label: 0xa3, name: null, symbol: null, createdAtMs: 1_790_000_003_000 },
  ], async (harness) => {
    assert.deepEqual(await matches(harness, "coins", coinType(0xa3)), [[launchId(0xa3), "coin_type"]], "a coin without metadata is found by its type");
    assert.deepEqual(await matches(harness, "onchain", launchId(0xa2)), [[launchId(0xa2), "launch_id"]]);
    const pool = await page(harness, "onchain", migrationPoolId(0xa2).toUpperCase().replace("0X", "0x"));
    assert.deepEqual(pool.items.map((item) => [item.launch.launchId, item.match, item.pool]), [
      [launchId(0xa2), "pool_id", { venue: "cetus", poolId: migrationPoolId(0xa2) }],
    ]);
    // A wallet lists the launches it created, newest first.
    assert.deepEqual(await matches(harness, "wallets", WALLET_1), [[launchId(0xa3), "creator"], [launchId(0xa1), "creator"]]);
    assert.deepEqual(await matches(harness, "wallets", objectId(0xe9)), []);
    assert.deepEqual(await matches(harness, "onchain", coinType(0xa1).split("::")[0]), [], "a coin's package is no launch or pool ID");

    const [graduated] = (await page(harness, "onchain", launchId(0xa2))).items;
    assert.deepEqual(graduated.launch, {
      launchId: launchId(0xa2),
      coinType: coinType(0xa2),
      name: "Alpha",
      symbol: "ALPHA",
      iconUrl: `https://i/${0xa2}.png`,
      lifecycle: "migrated",
      creator: WALLET_2,
      createdAtMs: 1_790_000_002_000,
    }, "identity, lifecycle and creator come from the chain views");
  });
});

test("text matches the ticker, then the name, then every word, newest first; duplicates keep a fixed order", { skip }, async () => {
  const same = 1_790_000_005_000;
  await withHarness([
    { label: 0xb1, name: "Pepe", symbol: "PEPE", createdAtMs: same },
    { label: 0xb2, name: "Pepe", symbol: "PEPE", createdAtMs: same, creator: WALLET_2, lifecycle: "migrated" },
    { label: 0xb3, name: "Pepe Classic", symbol: "PEPEC", createdAtMs: same + 2_000 },
    { label: 0xb4, name: "ＰＥＰＥ", symbol: "FROG", createdAtMs: same - 9_000, lifecycle: "opening_round" },
    { label: 0xb5, name: "Super  Pepe", symbol: "SPEPE", createdAtMs: same + 1_000 },
    { label: 0xb6, name: "Pepperoni", symbol: "PEP", createdAtMs: same + 3_000 },
    { label: 0xb7, name: null, symbol: null, createdAtMs: same + 4_000 },
  ], async (harness) => {
    assert.deepEqual(await matches(harness, "coins", "  pepe "), [
      [launchId(0xb1), "ticker"],
      [launchId(0xb2), "ticker"],
      [launchId(0xb4), "name"],
      [launchId(0xb3), "words"],
      [launchId(0xb5), "words"],
    ], "equal tier and time order by launch ID; 'pepe' is no prefix of 'pepperoni'");
    assert.deepEqual(await matches(harness, "coins", "super pe"), [[launchId(0xb5), "words"]], "every word must start a word");
    assert.deepEqual(await matches(harness, "coins", "Super Pepe"), [[launchId(0xb5), "name"]], "a name equal in search form");
    assert.deepEqual(await matches(harness, "coins", "frog"), [[launchId(0xb4), "ticker"]]);

    const duplicates = (await page(harness, "coins", "PEPE")).items.slice(0, 2).map((item) => item.launch);
    assert.deepEqual(duplicates.map(({ launchId: id, lifecycle, creator }) => [id, lifecycle, creator]), [
      [launchId(0xb1), "live", WALLET_1],
      [launchId(0xb2), "migrated", WALLET_2],
    ], "duplicates stay distinguishable by launch ID, lifecycle and creator");
  });
});

test("pages resume after their last match without repeating or skipping equal tiers and times", { skip }, async () => {
  const same = 1_790_000_007_000;
  const toads = [0xc5, 0xc1, 0xc4, 0xc2, 0xc3].map((label) => ({ label, name: "Toad", symbol: "TOAD", createdAtMs: same }));
  await withHarness([
    ...toads,
    { label: 0xc6, name: "Toad Two", symbol: "TOAD2", createdAtMs: same },
    { label: 0xc7, name: "Toad Older", symbol: "TOADO", createdAtMs: same - 1 },
  ], async (harness) => {
    const whole = (await page(harness, "coins", "toad")).items.map((item) => item.launch.launchId);
    assert.deepEqual(whole, [0xc1, 0xc2, 0xc3, 0xc4, 0xc5, 0xc6, 0xc7].map(launchId));

    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const data = await page(harness, "coins", "toad", { limit: 2, cursor });
      seen.push(...data.items.map((item) => item.launch.launchId));
      cursor = data.nextCursor;
      pages += 1;
      if (pages === 1) {
        // A launch created between pages that sorts before the position is not repeated or shifted in.
        await insertLaunches(harness.admin, [{ label: 0xc0, name: "Toad", symbol: "TOAD", createdAtMs: same }]);
      }
    } while (cursor && pages < 10);
    assert.deepEqual(seen, whole);
    assert.equal(pages, 4);

    const first = await page(harness, "coins", "toad", { limit: 2 });
    assert.ok(first.nextCursor);
    for (const [group, raw] of [["coins", "toad two"], ["onchain", launchId(0xc1)]] as const) {
      await assert.rejects(
        searchLaunchGroup(group, parseSearchQuery(raw), { limit: 2, cursor: first.nextCursor }, await chainJoin(harness)),
        CursorError,
        "a token belongs to its group and query",
      );
    }
    await assert.rejects(
      searchLaunchGroup("wallets", parseSearchQuery("toad"), { limit: 2, cursor: null }, await chainJoin(harness)),
      SocialQueryError,
      "a text search has no wallet group",
    );
  });
});

test("a coin without a curve is no launch, and a lagging replica is stale then unavailable", { skip }, async () => {
  await withHarness([
    { label: 0xd1, name: "Ghost", symbol: "GHOST", createdAtMs: 1_790_000_009_000, noCurve: true },
    { label: 0xd2, name: "Ghost", symbol: "GHOST", createdAtMs: 1_790_000_009_000, noCurve: true, migratedTo: "bluefin" },
    { label: 0xd3, name: "Ghost", symbol: "GHOST", createdAtMs: 1_790_000_009_000 },
  ], async (harness) => {
    assert.deepEqual(await matches(harness, "coins", "ghost"), [[launchId(0xd3), "ticker"]]);
    assert.deepEqual(await matches(harness, "coins", coinType(0xd1)), []);
    assert.deepEqual(await matches(harness, "onchain", migrationPoolId(0xd2)), [], "a pool of a coin without a curve");
    assert.deepEqual(await matches(harness, "onchain", launchId(0xd1)), []);

    const stale = await searchLaunchGroup("coins", parseSearchQuery("ghost"), { limit: 5, cursor: null }, await chainJoin(harness, 30_000));
    assert.equal(stale.status, "stale");
    const gone = await searchLaunchGroup("coins", parseSearchQuery("ghost"), { limit: 5, cursor: null }, await chainJoin(harness, 600_000));
    assert.equal(gone.status, "unavailable");
    assert.ok(!("data" in gone));
  });
});

const AUTHOR = "00000000-0000-4000-8000-0000000000aa";

function recordId(label: number) {
  return `00000000-0000-4000-8000-${label.toString(16).padStart(12, "0")}`;
}

type PostSpec = Readonly<{
  label: number;
  launch: string;
  body: string;
  at: string;
  hidden?: boolean;
  revises?: number;
  /** Keep a search row the write path would have removed, to prove the read refuses it anyway. */
  strayRow?: boolean;
}>;

/** Posts as the T-028 write path stores them (author, record, search row), written directly. */
async function insertPosts(admin: Pool, posts: readonly PostSpec[]) {
  await admin.query(
    `INSERT INTO mission_control_launchpad_social_authors (author_identity_id, author_method, author_wallet)
     VALUES ($1, 'wallet_proof', $2) ON CONFLICT DO NOTHING`,
    [AUTHOR, WALLET_2],
  );
  for (const post of posts) {
    const original = post.revises === undefined ? null : posts.find((other) => other.label === post.revises);
    await admin.query(
      `INSERT INTO mission_control_launchpad_theses (record_id, thesis_id, revision_of, launch_id, kind, stance,
         author_identity_id, body, evidence_links, verification, network, deployment_fingerprint, launch_checkpoint,
         thesis_created_at, created_at, visibility, visibility_changed_at)
       VALUES ($1, $2, $3, $4, 'community_thesis', 'bullish', $5, $6, '{}', 'not_requested', $7, $8, 900, $9, $10, $11, $12)`,
      [
        recordId(post.label), recordId(original?.label ?? post.label), original ? recordId(original.label) : null, post.launch,
        AUTHOR, post.body, FIXTURE_NETWORK, FIXTURE_FINGERPRINT, original?.at ?? post.at, post.at,
        post.hidden ? "hidden" : "public", post.hidden ? post.at : null,
      ],
    );
    const current = !posts.some((other) => other.revises === post.label);
    if ((!post.hidden && current) || post.strayRow) {
      await admin.query(
        "INSERT INTO mission_control_launchpad_search_documents (record_id, launch_id, search_text) VALUES ($1, $2, $3)",
        [recordId(post.label), post.launch, searchText(post.body)],
      );
    }
  }
}

async function thesesPage(harness: Harness, raw: string, request: Readonly<{ limit?: string; cursor?: string | null }> = {}) {
  const answer = await searchTheses(raw, { limit: request.limit ?? "25", cursor: request.cursor ?? null }, await chainJoin(harness));
  assert.equal(answer.status, "fresh");
  assert.ok("data" in answer);
  return answer.data;
}

test("theses match every word, newest first post first, only public current records of canonical launches", { skip }, async () => {
  await withHarness([
    { label: 0xf1, name: "Alpha", symbol: "ALPHA", createdAtMs: 1_790_000_011_000 },
    { label: 0xf2, name: "Alpha", symbol: "ALPHA", createdAtMs: 1_790_000_012_000, creator: WALLET_2, lifecycle: "migration_ready" },
  ], async (harness) => {
    const t0 = "2026-10-01T12:00:00.000Z";
    await insertPosts(harness.admin, [
      { label: 1, launch: launchId(0xf1), body: "Graduation looks near for Alpha.", at: t0 },
      { label: 2, launch: launchId(0xf1), body: "Graduation looks near for Alpha.", at: t0 },
      { label: 3, launch: launchId(0xf2), body: "Graduation soon, the other Alpha.", at: "2026-10-01T12:00:01.000Z" },
      { label: 4, launch: launchId(0xf1), body: "Graduation is hidden", at: "2026-10-01T12:00:02.000Z", hidden: true, strayRow: true },
      { label: 5, launch: launchId(0xf1), body: "Graduation, my first take", at: "2026-10-01T11:59:00.000Z", strayRow: true },
      { label: 6, launch: launchId(0xf1), body: "Changed my mind", at: "2026-10-01T12:00:03.000Z", revises: 5 },
      { label: 7, launch: objectId(0xf9), body: "Graduation of a launch blast-infra never listed", at: "2026-10-01T12:00:04.000Z" },
    ]);
    const whole = await thesesPage(harness, "graduation");
    assert.deepEqual(whole.theses.map((hit) => hit.thesis.id), [recordId(3), recordId(2), recordId(1)],
      "equal times order by record ID; hidden, superseded and unjoined rows never match");
    assert.equal(whole.nextCursor, null);
    assert.deepEqual(whole.theses[0].launch, {
      launchId: launchId(0xf2),
      coinType: coinType(0xf2),
      name: "Alpha",
      symbol: "ALPHA",
      iconUrl: `https://i/${0xf2}.png`,
      lifecycle: "migration_ready",
      creator: WALLET_2,
      createdAtMs: 1_790_000_012_000,
    }, "a duplicate name is told apart by launch ID, lifecycle and creator");

    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const data = await thesesPage(harness, "graduation", { limit: "1", cursor });
      seen.push(...data.theses.map((hit) => hit.thesis.id));
      cursor = data.nextCursor;
    } while (cursor && seen.length < 10);
    assert.deepEqual(seen, [recordId(3), recordId(2), recordId(1)]);

    const first = await thesesPage(harness, "graduation", { limit: "1" });
    assert.ok(first.nextCursor);
    await assert.rejects(
      searchTheses("alpha", { limit: "1", cursor: first.nextCursor }, await chainJoin(harness)),
      CursorError,
      "a token belongs to its query",
    );
  });
});

test("the resource groups canonical matches, exact first, and a failing social source degrades alone", { skip }, async () => {
  await withHarness([
    { label: 0x91, name: "Kiwi", symbol: "KIWI", createdAtMs: 1_790_000_021_000 },
    { label: 0x92, name: "Kiwi", symbol: "KIWI", createdAtMs: 1_790_000_022_000, creator: WALLET_2, migratedTo: "cetus", lifecycle: "migrated" },
    { label: 0x93, name: "Kiwi", symbol: "KIWI", createdAtMs: 1_790_000_023_000, noCurve: true },
  ], async (harness) => {
    await insertPosts(harness.admin, [
      { label: 0x21, launch: launchId(0x92), body: "Kiwi graduated to Cetus.", at: "2026-10-01T12:00:00.000Z" },
      { label: 0x22, launch: launchId(0x93), body: "Kiwi without a curve.", at: "2026-10-01T12:00:01.000Z" },
      { label: 0x23, launch: launchId(0x91), body: "Kiwi spam", at: "2026-10-01T12:00:02.000Z", hidden: true, strayRow: true },
    ]);
    const sources = databaseSearchSources(await chainJoin(harness));
    const get = async (query: string) => handleSearchRequest(new Request(`https://blast.test/api/launchpad/search${query}`), sources);

    const text = await get("?q=kiwi");
    assert.equal(text.status, 200);
    const body = await text.json();
    assert.deepEqual(body.groups.map((group: { group: string; section: { state: string } }) => [group.group, group.section.state]), [
      ["coins", "available"], ["theses", "available"], ["profiles", "unavailable"],
    ]);
    assert.deepEqual(body.groups[0].section.data.items.map((item: LaunchMatch) => [item.launch.launchId, item.match]), [
      [launchId(0x92), "ticker"], [launchId(0x91), "ticker"],
    ]);
    assert.deepEqual(body.groups[1].section.data.items.map((item: { thesis: { id: string } }) => item.thesis.id), [recordId(0x21)],
      "a thesis of a coin without a curve, and a hidden one, never appear");
    assert.equal(body.groups[0].section.provenance.source, "replica");

    // The cetus pool's ID leads with its launch; the wallet group lists what it created.
    const exact = await (await get(`?q=${migrationPoolId(0x92)}`)).json();
    assert.deepEqual(exact.groups.map((group: { group: string; section: { state: string } }) => [group.group, group.section.state]), [
      ["onchain", "available"], ["wallets", "empty"], ["coins", "empty"], ["theses", "empty"], ["profiles", "unavailable"],
    ]);
    assert.deepEqual(exact.groups[0].section.data.items[0].pool, { venue: "cetus", poolId: migrationPoolId(0x92) });

    // Next page of one group only.
    const first = await (await get("?q=kiwi&group=coins&limit=1")).json();
    assert.deepEqual(first.groups.map((group: { group: string }) => group.group), ["coins"]);
    const second = await (await get(`?q=kiwi&group=coins&limit=1&cursor=${first.groups[0].section.data.nextCursor}`)).json();
    assert.deepEqual(second.groups[0].section.data.items.map((item: LaunchMatch) => item.launch.launchId), [launchId(0x91)]);
    assert.equal(second.groups[0].section.data.nextCursor, null);

    // The social search source fails (social records are read on the primary, whose web role loses them); the
    // chain groups, read on the replica, still answer.
    await harness.admin.query("REVOKE SELECT ON mission_control_launchpad_search_documents FROM blast_web");
    try {
      const degraded = await get("?q=kiwi");
      assert.equal(degraded.status, 200);
      const groups = (await degraded.json()).groups;
      assert.deepEqual(groups.map((group: { group: string; section: { state: string; reason?: string } }) => [group.group, group.section.state, group.section.reason]), [
        ["coins", "available", undefined], ["theses", "unavailable", "error"], ["profiles", "unavailable", "no-source"],
      ]);
    } finally {
      await harness.admin.query("GRANT SELECT ON mission_control_launchpad_search_documents TO blast_web");
    }
  });
});

test("a revised thesis keeps its first-post place in search, as in its launch's list, and each row's time explains it", { skip }, async () => {
  await withHarness([
    { label: 0x81, name: "Alpha", symbol: "ALPHA", createdAtMs: 1_790_000_031_000 },
  ], async (harness) => {
    await insertPosts(harness.admin, [
      { label: 0x31, launch: launchId(0x81), body: "Graduation near, first take", at: "2026-10-01T11:00:00.000Z" },
      { label: 0x32, launch: launchId(0x81), body: "Graduation looks near", at: "2026-10-01T12:00:00.000Z" },
      { label: 0x33, launch: launchId(0x81), body: "Graduation looks near", at: "2026-10-01T12:00:00.000Z" },
      { label: 0x34, launch: launchId(0x81), body: "Graduation near, revised take", at: "2026-10-01T12:10:00.000Z", revises: 0x31 },
    ]);
    const whole = await thesesPage(harness, "graduation");
    assert.deepEqual(whole.theses.map((hit) => hit.thesis.id), [recordId(0x33), recordId(0x32), recordId(0x34)],
      "first-post time, newest first, then thesis ID: the revision keeps the 11:00 place");
    const posted = whole.theses.map((hit) => hit.thesis.postedAt);
    assert.deepEqual(posted, ["2026-10-01T12:00:00.000Z", "2026-10-01T12:00:00.000Z", "2026-10-01T11:00:00.000Z"],
      "the time each row shows is the time it is ordered by");

    const list = await listLaunchTheses(launchId(0x81), {}, await chainJoin(harness));
    assert.ok("data" in list);
    assert.deepEqual(whole.theses.map((hit) => hit.thesis.thesisId), list.data.theses.map((post) => post.thesisId),
      "search orders a launch's theses as its own list does");

    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const data = await thesesPage(harness, "graduation", { limit: "1", cursor });
      seen.push(...data.theses.map((hit) => hit.thesis.id));
      cursor = data.nextCursor;
    } while (cursor && seen.length < 10);
    assert.deepEqual(seen, [recordId(0x33), recordId(0x32), recordId(0x34)]);

    // The largest bigint key is a valid position: it is read, never a database error.
    const edge = encodeCursor(thesisSearchCursorShape("graduation"), ["9223372036854775807"], [recordId(0x33)]);
    assert.equal((await thesesPage(harness, "graduation", { cursor: edge })).theses.length, 3);
    const lastTier = encodeCursor(searchCursorShape("coins", parseSearchQuery("alpha")), [3, 0], [launchId(0x81)]);
    assert.deepEqual((await page(harness, "coins", "alpha", { cursor: lastTier })).items, []);
  });
});

test("a thesis match behind many posts of an unlisted launch is found, and a theses page that carries a token is never empty", { skip }, async () => {
  await withHarness([
    { label: 0x71, name: "Froggy", symbol: "FROG", createdAtMs: 1_790_000_071_000 },
  ], async (harness) => {
    // A replay: blast-infra no longer lists launch 0x7f, so its forty newer matching posts are skipped.
    const unlisted = launchId(0x7f);
    await insertPosts(harness.admin, [
      { label: 0x500, launch: launchId(0x71), body: "Zebra canonical thesis on Froggy", at: "2026-10-01T10:00:00.000Z" },
      ...Array.from({ length: 40 }, (_, index) => ({
        label: 0x501 + index,
        launch: unlisted,
        body: `Zebra take ${index}`,
        at: new Date(Date.parse("2026-10-01T11:00:00.000Z") + index * 1_000).toISOString(),
      })),
    ]);
    const sources = databaseSearchSources(await chainJoin(harness));
    const get = async (query: string) =>
      (await (await handleSearchRequest(new Request(`https://blast.test/api/launchpad/search${query}`), sources)).json()) as {
        groups: { group: string; section: { state: string; data?: { items: { thesis: { id: string } }[]; nextCursor: string | null } } }[];
      };

    // The grouped search reads past the skipped posts until its first hit.
    const grouped = (await get("?q=zebra")).groups.find((group) => group.group === "theses")?.section;
    assert.equal(grouped?.state, "available");
    assert.deepEqual(grouped?.data?.items.map((item) => item.thesis.id), [recordId(0x500)]);

    // A one-hit page whose bound runs out first keeps its token: available with no rows, never "empty".
    let page = (await get("?q=zebra&group=theses&limit=1")).groups[0].section;
    assert.equal(page.state, "available");
    assert.deepEqual(page.data?.items, []);
    assert.ok(page.data?.nextCursor, "the token that reaches the match is kept");
    const seen: string[] = [];
    for (let pages = 0; page.data?.nextCursor && pages < 10; pages += 1) {
      page = (await get(`?q=zebra&group=theses&limit=1&cursor=${encodeURIComponent(page.data.nextCursor)}`)).groups[0].section;
      seen.push(...(page.data?.items ?? []).map((item) => item.thesis.id));
    }
    assert.deepEqual(seen, [recordId(0x500)], "following the tokens reaches the match once");
    assert.equal(page.data?.nextCursor ?? null, null);
  });
});

test("a newer test launch does not take a coin or wallet search result's page slot", { skip }, async () => {
  await withHarness([
    { label: 0xc1, name: "Pine", symbol: "PINE", createdAtMs: 1_790_000_021_000 },
    { label: 0xc2, name: "Pine", symbol: "PINE", createdAtMs: 1_790_000_022_000 },
  ], async (harness) => {
    await harness.admin.query("UPDATE pools SET quote_type = $1 WHERE pool_key = $2",
      [CREATE_TEST_SUI_QUOTE_TYPE, `blast_curve:${launchId(0xc2)}`]);
    const coins = await page(harness, "coins", "pine", { limit: 1 });
    assert.deepEqual([coins.items.map((item) => item.launch.launchId), coins.nextCursor], [[launchId(0xc1)], null]);

    const wallet = await page(harness, "wallets", WALLET_1, { limit: 1 });
    assert.deepEqual([wallet.items.map((item) => item.launch.launchId), wallet.nextCursor], [[launchId(0xc1)], null]);

    const exact = await page(harness, "coins", coinType(0xc2), { limit: 1 });
    assert.deepEqual(exact.items, []);
    const onchain = await page(harness, "onchain", launchId(0xc2), { limit: 1 });
    assert.deepEqual(onchain.items, []);
  });
});
