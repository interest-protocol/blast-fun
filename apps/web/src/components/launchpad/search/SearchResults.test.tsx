import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";

import type { Provenance } from "@blast/core/modules/launchpad-contract/read.ts";
import type { LaunchMatch, SearchResponse, ThesisMatch } from "@blast/core/modules/launchpad-search/contracts.ts";
import { LaunchpadSearch } from "./LaunchpadSearch.tsx";
import { SearchResults } from "./SearchResults.tsx";
import { afterSearch, type SearchView } from "./search-model.ts";

const PROVENANCE: Provenance = {
  source: "replica",
  network: "mainnet",
  deployment: "5d2f2a4be1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c",
  checkpoint: 326_274_009,
  timestampMs: 1_790_000_000_000,
  observedAt: 1_790_000_000_412,
  lagMs: 412,
};

const id = (byte: string) => `0x${byte.repeat(32)}`;

function launch(byte: string, match: LaunchMatch["match"], overrides: Partial<LaunchMatch["launch"]> = {}, pool: LaunchMatch["pool"] = null): LaunchMatch {
  return {
    match,
    launch: {
      launchId: id(byte),
      coinType: `0x${byte.repeat(31)}ff::pepe::PEPE`,
      name: "Pepe",
      symbol: "PEPE",
      iconUrl: null,
      lifecycle: "live",
      creator: id("e1"),
      createdAtMs: 1_790_235_061_218,
      ...overrides,
    },
    pool,
  };
}

const thesis: ThesisMatch = {
  match: "words",
  thesis: {
    id: "00000000-0000-4000-8000-000000000001",
    thesisId: "00000000-0000-4000-8000-000000000001",
    kind: "creator_update",
    stance: null,
    body: "Pepe graduates to Cetus <script>alert(1)</script>",
    authorLabels: ["creator", "wallet"],
    postedAt: "2026-10-01T12:00:00.000Z",
    createdAt: "2026-10-01T12:00:00.000Z",
  },
  launch: launch("02", "words").launch,
};

function view(groups: SearchResponse["groups"], query = "pepe"): SearchView {
  return afterSearch(query, { groups });
}

function render(state: SearchView) {
  return renderToStaticMarkup(<SearchResults view={state} onMore={() => {}} onClear={() => {}} onRetry={() => {}} onChoose={() => {}} />);
}

