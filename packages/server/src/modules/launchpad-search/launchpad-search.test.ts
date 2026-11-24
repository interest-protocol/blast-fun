import assert from "node:assert/strict";
import test from "node:test";

import { CursorError, encodeCursor } from "@blast/core/modules/launchpad-contract/cursor.ts";
import { ContractViolation } from "@blast/core/modules/launchpad-contract/decimal.ts";
import type { Provenance, RoutedRead } from "@blast/core/modules/launchpad-contract/read.ts";
import { SocialQueryError } from "@blast/server/modules/launchpad-social/contracts.ts";
import { FIXTURE_SEARCH_GRADUATION } from "../../../test/fixtures/modules/launchpad-social/fixtures.ts";
import { thesisSearchCursorShape, type SearchPage } from "@blast/server/modules/launchpad-social/reads.ts";
import type { ChainJoinDependencies } from "@blast/server/modules/read-routing/chain-join.ts";
import { parseSearchResponse, type LaunchGroup, type LaunchGroupPage, type LaunchMatch } from "@blast/core/modules/launchpad-search/contracts.ts";
import { parseSearchQuery } from "@blast/server/modules/launchpad-search/query.ts";
import { searchCursorShape } from "@blast/server/modules/launchpad-search/reads.ts";
import { databaseSearchSources, handleSearchRequest, type SearchSources } from "@blast/server/modules/launchpad-search/resource.ts";

const A1 = `0x${"a1".padStart(64, "0")}`;

test("a 0x address of any valid length is one exact identifier in canonical form", () => {
  assert.deepEqual(parseSearchQuery("  0xA1 "), { text: "0xa1", words: "0xa1:*", address: A1, coinType: null });
  const full = `0x${"AB".repeat(32)}`;
  assert.equal(parseSearchQuery(full).address, full.toLowerCase());
});

test("hex without 0x, an over-long address and a coin type are not addresses", () => {
  assert.equal(parseSearchQuery("a1").address, null, "a word such as 'face' is never an address");
  assert.equal(parseSearchQuery(`0x${"1".repeat(65)}`).address, null);
  assert.equal(parseSearchQuery("0xa1::alpha::ALPHA").address, null);
});

test("a coin type is an exact identifier with its address canonical and its names kept", () => {
  const parsed = parseSearchQuery("0xA1::alpha::ALPHA");
  assert.equal(parsed.coinType, `${A1}::alpha::ALPHA`);
  assert.equal(parsed.words, "0xa1:* & alpha:* & alpha:*", "its words are still searched as text");
  for (const other of ["0xa1::alpha", "0xa1::alpha::ALPHA<u8>", "0xa1::1alpha::ALPHA", "0xzz::alpha::ALPHA"]) {
    assert.equal(parseSearchQuery(other).coinType, null, other);
  }
});

test("text is searched in its search form, every word a required prefix", () => {
  assert.deepEqual(parseSearchQuery("  Pepe   the ＦＲＯＧ "), {
    text: "pepe the frog",
    words: "pepe:* & the:* & frog:*",
    address: null,
    coinType: null,
  });
});

test("a query without words or over its length is refused without echoing it", () => {
  for (const raw of ["", "   ", "!!! ???", "x".repeat(201)]) {
    assert.throws(() => parseSearchQuery(raw), (error: unknown) => {
      assert.ok(error instanceof SocialQueryError);
      assert.equal(error.code, "LAUNCHPAD_QUERY_INVALID");
      assert.ok(!error.message.includes("???") && !error.message.includes("xxxx"));
      return true;
    }, JSON.stringify(raw));
  }
});

const PROVENANCE = {
  source: "replica",
  network: "mainnet",
  deployment: "5d2f2a4be1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c",
  checkpoint: 326_274_009,
  timestampMs: 1_790_000_000_000,
  observedAt: 1_790_000_000_412,
  lagMs: 412,
} as const satisfies Provenance;

function launchMatch(label: string, match: LaunchMatch["match"]): LaunchMatch {
  return {
    match,
    launch: {
      launchId: `0x${label.repeat(32)}`,
      coinType: `0x${label.repeat(31)}ff::toad::TOAD`,
      name: "Toad",
      symbol: "TOAD",
      iconUrl: null,
      lifecycle: "live",
      creator: `0x${"e1".repeat(32)}`,
      createdAtMs: 1_790_000_000_000,
    },
    pool: null,
  };
}

type Call = Readonly<{ source: string; limit: number; cursor: string | null }>;

