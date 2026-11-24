import assert from "node:assert/strict";
import test from "node:test";

import { FIXTURE_ALPHA_THESES, FIXTURE_LAUNCH_ALPHA } from "../../../../../../packages/server/test/fixtures/modules/launchpad-social/fixtures.ts";
import type { PublicPost } from "@blast/core/modules/launchpad-social/post-contract.ts";
import {
  afterMore,
  afterRead,
  draftInput,
  EMPTY_DRAFT,
  evidenceLink,
  INITIAL_THESES,
  moreFocusIndex,
  postAttribution,
  type ComposerDraft,
  postFacts,
  publishedNote,
} from "./theses-model.ts";

const PROVENANCE = {
  source: "replica", network: "mainnet", deployment: "5".repeat(64), checkpoint: 326_274_009, timestampMs: 1, observedAt: 1_790_000_000_000, lagMs: 400,
} as const;
const [UPDATE, DUPLICATE, REVISED] = FIXTURE_ALPHA_THESES.theses;
const WALLET = `0x${"a3".repeat(32)}`;

function served(items: readonly PublicPost[], nextCursor: string | null = null) {
  return { launchId: FIXTURE_LAUNCH_ALPHA, theses: { state: "available", data: { items, nextCursor }, provenance: PROVENANCE } } as const;
}

test("labels state only checked facts with the time they were observed", () => {
  assert.deepEqual(postFacts(UPDATE, "ALPHA"), [
    { term: "Creator", detail: "Posted from the launch creator’s wallet. Checked", checkedAt: "2026-10-01T12:45:00.000Z" },
    { term: "Disclosed wallet", detail: "0x4242…4242", full: `0x${"42".repeat(32)}` },
    { term: "Holding", detail: "Held ALPHA when checked on", checkedAt: "2026-10-01T12:44:59.000Z" },
    { term: "Author's disclosure", detail: "Creator wallet, holding the launch allocation." },
  ]);
  assert.deepEqual(postFacts(REVISED, null).slice(1), [
    { term: "Holding", detail: "This wallet did not hold this coin when checked on", checkedAt: "2026-10-01T12:29:58.000Z" },
    { term: "Author's disclosure", detail: "Small holder." },
  ]);
  const unavailable: PublicPost = { ...REVISED, disclosure: { ...REVISED.disclosure, verification: "unavailable", observedCheckpoint: null, observedAt: null } };
  assert.deepEqual(postFacts(unavailable, "ALPHA")[1], {
    term: "Holding", detail: "Blast couldn’t check this wallet’s balance when the post was published.",
  });
  assert.deepEqual(postFacts(DUPLICATE, "ALPHA"), [], "no disclosure, no creator: no label at all");
  // A revision is checked again when written: its Creator fact is observed at the revision's own time.
  const revisedUpdate: PublicPost = { ...UPDATE, revisionOf: UPDATE.id, id: REVISED.id, createdAt: "2026-10-01T13:00:00.000Z" };
  assert.equal(postFacts(revisedUpdate, "ALPHA")[0].checkedAt, revisedUpdate.createdAt);
  for (const fact of [...postFacts(UPDATE, "ALPHA"), ...postFacts(REVISED, "ALPHA")]) {
    assert.doesNotMatch(`${fact.term} ${fact.detail}`, /verified creator|trusted|safe|endorse|recommend|✓/i, "a fact, never an endorsement");
  }
});

test("every post is attributed to its author as a claim Blast does not endorse", () => {
  assert.equal(postAttribution(DUPLICATE), "Community thesis: the author's own claim. Blast does not review or endorse it.");
  assert.equal(postAttribution(UPDATE), "Creator update: the creator's own claim. Blast does not review or endorse it.");
  assert.equal(postAttribution({ ...UPDATE, kind: "creator_thesis" }), "Creator thesis: the creator's own claim. Blast does not review or endorse it.");
});

test("an evidence link is shown only as an https link without credentials, by its host", () => {
  assert.deepEqual(evidenceLink("https://example.com/alpha-thread?x=1"), { href: "https://example.com/alpha-thread?x=1", host: "example.com", text: "example.com/alpha-thread?x=1" });
  assert.equal(evidenceLink(`https://example.com/${"a".repeat(80)}`)?.text.length, 60);
  for (const unsafe of ["javascript:alert(1)", "http://example.com/", "https://user:pw@example.com/", "data:text/html,x", "//example.com", "not a url"]) {
    assert.equal(evidenceLink(unsafe), null, unsafe);
  }
});

