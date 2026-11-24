import assert from "node:assert/strict";
import test from "node:test";

import type { Provenance } from "@blast/core/modules/launchpad-contract/read.ts";
import type { LaunchMatch, SearchResponse, ThesisMatch } from "@blast/core/modules/launchpad-search/contracts.ts";
import { handleSearchRequest, type SearchSources } from "@blast/server/modules/launchpad-search/resource.ts";
import { readSearch } from "./search-client.ts";
import {
  afterGroupPage,
  afterSearch,
  groupPageUrl,
  searchSummary,
  searchUrl,
  withLoadingMore,
  type SearchView,
} from "./search-model.ts";

const PROVENANCE: Provenance = {
  source: "replica",
  network: "mainnet",
  deployment: "5d2f2a4be1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c",
  checkpoint: 326_274_009,
  timestampMs: 1_790_000_000_000,
  observedAt: 1_790_000_000_412,
  lagMs: 412,
};

function coin(label: string, match: LaunchMatch["match"] = "ticker"): LaunchMatch {
  return {
    match,
    launch: {
      launchId: `0x${label.repeat(32)}`,
      coinType: `0x${label.repeat(32)}::toad::TOAD`,
      name: "Toad",
      symbol: "TOAD",
      iconUrl: null,
      lifecycle: "live",
      creator: null,
      createdAtMs: 1_790_000_000_000,
    },
    pool: null,
  };
}

const thesis: ThesisMatch = {
  match: "words",
  thesis: {
    id: "00000000-0000-4000-8000-000000000001",
    thesisId: "00000000-0000-4000-8000-000000000001",
    kind: "community_thesis",
    stance: "bullish",
    body: "Toad graduates soon.",
    authorLabels: [],
    postedAt: "2026-10-01T12:00:00.000Z",
    createdAt: "2026-10-01T12:00:00.000Z",
  },
  launch: coin("01").launch,
};

function answer(overrides: Partial<Record<"coins" | "theses", SearchResponse["groups"][number]["section"]>> = {}): SearchResponse {
  return {
    groups: [
      { group: "coins", section: (overrides.coins ?? { state: "available", data: { items: [coin("01"), coin("02")], nextCursor: "c2" }, provenance: PROVENANCE }) as never },
      { group: "theses", section: (overrides.theses ?? { state: "empty", provenance: PROVENANCE }) as never },
      { group: "profiles", section: { state: "unavailable", reason: "no-source" } },
    ],
  };
}

function results(view: SearchView) {
  assert.equal(view.status, "results");
  return view.status === "results" ? view.groups : [];
}

test("search URLs carry the query, and a group's next page its group and token", () => {
  assert.equal(searchUrl(" toad frog "), "/api/launchpad/search?q=toad+frog");
  assert.equal(groupPageUrl("toad", "coins", "c2"), "/api/launchpad/search?q=toad&group=coins&cursor=c2");
});

test("an answer becomes each group's honest state, in the served order", () => {
  const view = afterSearch("toad", answer({ theses: { state: "stale", data: { items: [thesis], nextCursor: null }, provenance: { ...PROVENANCE, reason: "indexer-lag" }, reason: "indexer-lag" } }));
  const groups = results(view);
  assert.deepEqual(groups.map((group) => [group.group, group.state.status]), [["coins", "ready"], ["theses", "stale"], ["profiles", "unavailable"]]);
  assert.equal(groups[1].state.status === "stale" && groups[1].state.reason, "The indexer is behind the chain");
  assert.equal(groups[2].state.status === "unavailable" && groups[2].state.reason, "Blast has no profile records yet");
  assert.equal(searchSummary(view), "3 matches in 2 groups. Profiles are unavailable.");
  assert.deepEqual(afterSearch("toad", null), { status: "failed", query: "toad", reason: "the request did not complete" });
  assert.deepEqual(afterSearch("!!!", "invalid"), { status: "invalid", query: "!!!" });
  assert.equal(searchSummary({ status: "searching", query: "toad" }), "Searching…");
});