/** Sources answering from fixed reads (or throwing), recording each call. */
function sources(
  answers: Partial<Record<LaunchGroup | "theses", RoutedRead<unknown> | Error>>,
  calls: Call[] = [],
): SearchSources {
  const answer = (name: LaunchGroup | "theses") => {
    const value = answers[name] ?? { status: "fresh", data: { items: [], theses: [], nextCursor: null }, provenance: PROVENANCE };
    if (value instanceof Error) throw value;
    return value;
  };
  return {
    launches: async (group, _query, request) => {
      calls.push({ source: group, ...request });
      return answer(group) as RoutedRead<LaunchGroupPage>;
    },
    theses: async (_raw, request) => {
      calls.push({ source: "theses", ...request });
      return answer("theses") as RoutedRead<SearchPage>;
    },
  };
}

function search(query: string, searchSources: SearchSources | null) {
  return handleSearchRequest(new Request(`https://blast.test/api/launchpad/search${query}`), searchSources);
}

test("a malformed search is refused before any read and never cached", async () => {
  const calls: Call[] = [];
  const refusals: [string, string][] = [
    ["", "LAUNCHPAD_QUERY_INVALID"],
    ["?q=", "LAUNCHPAD_QUERY_INVALID"],
    ["?q=%21%21%21", "LAUNCHPAD_QUERY_INVALID"],
    [`?q=${"x".repeat(201)}`, "LAUNCHPAD_QUERY_INVALID"],
    ["?q=toad&q=frog", "LAUNCHPAD_QUERY_INVALID"],
    ["?q=toad&sort=hot", "LAUNCHPAD_QUERY_INVALID"],
    ["?q=toad&cursor=abc", "LAUNCHPAD_QUERY_INVALID"],
    ["?q=toad&group=profiles", "LAUNCHPAD_QUERY_INVALID"],
    ["?q=toad&group=x", "LAUNCHPAD_QUERY_INVALID"],
    ["?q=toad&group=wallets", "LAUNCHPAD_QUERY_INVALID"],
    ["?q=toad&limit=ten", "LAUNCHPAD_CURSOR_INVALID"],
  ];
  for (const [query, code] of refusals) {
    const response = await search(query, sources({}, calls));
    assert.equal(response.status, 400, query);
    assert.equal(response.headers.get("Cache-Control"), "private, no-store");
    const body = await response.json();
    assert.equal(body.error.code, code, query);
    assert.ok(!JSON.stringify(body).includes("xxxx") && !JSON.stringify(body).includes("frog"), "no echo");
  }
  assert.deepEqual(calls, []);
});

test("text search serves Coins, Theses and an Unavailable Profiles group, each a section, privately", async () => {
  const calls: Call[] = [];
  const response = await search("?q=Toad", sources({
    coins: { status: "fresh", data: { items: [launchMatch("01", "ticker")], nextCursor: "next-coins" }, provenance: PROVENANCE },
    theses: { status: "fresh", data: FIXTURE_SEARCH_GRADUATION, provenance: PROVENANCE },
  }, calls));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Cache-Control"), "private, no-store");
  const body = await response.json();
  assert.deepEqual(body.groups.map((group: { group: string; section: { state: string } }) => [group.group, group.section.state]), [
    ["coins", "available"],
    ["theses", "available"],
    ["profiles", "unavailable"],
  ]);
  assert.deepEqual(calls, [{ source: "coins", limit: 5, cursor: null }, { source: "theses", limit: 5, cursor: null }]);
  assert.deepEqual(body.groups[0].section.data, { items: [launchMatch("01", "ticker")], nextCursor: "next-coins" });
  assert.equal(body.groups[2].section.reason, "no-source");
  const revised = FIXTURE_SEARCH_GRADUATION.theses.find((hit) => hit.thesis.revisionOf !== null);
  assert.ok(revised);
  assert.deepEqual(body.groups[1].section.data.items.find((item: { thesis: { id: string } }) => item.thesis.id === revised.thesis.id), {
    match: "words",
    thesis: {
      id: revised.thesis.id,
      thesisId: revised.thesis.thesisId,
      kind: "community_thesis",
      stance: "bullish",
      body: revised.thesis.body,
      authorLabels: ["wallet"],
      postedAt: revised.thesis.postedAt,
      createdAt: revised.thesis.createdAt,
    },
    launch: revised.launch,
  }, "a thesis hit carries its text and labels, never its author identity or disclosed wallet");
  assert.ok(!JSON.stringify(body).includes(revised.thesis.authorIdentityId));
});

