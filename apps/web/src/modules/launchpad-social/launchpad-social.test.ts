import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import type { HoldersSnapshotPage } from "@blast/core/modules/launchpad-contract/holders.ts";
import type { RoutedRead } from "@blast/core/modules/launchpad-contract/read.ts";
import type { V1Answer } from "@blast/core/modules/launchpad-contract/v1.ts";
import {
  SocialQueryError,
  authorLabels,
  normalizeSearchText,
  parsePostInput,
  searchQuery,
  searchText,
} from "@blast/server/modules/launchpad-social/contracts.ts";
import {
  FIXTURE_ALPHA_THESES,
  FIXTURE_SEARCH_BETA,
  FIXTURE_SEARCH_EMPTY,
  FIXTURE_SEARCH_GRADUATION,
} from "../../../../../packages/server/test/fixtures/modules/launchpad-social/fixtures.ts";
import { snapshotHolderProof } from "@blast/server/modules/launchpad-social/holder-proof.ts";
import { DATABASE_CEILINGS, SOCIAL_LIMITS } from "@blast/core/modules/launchpad-social/limits.ts";
import { publicPost, type PostRecord } from "@blast/server/modules/launchpad-social/reads.ts";

const LAUNCH = `0x${"ab".repeat(32)}`;
const WALLET = `0x${"cd".repeat(32)}`;

function input(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    launchId: LAUNCH,
    kind: "community_thesis",
    stance: "bullish",
    body: "Curve fills steadily; the creator answered every question.",
    evidenceLinks: ["https://example.com/thread"],
    disclosure: { text: "I hold a small bag.", walletAddress: null },
    revisionOf: null,
    ...overrides,
  };
}

test("a safe post is accepted with inert text, normalized links and its disclosure", () => {
  assert.deepEqual(parsePostInput(input({
    body: "  Cafe\u0301 thesis\r\nsecond line  ",
    evidenceLinks: ["https://Example.com/a b", "https://example.com/a%20b"],
    disclosure: { text: "  holder since day one ", walletAddress: WALLET.toUpperCase().replace("0X", "0x") },
  })), {
    launchId: LAUNCH,
    kind: "community_thesis",
    stance: "bullish",
    body: "Café thesis\nsecond line",
    evidenceLinks: ["https://example.com/a%20b"],
    disclosure: { text: "holder since day one", walletAddress: WALLET },
    revisionOf: null,
  });
  assert.equal(parsePostInput(input({ kind: "creator_update", stance: null })).stance, null, "an update may take no stance");
});

test("unsafe links, active text, foreign launch ids and unknown values are refused", () => {
  const refused: Record<string, unknown>[] = [
    { evidenceLinks: ["javascript:alert(1)"] },
    { evidenceLinks: ["http://example.com/plain"] },
    { evidenceLinks: ["https://user:pass@example.com/"] },
    { evidenceLinks: ["data:text/html,<b>x</b>"] },
    { evidenceLinks: ["https://a.example/1", "https://a.example/2", "https://a.example/3", "https://a.example/4"] },
    { evidenceLinks: [`https://example.com/${"x".repeat(2_048)}`] },
    { evidenceLinks: "https://example.com" },
    { body: "" },
    { body: "   \n " },
    { body: "x".repeat(1_001) },
    { body: "bell\u0007" },
    { body: "right-to-left \u202Eoverride" },
    { body: "isolate \u2066x\u2069" },
    { body: "lone \uD800 surrogate" },
    { body: 42 },
    { kind: "global_chat" },
    { stance: "moon" },
    { stance: null },
    { kind: "creator_thesis", stance: null },
    { disclosure: null },
    { disclosure: { text: null } },
    { disclosure: { text: null, walletAddress: null, verified: true } },
    { disclosure: { text: "x".repeat(281), walletAddress: null } },
    { disclosure: { text: "\u202E", walletAddress: null } },
    { disclosure: { text: null, walletAddress: "not-a-wallet" } },
    { launchId: "0xAB" },
    { launchId: `0x${"AB".repeat(32)}` },
    { revisionOf: "record-1" },
  ];
  for (const overrides of refused) {
    assert.throws(() => parsePostInput(input(overrides)), TypeError, JSON.stringify(overrides));
  }
  assert.equal(parsePostInput(input({ body: "😀".repeat(1_000) })).body.length, 2_000, "code points, not UTF-16 units");
  assert.equal(parsePostInput(input({ body: "tab\tand\nlines" })).body, "tab\tand\nlines");
});