test("no match anywhere says so; an unavailable group is never counted as empty", () => {
  const none = afterSearch("zzz", answer({ coins: { state: "empty", provenance: PROVENANCE } }));
  assert.equal(searchSummary(none), "No matches. Profiles are unavailable.");
  const down = afterSearch("zzz", answer({ coins: { state: "unavailable", reason: "error" } }));
  assert.equal(searchSummary(down), "No matches in the groups that answered. Coins and Profiles are unavailable.");
});

test("a next page appends new matches only, then ends; a failed page keeps the rows' state and says the page failed", () => {
  const first = afterSearch("toad", answer());
  const loading = withLoadingMore(first, "coins");
  assert.equal(results(loading)[0].loadingMore, true);
  const next: SearchResponse = { groups: [{ group: "coins", section: { state: "available", data: { items: [coin("02"), coin("03")], nextCursor: null }, provenance: PROVENANCE } }] };
  const more = results(afterGroupPage(loading, "coins", "toad", next));
  assert.equal(more[0].loadingMore, false);
  assert.equal(more[0].state.status, "ready");
  if (more[0].state.status === "ready") {
    assert.deepEqual(more[0].state.value.items.map((item) => item.launch.launchId), ["01", "02", "03"].map((label) => `0x${label.repeat(32)}`));
    assert.equal(more[0].state.value.nextCursor, null);
  }
  assert.equal(results(afterGroupPage(first, "theses", "toad", next))[1].state.status, "empty", "another group's page changes nothing");

  const failedView = afterGroupPage(loading, "coins", "toad", null);
  const failed = results(failedView)[0];
  assert.equal(failed.state.status, "ready", "the rows shown are as current as before; only the next page failed");
  assert.equal(failed.pageError, "More matches could not be loaded: the request did not complete");
  assert.equal(failed.state.status === "ready" && failed.state.value.items.length, 2);
  assert.equal(failed.state.status === "ready" && failed.state.value.nextCursor, "c2", "the page can be asked for again");
  const recovered = results(afterGroupPage(withLoadingMore(failedView, "coins"), "coins", "toad", next))[0];
  assert.equal(recovered.pageError, null, "a page that loads clears the earlier failure");
  assert.equal(recovered.state.status, "ready");
  const ended = results(afterGroupPage(loading, "coins", "toad", { groups: [{ group: "coins", section: { state: "empty", provenance: PROVENANCE } }] }))[0];
  assert.equal(ended.state.status === "ready" && ended.state.value.nextCursor, null);
});

/** The browser's fetch, answered by the real search resource over fixed sources. */
function browser(calls: Call[], sources: SearchSources | null): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return handleSearchRequest(new Request(new URL(String(input), "https://blast.test")), sources);
  }) as typeof fetch;
}

type Call = Readonly<{ url: string; init: RequestInit | undefined }>;

const fixedSources: SearchSources = {
  launches: async () => ({ status: "fresh", data: { items: [coin("01")], nextCursor: null }, provenance: PROVENANCE }),
  theses: async () => ({ status: "unavailable", provenance: { ...PROVENANCE, reason: "replica-unavailable" } }),
};

test("a search read bypasses the HTTP cache; refusals, outages and broken answers are told apart", async () => {
  const calls: Call[] = [];
  const answer = await readSearch(searchUrl("toad"), { fetcher: browser(calls, fixedSources) });
  assert.ok(answer && answer !== "invalid");
  assert.deepEqual(answer.groups.map((group) => [group.group, group.section.state]), [
    ["coins", "available"], ["theses", "unavailable"], ["profiles", "unavailable"],
  ]);
  assert.equal(calls[0].init?.cache, "no-store");

  assert.equal(await readSearch(searchUrl("!!!"), { fetcher: browser([], fixedSources) }), "invalid");
  const unconfigured = await readSearch(searchUrl("toad"), { fetcher: browser([], null) });
  assert.ok(unconfigured && unconfigured !== "invalid", "a 503 still carries each group's state");
  assert.equal(unconfigured.groups[0].section.state, "unavailable");
  const offline = (async () => {
    throw new TypeError("Failed to fetch");
  }) as typeof fetch;
  assert.equal(await readSearch(searchUrl("toad"), { fetcher: offline }), null);
  const garbage = (async () => new Response("<html>", { status: 200 })) as typeof fetch;
  assert.equal(await readSearch(searchUrl("toad"), { fetcher: garbage }), null);
  const teapot = (async () => Response.json({ groups: [] }, { status: 418 })) as typeof fetch;
  assert.equal(await readSearch(searchUrl("toad"), { fetcher: teapot }), null);
});