function text(html: string) {
  return html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

test("groups render in the served order, each labelled, exact matches marked in words", () => {
  const html = render(view([
    { group: "onchain", section: { state: "available", data: { items: [launch("01", "pool_id", {}, { venue: "cetus", poolId: id("c1") })], nextCursor: null }, provenance: PROVENANCE } },
    { group: "coins", section: { state: "available", data: { items: [launch("01", "ticker"), launch("02", "ticker", { lifecycle: "migrated", creator: null })], nextCursor: "next" }, provenance: PROVENANCE } },
    { group: "theses", section: { state: "available", data: { items: [thesis], nextCursor: null }, provenance: PROVENANCE } },
    { group: "profiles", section: { state: "unavailable", reason: "no-source" } },
  ]));
  const headings = [...html.matchAll(/<h3[^>]*>([^<]+)<\/h3>/g)].map((match) => match[1]);
  assert.deepEqual(headings, ["On-chain IDs", "Coins", "Thesis", "Profiles"]);
  for (const heading of headings) assert.match(html, new RegExp(`<section aria-labelledby="[^"]+"[^>]*>\\s*<div[^>]*><h3 id="[^"]+"[^>]*>${heading}`));
  const words = text(html);
  assert.match(words, /Exact Cetus pool ID/);
  assert.match(words, /Ticker match/);
  assert.doesNotMatch(words, /Exact Ticker/, "a ticker match is not exact");
  const links = [...html.matchAll(/<a [^>]*href="\/coin\/([^"]+)"/g)].map((match) => decodeURIComponent(match[1]));
  assert.deepEqual(links, ["01", "01", "02", "02"].map((byte) => launch(byte, "ticker").launch.coinType));
  assert.match(html, /<button[^>]*>Show more coins<\/button>/);
  assert.doesNotMatch(html, /Show more thesis/);
});

test("duplicate tickers stay distinguishable by launch ID, lifecycle and creator", () => {
  const words = text(render(view([
    { group: "coins", section: { state: "available", data: { items: [launch("01", "ticker"), launch("02", "ticker", { lifecycle: "migrated", creator: null })], nextCursor: null }, provenance: PROVENANCE } },
  ])));
  assert.match(words, /PEPE Live Pepe Ticker match Launch 0x0101…0101 · Creator 0xe1e1…e1e1 · Created 24 Sept ’26/);
  assert.match(words, /PEPE Graduated Pepe Ticker match Launch 0x0202…0202 · Creator not known yet · Created 24 Sept ’26/);
});

test("a thesis shows its launch, kind, labels and text as inert text", () => {
  const html = render(view([{ group: "theses", section: { state: "available", data: { items: [thesis], nextCursor: null }, provenance: PROVENANCE } }]));
  assert.match(text(html), /PEPE Live Pepe Launch 0x0202…0202 Creator update · Creator · Disclosed wallet/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /<time [^>]*dateTime="2026-10-01T12:00:00.000Z" title="2026-10-01 12:00:00 UTC">1 Oct ’26<\/time>/);
});

test("no match offers Clear search and Launch, while an unavailable group stays visible", () => {
  const html = render(view([
    { group: "coins", section: { state: "empty", provenance: PROVENANCE } },
    { group: "theses", section: { state: "unavailable", reason: "error" } },
    { group: "profiles", section: { state: "unavailable", reason: "no-source" } },
  ], "zzz"));
  const words = text(html);
  assert.match(words, /Empty No Blast coin matches “zzz”\./, "only the groups that answered are claimed empty");
  assert.match(html, /<button[^>]*>Clear search<\/button>/);
  assert.match(html, /href="\/launch"[^>]*>Launch a coin<\/a>/);
  assert.match(words, /Unavailable Thesis couldn’t load\./);
  assert.match(words, /Unavailable Profiles couldn’t load./);
  assert.doesNotMatch(html, /href="\/coin\//);
});

test("empty groups beside matches are summed up in one line, and stale matches say so", () => {
  const words = text(render(view([
    { group: "onchain", section: { state: "empty", provenance: PROVENANCE } },
    { group: "wallets", section: { state: "empty", provenance: PROVENANCE } },
    { group: "coins", section: { state: "stale", data: { items: [launch("01", "coin_type")], nextCursor: null }, provenance: { ...PROVENANCE, reason: "indexer-lag" }, reason: "indexer-lag" } },
    { group: "profiles", section: { state: "unavailable", reason: "no-source" } },
  ], id("01"))));
  assert.match(words, /No matches in On-chain IDs and Wallets\./);
  assert.match(words, /Delayed These results may be out of date\./);
  assert.match(words, /Exact coin type/);
});

test("before a search the surface shows no filler; a failure offers a retry", () => {
  const idle = text(render({ status: "idle" }));
  assert.equal(idle, "");
  assert.doesNotMatch(idle, /Trending|Hot|Popular/);
  const failed = render({ status: "failed", query: "pepe", reason: "the request did not complete" });
  assert.match(text(failed), /Unavailable Search couldn’t finish\./);
  assert.match(failed, /<button[^>]*>Try again<\/button>/);
});

test("the search field is labelled, bounded and focused when Search opens", () => {
  const html = renderToStaticMarkup(<LaunchpadSearch />);
  assert.match(html, /<form[^>]*role="search"/);
  const input = /<input[^>]*>/.exec(html)?.[0] ?? "";
  assert.match(input, /type="search"/);
  assert.match(input, /maxLength="235"/);
  assert.match(input, /data-autofocus="true"/, "the focus surface focuses it on open");
  const inputId = /id="([^"]+)"/.exec(input)?.[1];
  assert.match(html, new RegExp(`<label[^>]*for="${inputId}"`));
  assert.match(html, /role="status"/);
});

test("when no group can be searched the surface says so and offers a retry, not an empty result", () => {
  const down = view([
    { group: "coins", section: { state: "unavailable", reason: "indexer-lag" } },
    { group: "theses", section: { state: "unavailable", reason: "indexer-lag" } },
    { group: "profiles", section: { state: "unavailable", reason: "no-source" } },
  ]);
  const html = render(down);
  const words = text(html);
  assert.match(words, /Unavailable Search couldn’t finish\./);
  assert.match(html, /<button[^>]*>Try again<\/button>/);
  assert.doesNotMatch(words, /Empty|No Blast|unaffected/);
  assert.match(words, /Unavailable Coins couldn’t load./);
});

