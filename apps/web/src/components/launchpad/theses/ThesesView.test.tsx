import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";

import { FIXTURE_ALPHA_THESES, FIXTURE_LAUNCH_ALPHA } from "../../../../../../packages/server/test/fixtures/modules/launchpad-social/fixtures.ts";
import type { PublicPost } from "@blast/core/modules/launchpad-social/post-contract.ts";

import { ComposerForm } from "./ComposerForm";
import { afterRead, EMPTY_DRAFT, INITIAL_THESES, type ThesesState } from "./theses-model";
import { ThesesView } from "./ThesesView";

const PROVENANCE = {
  source: "replica", network: "mainnet", deployment: "5d2f2a4be1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c",
  checkpoint: 326_274_009, timestampMs: 1, observedAt: 1_790_000_000_000, lagMs: 400,
} as const;
const [UPDATE, DUPLICATE, REVISED] = FIXTURE_ALPHA_THESES.theses;

function stateOf(items: readonly PublicPost[], nextCursor: string | null = null): ThesesState {
  return afterRead(INITIAL_THESES, { launchId: FIXTURE_LAUNCH_ALPHA, theses: { state: "available", data: { items, nextCursor }, provenance: PROVENANCE } });
}

function render(state: ThesesState) {
  return renderToStaticMarkup(<ThesesView state={state} symbol="ALPHA" onMore={() => {}} onRetry={() => {}} />);
}

function text(html: string) {
  return html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&quot;/g, "\"").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
}