test("an address also searches launch and pool IDs and wallets, identifier groups first", async () => {
  const calls: Call[] = [];
  const body = await (await search(`?q=0x${"a1".repeat(32)}&limit=50`, sources({}, calls))).json();
  assert.deepEqual(body.groups.map((group: { group: string }) => group.group), ["onchain", "wallets", "coins", "theses", "profiles"]);
  assert.deepEqual(calls.map((call) => [call.source, call.limit]), [["onchain", 25], ["wallets", 25], ["coins", 25], ["theses", 25]]);
  assert.deepEqual(body.groups.slice(0, 4).map((group: { section: { state: string } }) => group.section.state), ["empty", "empty", "empty", "empty"]);
});

test("a group that fails or is unavailable degrades alone; all of them failing is a 503", async () => {
  const lagging = { status: "unavailable", provenance: { ...PROVENANCE, reason: "indexer-lag" } } as const;
  const partial = await search("?q=toad", sources({
    coins: { status: "fresh", data: { items: [launchMatch("01", "words")], nextCursor: null }, provenance: PROVENANCE },
    theses: new Error("relation does not exist"),
  }));
  assert.equal(partial.status, 200);
  const body = await partial.json();
  assert.deepEqual(body.groups.map((group: { section: { state: string; reason?: string } }) => [group.section.state, group.section.reason]), [
    ["available", undefined],
    ["unavailable", "error"],
    ["unavailable", "no-source"],
  ]);

  const down = await search("?q=toad", sources({ coins: lagging, theses: lagging }));
  assert.equal(down.status, 503);
  assert.ok(down.headers.get("Retry-After"));
  assert.equal(down.headers.get("Cache-Control"), "private, no-store");
  const downBody = await down.json();
  assert.deepEqual(downBody.groups.map((group: { section: { reason: string } }) => group.section.reason), ["indexer-lag", "indexer-lag", "no-source"]);
  assert.equal(downBody.groups[0].section.provenance.reason, "indexer-lag");

  const unconfigured = await search("?q=toad", null);
  assert.equal(unconfigured.status, 503);
  assert.deepEqual((await unconfigured.json()).groups.map((group: { section: { reason: string } }) => group.section.reason), [
    "unconfigured", "unconfigured", "no-source",
  ]);
});

test("a group's next page reads only that group with its token, and a bad token is a 400", async () => {
  const calls: Call[] = [];
  const response = await search("?q=toad&group=theses&cursor=abc&limit=10", sources({}, calls));
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).groups.map((group: { group: string }) => group.group), ["theses"]);
  assert.deepEqual(calls, [{ source: "theses", limit: 10, cursor: "abc" }]);

  const refused = await search("?q=toad&group=coins&cursor=abc", sources({ coins: new CursorError("the cursor is not a page token") }));
  assert.equal(refused.status, 400);
  assert.equal((await refused.json()).error.code, "LAUNCHPAD_CURSOR_INVALID");
});

test("a served search parses group by group; a group that breaks the contract is Unavailable alone", async () => {
  const response = await search(`?q=0x${"a1".repeat(32)}`, sources({
    onchain: { status: "fresh", data: { items: [{ ...launchMatch("a1", "pool_id"), pool: { venue: "cetus", poolId: `0x${"c1".repeat(32)}` } }], nextCursor: null }, provenance: PROVENANCE },
    wallets: { status: "stale", data: { items: [launchMatch("02", "creator")], nextCursor: "more" }, provenance: { ...PROVENANCE, reason: "indexer-lag" } },
    theses: { status: "fresh", data: FIXTURE_SEARCH_GRADUATION, provenance: PROVENANCE },
  }));
  const served = await response.json();
  const parsed = parseSearchResponse(served);
  assert.deepEqual(parsed, served, "a valid answer parses to itself");

  const broken = structuredClone(served);
  broken.groups[0].section.data.items[0].launch.lifecycle = "hot";
  broken.groups[1].section.data.items[0].extra = true;
  broken.groups[3].section.data.items[0].thesis.authorIdentityId = "leaked";
  broken.groups.splice(4, 0, { group: "x", section: { state: "empty", provenance: PROVENANCE } });
  const degraded = parseSearchResponse(broken);
  assert.deepEqual(degraded.groups.map((group) => [group.group, group.section.state, "reason" in group.section ? group.section.reason : null]), [
    ["onchain", "unavailable", "contract-violation"],
    ["wallets", "unavailable", "contract-violation"],
    ["coins", "empty", null],
    ["theses", "unavailable", "contract-violation"],
    ["profiles", "unavailable", "no-source"],
  ], "an unknown group is not shown; the others keep their own state");

  for (const garbage of [null, [], { groups: {} }, { groups: [], extra: 1 }]) {
    assert.throws(() => parseSearchResponse(garbage), ContractViolation, JSON.stringify(garbage));
  }
});