test("the provisional limits are configuration, well inside the database's safety ceilings", () => {
  const strict = { ...SOCIAL_LIMITS, bodyCodePoints: 10, evidenceLinks: 1 };
  assert.throws(() => parsePostInput(input({ body: "x".repeat(11) }), strict), TypeError);
  assert.throws(() => parsePostInput(input({ evidenceLinks: ["https://a.example/1", "https://a.example/2"] }), strict), TypeError);
  assert.equal(parsePostInput(input({ body: "x".repeat(10) }), strict).body.length, 10);
  assert.ok(SOCIAL_LIMITS.bodyCodePoints * 10 <= DATABASE_CEILINGS.bodyCharacters);
  assert.ok(SOCIAL_LIMITS.disclosureCodePoints * 10 <= DATABASE_CEILINGS.disclosureCharacters);
  assert.ok(SOCIAL_LIMITS.evidenceLinks * 10 <= DATABASE_CEILINGS.evidenceLinks);
  assert.ok(SOCIAL_LIMITS.evidenceLinks * (SOCIAL_LIMITS.evidenceLinkLength + 1) * 10 <= DATABASE_CEILINGS.evidenceCharacters);
  assert.ok(SOCIAL_LIMITS.searchTextCodePoints * 10 <= DATABASE_CEILINGS.searchTextCharacters);
});

test("a valid body's search text never outgrows its bound, however far NFKC expands it", () => {
  for (const body of ["\uFDFA".repeat(1_000), "\uFB03".repeat(1_000), "㎒\uFB04⑴".repeat(333)]) {
    const parsed = parsePostInput(input({ body }));
    const text = searchText(parsed.body);
    assert.ok(normalizeSearchText(parsed.body).length > 2 * SOCIAL_LIMITS.bodyCodePoints, "the probe expands past twice the body");
    assert.ok([...text].length <= SOCIAL_LIMITS.searchTextCodePoints, `${[...text].length} code points`);
    assert.equal(searchText(parsed.body), text, "deterministic");
    assert.ok(text.startsWith(normalizeSearchText(parsed.body.slice(0, 10))), "the cut keeps the start");
  }
  const cut = [...searchText("\uFDFA".repeat(1_000))].length;
  assert.ok(cut <= SOCIAL_LIMITS.searchTextCodePoints && cut > SOCIAL_LIMITS.searchTextCodePoints - 18, "18,000 code points are cut (a cut space is trimmed)");
  assert.equal(searchText("  Ｆｉｎｅ  \uFB03  "), "fine ffi");
});

test("search queries share the text's normalized form and are only prefix words", () => {
  assert.equal(normalizeSearchText("  ＢＬＡＳＴ\tTo  the\nMoon  "), "blast to the moon");
  assert.equal(searchQuery("Graduation, ALP!"), "graduation:* & alp:*");
  assert.equal(searchQuery("a:* | !b & (c)"), "a:* & b:* & c:*", "operators never reach the tsquery");
  assert.equal(searchQuery("one two three four five six seven eight nine"), "one:* & two:* & three:* & four:* & five:* & six:* & seven:* & eight:*");
  assert.equal(searchQuery("x".repeat(80)), `${"x".repeat(64)}:*`);
  for (const refused of ["", "  ", "!?", "x".repeat(201)]) assert.throws(() => searchQuery(refused), SocialQueryError);
});

test("author labels project the post's named identity sources only", () => {
  assert.deepEqual(authorLabels({ kind: "community_thesis", disclosure: { walletAddress: null } }), []);
  assert.deepEqual(authorLabels({ kind: "creator_update", disclosure: { walletAddress: WALLET } }), ["creator", "wallet"]);
});

const COIN = `0x${"ab".repeat(32)}::alpha::ALPHA`;
const PROVENANCE = { source: "blast-infra", network: "mainnet", deployment: "f".repeat(64), checkpoint: 900, timestampMs: 1, observedAt: 2, lagMs: 1 } as const;
type Page = RoutedRead<V1Answer<HoldersSnapshotPage>>;