test("pages load newest first; a failed refresh keeps the shown theses Stale and a failed page keeps them all", () => {
  const ready = afterRead(INITIAL_THESES, served([UPDATE, DUPLICATE], "token-2"));
  assert.equal(ready.section.status, "ready");
  const more = afterMore({ ...ready, loadingMore: true }, served([REVISED]));
  assert.ok(more.section.status === "ready");
  assert.deepEqual(more.section.value.items.map((post) => post.id), [UPDATE.id, DUPLICATE.id, REVISED.id]);
  assert.equal(more.section.value.nextCursor, null);
  assert.equal(more.loadingMore, false);

  const failedPage = afterMore({ ...ready, loadingMore: true }, null);
  assert.ok(failedPage.section.status === "ready");
  assert.equal(failedPage.section.value.items.length, 2);
  assert.match(failedPage.moreError ?? "", /More posts couldn’t load/);

  const stale = afterRead(ready, { launchId: FIXTURE_LAUNCH_ALPHA, theses: { state: "unavailable", reason: "social-unavailable" } });
  assert.ok(stale.section.status === "stale");
  assert.match(stale.section.reason, /primary database did not answer/);
  assert.deepEqual(afterRead(INITIAL_THESES, null).section, { status: "unavailable", reason: "the request did not complete" });
  assert.deepEqual(afterRead(INITIAL_THESES, { launchId: FIXTURE_LAUNCH_ALPHA, theses: { state: "empty", provenance: PROVENANCE } }).section.status, "empty");
});

test("a draft becomes the exact write input, or says what to fix before anything is sent", () => {
  const draft: ComposerDraft = {
    ...EMPTY_DRAFT,
    stance: "bullish",
    body: "  Graduation looks near.\r\nThe creator answers.  ",
    links: "https://example.com/a\n\nhttps://example.com/a https://example.org/b",
    disclosureText: "Small holder.",
    discloseWallet: true,
  };
  assert.deepEqual(draftInput(draft, FIXTURE_LAUNCH_ALPHA, WALLET), {
    input: {
      launchId: FIXTURE_LAUNCH_ALPHA,
      kind: "community_thesis",
      stance: "bullish",
      body: "Graduation looks near.\nThe creator answers.",
      evidenceLinks: ["https://example.com/a", "https://example.org/b"],
      disclosure: { text: "Small holder.", walletAddress: WALLET },
      revisionOf: null,
    },
  });
  assert.deepEqual(draftInput({ ...draft, discloseWallet: false, disclosureText: " " }, FIXTURE_LAUNCH_ALPHA, WALLET).input?.disclosure, { text: null, walletAddress: null });
  assert.equal(draftInput({ ...draft, kind: "creator_update", stance: null }, FIXTURE_LAUNCH_ALPHA, null).input?.stance, null);

  const problems = (change: Partial<ComposerDraft>) => draftInput({ ...draft, ...change }, FIXTURE_LAUNCH_ALPHA, WALLET).problems;
  assert.deepEqual(problems({ body: "   " }), ["Write the thesis: 1 to 1,000 characters."]);
  assert.deepEqual(problems({ body: "x".repeat(1_001) }), ["Write the thesis: 1 to 1,000 characters."]);
  assert.deepEqual(problems({ body: "safe \u202E txet" }), ["The thesis holds a control or direction-override character; remove it."]);
  assert.deepEqual(problems({ stance: null }), ["Choose a stance: Bullish, Bearish or Neutral."]);
  assert.deepEqual(problems({ links: "http://example.com/a" }), ["Evidence links must be https links without a password, at most 3."]);
  assert.deepEqual(problems({ links: "https://a.example/ https://b.example/ https://c.example/ https://d.example/" }), ["Evidence links must be https links without a password, at most 3."]);
  assert.deepEqual(problems({ disclosureText: "y".repeat(281) }), ["Keep the disclosure to 280 characters."]);
});

test("after posting, the author learns what was stored: the kind kept and the holding observed", () => {
  assert.equal(publishedNote("community_thesis", DUPLICATE), "Posted as a community thesis.");
  assert.equal(publishedNote("creator_update", UPDATE), "Posted as a creator update. The wallet held the coin when checked.");
  assert.equal(
    publishedNote("creator_thesis", REVISED),
    "Posted as a community thesis. Creator posts require the launch creator’s wallet. No balance found for this wallet.",
  );
});

test("after Show more, focus moves to the first new post, or to the last post when the button went away with nothing new", () => {
  assert.equal(moreFocusIndex(20, 25, false), 20, "the first new post");
  assert.equal(moreFocusIndex(20, 25, true), 20);
  assert.equal(moreFocusIndex(20, 20, true), 19, "the button vanished with focus on it: the last post");
  assert.equal(moreFocusIndex(20, 20, false), null, "focus still on the page's button or moved by the reader: leave it");
  assert.equal(moreFocusIndex(0, 0, true), null);
});