/** Database dependencies that record every statement and probe, and answer none. */
function recordingDatabase(calls: string[]): ChainJoinDependencies {
  const refuse = async (text: string) => {
    calls.push(text);
    throw new Error("no read was expected");
  };
  return {
    replica: { read: refuse },
    primary: { read: refuse },
    position: async (source) => refuse(`position:${source}`),
    now: Date.now,
    requireRecovery: false,
    expected: null,
  };
}

/** The `launchpad.search` metric lines logged while `body` runs. */
async function searchMetrics(body: () => Promise<void>): Promise<string[]> {
  const lines: string[] = [];
  const info = console.info;
  console.info = (line?: unknown) => {
    if (typeof line === "string" && line.includes('"launchpad.search"')) lines.push(line);
  };
  try {
    await body();
  } finally {
    console.info = info;
  }
  return lines;
}

test("a page token whose values fall outside its order is a 400 before any read or error metric", async () => {
  const calls: string[] = [];
  const sources = databaseSearchSources(recordingDatabase(calls));
  const address = `0x${"a1".repeat(32)}`;
  const launch = `0x${"b1".repeat(32)}`;
  const record = "00000000-0000-4000-8000-000000000001";
  const coins = (key: [number, number], tie = launch) => encodeCursor(searchCursorShape("coins", parseSearchQuery("toad")), key, [tie]);
  const theses = (key: string, tie = record) => encodeCursor(thesisSearchCursorShape("toad"), [key], [tie]);
  const forged: [string, string][] = [
    ["coins tier 2^31", `?q=toad&group=coins&cursor=${coins([2 ** 31, 1])}`],
    ["coins tier 3000000000", `?q=toad&group=coins&cursor=${coins([3_000_000_000, 1])}`],
    ["coins tier past its last tier", `?q=toad&group=coins&cursor=${coins([4, 1])}`],
    ["coins tier below 0", `?q=toad&group=coins&cursor=${coins([-1, 1])}`],
    ["coins creation time below 0", `?q=toad&group=coins&cursor=${coins([1, -1])}`],
    ["coins tie not a launch ID", `?q=toad&group=coins&cursor=${coins([1, 1], "0xpool")}`],
    ["onchain tier past its last tier", `?q=${address}&group=onchain&cursor=${encodeCursor(searchCursorShape("onchain", parseSearchQuery(address)), [2, 1], [launch])}`],
    ["theses key past bigint", `?q=toad&group=theses&cursor=${theses("9223372036854775808")}`],
    ["theses key of 30 digits", `?q=toad&group=theses&cursor=${theses("1".repeat(30))}`],
    ["theses tie not a UUID", `?q=toad&group=theses&cursor=${theses("1", "not-a-uuid")}`],
  ];
  const metrics = await searchMetrics(async () => {
    for (const [label, query] of forged) {
      const response = await search(query, sources);
      assert.equal(response.status, 400, label);
      assert.equal(response.headers.get("Retry-After"), null, label);
      assert.equal((await response.json()).error.code, "LAUNCHPAD_CURSOR_INVALID", label);
    }
  });
  assert.equal(calls.length, 0, "no statement or position probe reached a database");
  assert.deepEqual(metrics, [], "a refused token is no source error");

  // The bounds are inclusive: the largest bigint and the last tier are positions, so they are read.
  await searchMetrics(async () => {
    await search(`?q=toad&group=theses&cursor=${theses("9223372036854775807")}`, sources);
    await search(`?q=toad&group=coins&cursor=${coins([3, 0])}`, sources);
  });
  assert.equal(calls.filter((call) => call.startsWith("position")).length, 2);
});


test("failed search groups preserve their strict contract and accept only safe structured diagnostics", async () => {
  const response = await search("?q=alpha", null);
  const body = await response.json();
  const parsed = parseSearchResponse(body);
  assert.equal(parsed.error?.code, "SERVICE_UNAVAILABLE");
  assert.deepEqual(parsed.groups, body.groups);
  assert.ok(response.headers.get("x-request-id"));
  const sanitized = parseSearchResponse({ ...body, error: { code: "SERVICE_UNAVAILABLE", message: "private provider credential" } });
  assert.equal(sanitized.error?.message, "This service is temporarily unavailable. Please retry.");
  assert.doesNotMatch(JSON.stringify(sanitized), /private provider credential/);
  assert.throws(() => parseSearchResponse({ ...body, extra: true }), ContractViolation);
  assert.throws(() => parseSearchResponse({ ...body, error: { code: "unknown", message: "raw" } }), ContractViolation);
});