test("each post shows its kind, stance, author, text, evidence, checked facts, times and provenance", () => {
  const html = render(stateOf([UPDATE, DUPLICATE, REVISED], "next"));
  const words = text(html);
  assert.equal(html.match(/<article/g)?.length, 3);
  assert.equal(html.match(/<article[^>]*tabindex="-1"/g)?.length, 3, "each post can take focus after Show more");
  assert.match(words, /Creator update Author 00000000…00a1/);
  assert.match(words, /Liquidity plan published; migration target unchanged\./);
  assert.match(words, /Creator update: the creator's own claim\. Blast does not review or endorse it\./);
  assert.match(words, /Creator Posted from the launch creator’s wallet\. Checked 1 Oct ’26 ?\./);
  assert.match(words, /Holding Held ALPHA when checked on 1 Oct ’26 ?\./);
  assert.match(words, /Community thesis Neutral Author 00000000…00c3/);
  assert.match(words, /Community thesis: the author's own claim\. Blast does not review or endorse it\./);
  assert.match(words, /Posted 1 Oct ’26 · revised 1 Oct ’26/);
  assert.doesNotMatch(words, /[Cc]heckpoint|5d2f2a/);
  assert.match(html, /<a href="https:\/\/example\.com\/alpha-plan" rel="nofollow noopener noreferrer ugc" target="_blank" referrerPolicy="no-referrer">example\.com\/alpha-plan<\/a>/);
  assert.match(html, /white-space|class="body"/, "the body keeps its line breaks as text");
  assert.match(words, /Show more thesis/);
  assert.doesNotMatch(words, /Source Network Sui mainnet/);
});

test("text and links stay inert: markup is shown as text and only https links are links", () => {
  const hostile: PublicPost = {
    ...DUPLICATE,
    body: "<script>alert(1)</script> [click](javascript:alert(1)) <img src=x onerror=alert(1)>",
    evidenceLinks: ["https://example.com/ok", "javascript:alert(1)"],
    disclosure: { ...DUPLICATE.disclosure, text: "<b>bold</b>" },
  };
  const html = render(stateOf([hostile]));
  assert.doesNotMatch(html, /<script|<img|<b>|href="javascript/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.equal(html.match(/<a /g)?.length, 1, "only the https link is a link");
});

test("no score, summary, profit, copy trading or chat appears anywhere", () => {
  const words = text(render(stateOf([UPDATE, DUPLICATE, REVISED])));
  assert.doesNotMatch(words, /\bscore|summary|summar|\bAI\b|PnL|profit|copy|chat|follow|reply|like/i);
});

test("loading, empty, stale and unavailable theses say so in words; a failed page keeps the posts", () => {
  assert.match(text(render(INITIAL_THESES)), /Loading Fetching thesis…/);
  const empty = afterRead(INITIAL_THESES, { launchId: FIXTURE_LAUNCH_ALPHA, theses: { state: "empty", provenance: PROVENANCE } });
  assert.match(text(render(empty)), /Empty No thesis on this launch yet\. Post the first one below\./);
  const unavailable = afterRead(INITIAL_THESES, null);
  assert.match(text(render(unavailable)), /Unavailable Thesis couldn’t load\. Try again/);
  const stale = afterRead(stateOf([DUPLICATE]), { launchId: FIXTURE_LAUNCH_ALPHA, theses: { state: "unavailable", reason: "replica-unavailable" } });
  const staleWords = text(render(stale));
  assert.match(staleWords, /Delayed Thesis may be out of date/);
  assert.match(staleWords, /Graduation looks near for Alpha\./);
  const failedPage = { ...stateOf([DUPLICATE], "next"), moreError: "More posts couldn’t load. Try again." };
  assert.match(text(render(failedPage)), /Graduation looks near for Alpha\. .*More posts couldn’t load/);
  const loadingMore = render({ ...stateOf([DUPLICATE], "next"), loadingMore: true });
  assert.match(loadingMore, /aria-label="Loading more thesis"/);
});

function form(overrides: Partial<Parameters<typeof ComposerForm>[0]> = {}) {
  return renderToStaticMarkup(
    <ComposerForm
      draft={EMPTY_DRAFT}
      signers={["privy", "wallet"]}
      pending={null}
      problems={[]}
      result={null}
      onChange={() => {}}
      onPost={() => {}}
      {...overrides}
    />,
  );
}

test("the composer labels every field with its limit and offers each credential the app supports", () => {
  const html = form();
  const words = text(html);
  assert.match(html, /<select[^>]*id="[^"]+"/);
  assert.match(words, /Kind Community thesis Creator thesis Creator update/);
  assert.match(words, /A creator thesis or update stays one only when posted from this launch's creator wallet; otherwise it is posted as a community thesis\./);
  assert.match(html, /<fieldset[^>]*><legend[^>]*>Stance<\/legend>/);
  assert.equal(html.match(/type="radio"/g)?.length, 3);
  assert.match(words, /Thesis 0 \/ 1,000/);
  assert.match(words, /Evidence links https only, up to 3, separated by spaces or lines/);
  assert.match(words, /Disclosure \(optional\) 0 \/ 280/);
  assert.match(words, /Share the wallet I post with and whether it held this coin when Blast checked\./);
  assert.match(words, /Post with Privy Post with wallet/);
  assert.match(words, /Signing in with Privy or signing a free wallet message posts under that identity\. A wallet message is not a transaction\./);
  assert.doesNotMatch(text(form({ signers: ["wallet"] })), /Post with Privy/);
});

test("a creator update needs no stance; problems, progress and the result are announced", () => {
  assert.match(text(form({ draft: { ...EMPTY_DRAFT, kind: "creator_update" } })), /Stance \(optional for a creator update\)/);
  const blocked = form({ problems: ["Choose a stance: Bullish, Bearish or Neutral."] });
  assert.match(blocked, /role="alert"[^>]*>.*Choose a stance/s);
  const posting = form({ pending: "wallet" });
  assert.match(posting, /aria-disabled="true"/);
  assert.match(text(posting), /Waiting for the wallet and Blast…/);
  const done = form({ result: { tone: "ok", message: "Posted as a community thesis." } });
  assert.match(done, /role="status"[^>]*>Posted as a community thesis\./);
});