test("theses say they are ordered by first post, and a revised thesis shows both times", () => {
  const revised: ThesisMatch = {
    ...thesis,
    thesis: { ...thesis.thesis, postedAt: "2026-10-01T11:00:00.000Z", createdAt: "2026-10-01T12:10:00.000Z" },
  };
  const words = text(render(view([{ group: "theses", section: { state: "available", data: { items: [thesis, revised], nextCursor: null }, provenance: PROVENANCE } }])));
  assert.match(words, /Public thesis containing every word, newest first post first; a revision keeps its place\./);
  assert.match(words, /Posted 1 Oct ’26 PEPE/, "an unrevised thesis shows one time");
  assert.match(words, /Posted 1 Oct ’26 · revised 1 Oct ’26/);
});

test("Show more is unavailable while a search runs or its page loads, and keeps focus while it waits", () => {
  const ready = view([{ group: "coins", section: { state: "available", data: { items: [launch("01", "ticker")], nextCursor: "next" }, provenance: PROVENANCE } }]);
  const button = (html: string) => (html.match(/<button\b[^>]*>[\s\S]*?<\/button>/g) ?? []).find((markup) => markup.includes("Show more coins")) ?? "";
  const idle = button(render(ready));
  assert.doesNotMatch(idle, /aria-disabled|disabled=""/);
  const searching = button(renderToStaticMarkup(<SearchResults view={ready} busy onMore={() => {}} onClear={() => {}} onRetry={() => {}} onChoose={() => {}} />));
  assert.match(searching, /aria-disabled="true"/, "a newer search is running: its rows are about to be replaced");
  const loading = ready.status === "results" ? { ...ready, groups: ready.groups.map((group) => ({ ...group, loadingMore: true })) } : ready;
  const waiting = button(render(loading));
  assert.match(waiting, /aria-disabled="true"[^>]*aria-busy="true"|aria-busy="true"[^>]*aria-disabled="true"/);
  assert.match(waiting, /aria-label="Loading more coins"/);
  for (const html of [searching, waiting]) assert.doesNotMatch(html, /disabled=""/, "not disabled: a focused button keeps focus");
});

test("stale groups that found nothing are named in the empty sentence and render no list", () => {
  const lagging = { ...PROVENANCE, reason: "indexer-lag" };
  const html = render(view([
    { group: "coins", section: { state: "stale", data: { items: [], nextCursor: null }, provenance: lagging, reason: "indexer-lag" } },
    { group: "theses", section: { state: "stale", data: { items: [], nextCursor: null }, provenance: lagging, reason: "indexer-lag" } },
    { group: "profiles", section: { state: "unavailable", reason: "no-source" } },
  ], "zzz"));
  const words = text(html);
  assert.match(words, /Empty No Blast coin or thesis matches “zzz”\./);
  assert.match(html, /<button[^>]*>Clear search<\/button>/);
  assert.doesNotMatch(html, /<ol/, "no empty lists");
  assert.doesNotMatch(words, /newest launch first within each|every word, newest first/, "no order line above nothing");
  assert.equal(words.match(/Delayed These results may be out of date\./g)?.length, 2,
    "each group still says its answer is stale");
});

test("a failed Show more says so beside the button and leaves the rows' own state alone", () => {
  const ready = view([{ group: "coins", section: { state: "available", data: { items: [launch("01", "ticker")], nextCursor: "next" }, provenance: PROVENANCE } }]);
  const failed = ready.status === "results"
    ? { ...ready, groups: ready.groups.map((group) => ({ ...group, pageError: "More matches could not be loaded: the request did not complete" })) }
    : ready;
  const words = text(render(failed));
  assert.match(words, /Unavailable More results couldn’t load\. Try again\. Show more coins/);
  assert.doesNotMatch(words, /Stale/);
});

test("a theses group with no rows yet but a token offers Show more instead of claiming no match", () => {
  const html = render(view([
    { group: "coins", section: { state: "empty", provenance: PROVENANCE } },
    { group: "theses", section: { state: "available", data: { items: [], nextCursor: "t2" }, provenance: PROVENANCE } },
    { group: "profiles", section: { state: "unavailable", reason: "no-source" } },
  ], "zebra"));
  const words = text(html);
  assert.doesNotMatch(words, /No Blast (coin or )?thesis matches/);
  assert.match(words, /No thesis found yet; more remain to search\./);
  assert.match(html, /<button[^>]*>Show more thesis<\/button>/);
  assert.match(words, /No matches in Coins\./);
});