function page(checkpoint: number, holders: string[], nextCursor: string | null, state: "complete" | "incomplete" = "complete"): Page {
  const facts = state === "incomplete" ? null : {
    holderCount: 300n,
    heldSupply: 1_000n,
    top1: { amount: 10n, shareBps: 100n },
    top10: { amount: 100n, shareBps: 1_000n },
    holders: holders.map((address) => ({ address, balance: 1n, shareBps: 10n })),
    nextCursor,
  };
  return {
    status: "fresh",
    data: { kind: "answer", value: { coin: COIN, snapshot: { state, checkpoint, timestampMs: 1_790_000_000_000 + checkpoint }, facts } },
    provenance: PROVENANCE,
  };
}

function prover(
  pages: Page[],
  options: { coinType?: string | null; maxPages?: number; deadlineMs?: number; pageDelayMs?: number } = {},
) {
  const cursors: (string | null)[] = [];
  const port = snapshotHolderProof({
    coinTypeOf: async () => (options.coinType === undefined ? COIN : options.coinType),
    readPage: async (_coin, _launch, cursor) => {
      cursors.push(cursor);
      if (options.pageDelayMs) await new Promise((resolve) => setTimeout(resolve, options.pageDelayMs));
      const next = pages.shift();
      if (!next) throw new Error("no more pages");
      return next;
    },
    maxPages: options.maxPages ?? 3,
    deadlineMs: options.deadlineMs ?? 1_000,
  });
  return { port, cursors };
}

test("a holder proof reads snapshot pages of one checkpoint and keeps the snapshot's checkpoint and time", async () => {
  const other = `0x${"01".repeat(32)}`;
  const found = prover([page(900, [other], "c1"), page(900, [WALLET], "c2")]);
  assert.deepEqual(await found.port.prove(LAUNCH, WALLET), {
    verification: "verified_holder", checkpoint: 900, observedAtMs: 1_790_000_000_900, coinType: COIN,
  });
  assert.deepEqual(found.cursors, [null, "c1"]);

  const absent = prover([page(901, [other], "c1"), page(901, [], null)]);
  assert.deepEqual(await absent.port.prove(LAUNCH, WALLET), {
    verification: "not_holder", checkpoint: 901, observedAtMs: 1_790_000_000_901, coinType: COIN,
  });
});

test("a holder proof is unavailable rather than a guess, and within one overall deadline", async () => {
  const other = `0x${"01".repeat(32)}`;
  const cases = [
    prover([page(900, [], null, "incomplete")]),
    prover([page(900, [other], "c1"), page(901, [WALLET], null)]),
    prover([page(900, [other], "c1"), page(900, [other], "c2")], { maxPages: 2 }),
    prover([{ status: "unavailable", provenance: PROVENANCE }]),
    prover([{ status: "fresh", data: { kind: "refused", httpStatus: 404, error: { code: "not_found", message: "no" } }, provenance: PROVENANCE }]),
    prover([], {}),
    prover([page(900, [WALLET], null)], { coinType: null }),
  ];
  for (const [index, { port }] of cases.entries()) {
    assert.deepEqual(await port.prove(LAUNCH, WALLET), { verification: "unavailable" }, `case ${index}`);
  }

  // Each page answers in time, but the pages together outlast the one deadline. Five times the old 60 ms and 40 ms:
  // a loaded machine fires a timer late by more than the old 50 ms of slack. The proof ends 200 ms after the deadline
  // at most, still 100 ms before the three pages would have.
  const { port } = prover(
    [page(900, [other], "c1"), page(900, [other], "c2"), page(900, [WALLET], null)],
    { deadlineMs: 300, pageDelayMs: 200 },
  );
  const started = Date.now();
  assert.deepEqual(await port.prove(LAUNCH, WALLET), { verification: "unavailable" });
  assert.ok(Date.now() - started < 500, "the deadline, not the pages, ends the proof");
});

