import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { renderToStaticMarkup } from "react-dom/server";
import {
  PathParamsContext,
  SearchParamsContext,
} from "next/dist/shared/lib/hooks-client-context.shared-runtime";

import { SocialViewerProvider } from "../social/SignInGate";
import { WatchlistCardView } from "../social/watchlist/WatchlistCard";
import { createTestQueryClient, withQueryClient } from "#web/lib/query/test-client.ts";
import { queryKeys } from "#web/lib/query/keys.ts";
import { fixtureDetail, fixtureId } from "../../../../../packages/core/test/fixtures/presale-pages/presale-fixtures.ts";
import { PresalesLoading } from "#web/components/presale-pages/PresalesLoading.tsx";
import { SaleLoading } from "#web/components/presale-pages/SaleLoading.tsx";
import { HomeRailLoading } from "#web/components/social/happening/HomeRailLoading.tsx";
import { ProfileLoading } from "#web/components/social/profile/ProfileLoading.tsx";
import { FeedSkeleton } from "#web/components/social/FeedSkeleton.tsx";
import { PostLoading } from "#web/components/social/post/PostLoading.tsx";

const renderProfile = (viewer: string, callsign: string) =>
  renderToStaticMarkup(
    <PathParamsContext value={{ callsign }}>
      <SocialViewerProvider
        signedIn
        callsign={viewer}
        getAccessToken={async () => null}
      >
        <ProfileLoading />
      </SocialViewerProvider>
    </PathParamsContext>,
  );

test("profile loading preserves the destination's own and other-account headers and actions", () => {
  const own = JSDOM.fragment(renderProfile("kai", "kai"));
  const other = JSDOM.fragment(renderProfile("kai", "mira"));
  for (const page of [own, other]) {
    assert.equal(page.querySelector("h1")?.textContent, "Profile");
    // KA-2 (2026-11-14): a profile is a rail destination, so no back bar.
    assert.equal(page.querySelector("[data-back-bar]"), null);
  }

  const buttonLabels = (page: DocumentFragment) => [...page.querySelectorAll("button")].map((button) => button.getAttribute("aria-label") ?? button.textContent);
  const linkLabels = (page: DocumentFragment) => [...page.querySelectorAll("a")].map((link) => link.textContent);
  const hasFollowPlaceholder = (page: DocumentFragment) =>
    [...page.querySelectorAll('[aria-hidden="true"]')].some((element) => element.textContent === "Follow");
  assert.ok(own.querySelector('[aria-hidden="true"][class*="editSkeleton"]'));
  assert.ok(!buttonLabels(own).includes("Edit profile"));
  assert.ok(!linkLabels(own).includes("Settings"), "Settings lives in the account menu only");
  assert.equal(hasFollowPlaceholder(own), false);
  assert.equal(hasFollowPlaceholder(other), true);
  assert.ok(!buttonLabels(other).includes("Edit profile"));
});

test("presales loading follows the destination's calendar and status query", () => {
  const at = (search: string) =>
    renderToStaticMarkup(
      <SearchParamsContext value={new URLSearchParams(search)}>
        <PresalesLoading />
      </SearchParamsContext>,
    );
  const calendar = at("view=calendar");
  assert.doesNotMatch(calendar, /aria-label="Status"/);
  assert.match(calendar, /aria-label="Loading scheduled presales"/);
  assert.doesNotMatch(calendar, /class="[^"]*cal-item/);
  const ended = at("status=ended&sort=best");
  assert.match(ended, /role="tab"[^>]*aria-selected="true"[^>]*>Ended</);
  assert.match(ended, /aria-label="Filters, Best since launch"/);
  const invalid = at("status=invalid&sort=invalid");
  assert.match(invalid, /role="tab"[^>]*aria-selected="true"[^>]*>Live</);
  assert.match(invalid, /aria-label="Filters, Pinned first"/);
});

test("the watchlist uses its row skeleton while loading and shows its empty state only after loading", () => {
  const at = (status: "loading" | "ready") =>
    renderToStaticMarkup(
      <WatchlistCardView items={[]} total={0} status={status} nowMs={0} />,
    );
  assert.equal([...at("loading").matchAll(/class="lrow"/g)].length, 3);
  assert.doesNotMatch(at("loading"), /No saved presales/);
  assert.match(at("ready"), /No saved presales/);
});

test("post loading has the real back header and one post, with no fabricated balances", () => {
  const html = renderToStaticMarkup(<PostLoading />);
  assert.match(html, /aria-label="Back home"/);
  assert.equal([...html.matchAll(/aria-label="Loading post"/g)].length, 1);
  assert.doesNotMatch(html, /\$0|Nothing here|No posts/);
});

test("Home's rail skeleton reserves only the trending list", () => {
  const html = renderToStaticMarkup(<HomeRailLoading />);
  assert.match(html, /Loading trending coins/);
  assert.match(html, /aria-busy="true"/);
  assert.equal([...html.matchAll(/class="trendingRow"/g)].length, 5);
  assert.doesNotMatch(html, /Live activity|Fastest filling|data-card=|Gainers/);
});

test("Home loading uses square presale marks and event copy; a financial post keeps its own variant", () => {
  const feed = renderToStaticMarkup(<FeedSkeleton />);
  assert.equal([...feed.matchAll(/leadMark/g)].length, 3);
  assert.match(feed, /headline/);
  assert.doesNotMatch(feed, /actLine/);
  assert.match(renderToStaticMarkup(<PostLoading />), /actLine/);
});

test("an unknown sale reserves its lower sections and a neutral disabled action; a cached stage keeps its correct layout", () => {
  const client = createTestQueryClient();
  const at = (sale: string) => renderToStaticMarkup(withQueryClient(client,
    <PathParamsContext value={{ presaleId: fixtureId(sale) }}><SaleLoading /></PathParamsContext>,
  ));
  const cold = at("mrdn");
  // The Sale board's frame: the main card's tiles, the state line, then the 2 × 2 terms.
  assert.match(cold, /Total supply.*Ends in.*Backers.*Launches on.*sale-notice.*Tokenomics.*Where the money goes.*Rules.*Buyer vesting/s);
  assert.match(cold, /aria-label="Loading presale action"[^>]*disabled=""/);
  assert.match(cold, /aria-hidden="true"[^>]*>Buy allocation/);
  assert.doesNotMatch(cold, />Buy</);
  client.setQueryData(queryKeys.presales.detail(fixtureId("kstl")), fixtureDetail("kstl"));
  const cached = at("kstl");
  assert.match(cached, /Refreshing presale.*inert=""/);
  assert.match(cached, /Kestrel/);
  assert.match(cached, /Since launch/);
  assert.doesNotMatch(cached, /Loading presale…/);
  client.clear();
});

test("a sale loader without a route parameter remains a neutral pending view", () => {
  const html = renderToStaticMarkup(<PathParamsContext value={null}><SaleLoading /></PathParamsContext>);
  assert.match(html, /Loading presale/);
  assert.match(html, /data-sale-page=""/);
});
