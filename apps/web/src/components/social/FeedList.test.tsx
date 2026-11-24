import assert from "node:assert/strict";
import test from "node:test";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { PathnameContext } from "next/dist/shared/lib/hooks-client-context.shared-runtime";

import { feedItem, feedPage, FIXTURE_NOW } from "../../../test/fixtures/social/feed-fixtures.ts";
import { FeedList } from "./FeedList";
import { SocialViewerProvider } from "./SignInGate";

/** Social-feed T-007 and UI-02: the feed list, rendered on the server. */

const ENDPOINT = "/api/social/feed?tab=for_you";

function at(node: ReactNode): string {
  return renderToStaticMarkup(<PathnameContext value="/">{node}</PathnameContext>);
}

function list(page: Parameters<typeof feedPage>[0] | null): string {
  return at(<FeedList endpoint={ENDPOINT} initial={page === null ? null : feedPage(page)} nowMs={FIXTURE_NOW} heading="Feed" />);
}

test("T-007-AC-4 (AC-042): with 61 s of lag the list says Activity is delayed and keeps its posts", () => {
  const delayed = list({ as_of: { checkpoint: 1, timestamp_ms: FIXTURE_NOW - 61_000, lag_ms: 61_000 } });
  assert.match(delayed, /role="status"[^>]*><strong>Activity is delayed\.<\/strong>/);
  assert.equal(delayed.match(/<article /g)?.length, 2);
  const boundary = list({ as_of: { checkpoint: 1, timestamp_ms: FIXTURE_NOW - 60_000, lag_ms: 60_000 } });
  assert.doesNotMatch(boundary, /Activity is delayed/);
  assert.doesNotMatch(list({}), /Activity is delayed/);
});

test("T-007-AC-6 (AC-064): one unlabelled public list of post cards with paging and no sign-up wall", () => {
  const html = list({});
  assert.match(html, /<section[^>]*aria-label="Feed"/);
  assert.match(html, /<ol[^>]*>.*<li data-post="a:5000:1:0:0"><article /s);
  // Scrolling loads more; the keyboard's "Show more" is there (shown on focus).
  assert.match(html, /<button[^>]*type="button"[^>]*>Show more<\/button>/);
  // No tab bar, no "For You" or "Following" label, no sign-up wall.
  assert.doesNotMatch(html, /role="tab|For You|>Following<|Sign up/i);
  const last = list({ next_cursor: null });
  assert.doesNotMatch(last, /Show more/);
  assert.match(last, /You’re all caught up\./);
});

test("T-007: an empty feed offers the next action; a failed server read leaves the first page to the browser", () => {
  const empty = list({ items: [], next_cursor: null });
  // The shared empty state, framed on its own card, with the next action.
  assert.match(empty, /<div class="empty card"><p class="title">Nothing here yet<\/p>/);
  assert.match(empty, /href="\/presale"/);
  assert.doesNotMatch(empty, /<ol/);
  const pending = list(null);
  // Placeholder cards the size of a post (no layout shift), and a status for assistive tech.
  assert.equal(pending.match(/aria-label="Loading post"/g)?.length, 3);
  assert.match(pending, /role="status"[^>]*>Loading posts…/);
  assert.match(pending, /aria-busy="true"/);
  assert.doesNotMatch(pending, /Nothing here yet|Show more/);
});

test("UI-02: a visitor's feed has no follow buttons and its rockets link to sign-in; a signed-in viewer's are buttons", () => {
  const visitor = list({});
  assert.equal(visitor.match(/data-gated="sign-in"/g)?.length, 2);
  assert.match(visitor, /<a[^>]*aria-label="Rocket, 41\. Sign in to react"[^>]*href="\/sign-in\?next=%2F"/);
  assert.doesNotMatch(visitor, />Follow</);
  const member = at(
    <SocialViewerProvider signedIn callsign="kai" getAccessToken={async () => "token"}>
      <FeedList endpoint={ENDPOINT} initial={feedPage({ items: [feedItem()] })} nowMs={FIXTURE_NOW} heading="Feed" />
    </SocialViewerProvider>,
  );
  assert.match(member, /<button[^>]*aria-label="Rocket, 41"[^>]*aria-pressed="false"/);
  assert.doesNotMatch(member, /sign-in/);
  // Follow shows only once the viewer state says "not following" (in the browser): never in the server HTML.
  assert.doesNotMatch(member, />Follow</);
});

test("Home drops expired cached pins while retaining ordinary posts about ended sales", () => {
  const expired = feedItem({ pinned: true });
  assert.ok(expired.presale);
  const presale = { ...expired.presale, lifecycle: "open" as const, end_ms: FIXTURE_NOW };
  const html = list({ items: [
    { ...expired, entry_id: "expired-pin", presale },
    { ...expired, entry_id: "ordinary-ended", pinned: false, presale },
    { ...expired, entry_id: "eligible-pin", presale: { ...presale, end_ms: FIXTURE_NOW + 1 } },
  ] });
  assert.doesNotMatch(html, /data-post="expired-pin"/);
  assert.match(html, /data-post="ordinary-ended"/);
  assert.match(html, /data-post="eligible-pin"/);
});