test("the search and post fixtures have the public read shapes and orders", () => {
  const record: PostRecord = {
    id: "r", thesisId: "t", revisionOf: null, launchId: LAUNCH, kind: "community_thesis", stance: "neutral",
    authorIdentityId: "a", body: "b", evidenceLinks: [],
    disclosure: { text: null, walletAddress: null, verification: "not_requested", observedCheckpoint: null, observedAt: null },
    authorLabels: [],
    provenance: { network: "mainnet", deployment: "f".repeat(64), checkpoint: 1 },
    postedAt: "2026-10-01T00:00:00.000Z", createdAt: "2026-10-01T00:00:00.000Z",
    moderationState: "hidden", moderationChangedAt: "2026-10-01T00:00:01.000Z",
  };
  const view = publicPost(record);
  const keys = Object.keys(view).sort();
  assert.equal(view.moderationState, "public");
  assert.ok(!keys.includes("moderationChangedAt") && !keys.includes("author"));
  const hits = [...FIXTURE_SEARCH_GRADUATION.theses, ...FIXTURE_SEARCH_BETA.theses];
  for (const post of [...FIXTURE_ALPHA_THESES.theses, ...hits.map((hit) => hit.thesis)]) {
    assert.deepEqual(Object.keys(post).sort(), keys);
    assert.deepEqual(Object.keys(post.disclosure).sort(), ["observedAt", "observedCheckpoint", "text", "verification", "walletAddress"]);
    assert.deepEqual(post.authorLabels, authorLabels(post));
  }
  for (const hit of hits) {
    assert.equal(hit.thesis.launchId, hit.launch.launchId);
    assert.deepEqual(Object.keys(hit.launch).sort(), [
      "coinType", "createdAtMs", "creator", "iconUrl", "launchId", "lifecycle", "name", "symbol",
    ]);
  }
  const firstPosted = FIXTURE_SEARCH_GRADUATION.theses.map((hit) => hit.thesis.postedAt);
  assert.deepEqual(firstPosted, [...firstPosted].sort().reverse(), "search hits: newest first post first, as a launch's list");
  const posted = FIXTURE_ALPHA_THESES.theses.map((post) => post.postedAt);
  assert.deepEqual(posted, [...posted].sort().reverse(), "newest first post first");
  assert.deepEqual(FIXTURE_SEARCH_EMPTY.theses, []);
});

test("no social or Theses source holds a raw bidirectional control character (Trojan Source)", async () => {
  const { readdirSync } = await import("node:fs");
  const roots = [
    new URL("./", import.meta.url),
    new URL("../../components/launchpad/theses/", import.meta.url),
    new URL("../../../../../packages/core/src/modules/launchpad-social/", import.meta.url),
    new URL("../../../../../packages/server/src/modules/launchpad-social/", import.meta.url),
  ];
  const bidi = /[\u202A-\u202E\u2066-\u2069]/u;
  const offenders = roots.flatMap((root) => readdirSync(root)
    .filter((name) => /\.(ts|tsx)$/.test(name))
    .filter((name) => bidi.test(readFileSync(new URL(name, root), "utf8")))
    .map((name) => `${root}/${name}`));
  assert.deepEqual(offenders, [], "write such characters as \\u escapes");
});

test("the write, the browser parser and the composer refuse the same controls and overrides", async () => {
  const { parseInertText } = await import("@blast/core/modules/launchpad-social/post-contract.ts");
  const { parseThesisListResponse } = await import("@blast/core/modules/launchpad-social/list-contract.ts");
  const { draftInput, EMPTY_DRAFT } = await import("#web/components/launchpad/theses/theses-model.ts");
  const [post] = FIXTURE_ALPHA_THESES.theses;
  for (const character of ["\u0000", "\u0007", "\u000B", "\u007F", "\u0085", "\u202A", "\u202E", "\u2066", "\u2069"]) {
    const text = `safe ${character} text`;
    const label = `U+${character.codePointAt(0)?.toString(16).padStart(4, "0")}`;
    assert.throws(() => parseInertText(text, 1_000), TypeError, label);
    const served = parseThesisListResponse({
      launchId: post.launchId,
      theses: { state: "available", data: { items: [{ ...post, body: text }], nextCursor: null }, provenance: {
        source: "replica", network: "mainnet", deployment: "5".repeat(64), checkpoint: 1, timestampMs: 1, observedAt: 1, lagMs: 0,
      } },
    }, post.launchId);
    assert.equal(served.theses.state, "unavailable", label);
    assert.ok(draftInput({ ...EMPTY_DRAFT, stance: "bullish", body: text }, post.launchId, null).problems, label);
  }
  for (const allowed of ["line one\nline two", "tab\there"]) assert.equal(parseInertText(allowed, 1_000), allowed);
});