test("a search where no group answered is not reported as finding nothing", () => {
  const down = afterSearch("zzz", answer({ coins: { state: "unavailable", reason: "indexer-lag" }, theses: { state: "unavailable", reason: "indexer-lag" } }));
  assert.equal(searchSummary(down), "No group could be searched. Coins, Thesis and Profiles are unavailable.");
});

test("a page answer for an older query never lands on a newer query's results", () => {
  // "toad" was on screen; its Show more was in flight when the "frog" search landed.
  const frog = afterSearch("frog", answer({ coins: { state: "available", data: { items: [coin("f1")], nextCursor: "frog-page-2" }, provenance: PROVENANCE } }));
  const toadPage: SearchResponse = { groups: [{ group: "coins", section: { state: "available", data: { items: [coin("a2"), coin("a3")], nextCursor: "toad-page-3" }, provenance: PROVENANCE } }] };
  const after = afterGroupPage(frog, "coins", "toad", toadPage);
  assert.equal(after, frog, "the toad page is dropped");
  const [coins] = results(after);
  assert.equal(coins.state.status === "ready" && coins.state.value.items.map((item) => item.launch.launchId).join(), `0x${"f1".repeat(32)}`);
  assert.equal(coins.state.status === "ready" && coins.state.value.nextCursor, "frog-page-2", "frog keeps its own next page");
});

test("a theses page with no rows but a token is not a finding of nothing: more remain to search", async () => {
  const pending = afterSearch("zebra", answer({
    coins: { state: "empty", provenance: PROVENANCE },
    theses: { state: "available", data: { items: [], nextCursor: "t2" }, provenance: PROVENANCE },
  }));
  const theses = results(pending)[1];
  assert.equal(theses.state.status, "ready");
  assert.equal(theses.state.status === "ready" && theses.state.value.nextCursor, "t2", "Show more stays possible");
  assert.equal(searchSummary(pending), "No matches yet; more thesis remain to search. Profiles are unavailable.");
  const found = results(afterGroupPage(withLoadingMore(pending, "theses"), "theses", "zebra", {
    groups: [{ group: "theses", section: { state: "available", data: { items: [thesis], nextCursor: null }, provenance: PROVENANCE } }],
  }))[1];
  assert.equal(found.state.status === "ready" && found.state.value.items.length, 1);

  // Through the real resource: a source page of no rows and a token is served as available, not empty.
  const served = await readSearch(searchUrl("zebra"), {
    fetcher: browser([], {
      launches: async () => ({ status: "fresh", data: { items: [], nextCursor: null }, provenance: PROVENANCE }),
      theses: async () => ({ status: "fresh", data: { theses: [], nextCursor: "t2" }, provenance: PROVENANCE }),
    }),
  });
  assert.ok(served && served !== "invalid");
  assert.deepEqual(served.groups.find((group) => group.group === "theses")?.section, {
    state: "available", data: { items: [], nextCursor: "t2" }, provenance: PROVENANCE,
  });
});

test("an unavailable primary is worded for people, never as its reason code", () => {
  const down = afterSearch("zebra", answer({ theses: { state: "unavailable", reason: "social-unavailable" } }));
  const theses = results(down)[1];
  assert.equal(theses.state.status === "unavailable" && theses.state.reason, "the primary database did not answer");
});
