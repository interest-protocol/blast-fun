import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";

import type { DiscoveryRow } from "@blast/core/modules/launchpad-discovery/rows.ts";
import type { SectionState } from "../primitives/data-state.ts";
import { VIEW_INFO, type ViewList } from "./discovery-model.ts";
import { DiscoveryList } from "./DiscoveryList.tsx";
import { DiscoveryRail } from "./DiscoveryRail.tsx";
import { rememberRail } from "./rail-memory.ts";

const id = (byte: string) => `0x${byte.repeat(32)}`;
const provenance = {
  network: "localnet",
  deployment: "5d2f2a4be1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c",
  checkpoint: "130",
  observedAt: "2026-09-24T07:31:01.218Z",
  lagMs: 412,
};

function row(byte: string, overrides: Partial<DiscoveryRow> = {}): DiscoveryRow {
  return {
    launchId: id(byte),
    coinType: `0x${byte.repeat(31)}ff::meme::MEME`,
    quoteType: "0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI",
    lifecycle: "live",
    name: "Froggy",
    symbol: "FROG",
    iconUrl: null,
    createdAtMs: 1_790_235_061_218,
    graduatedAtMs: null,
    quoteRemaining: "5000000000",
    quoteDecimals: 9,
    progressBps: 8333,
    partner: null,
    ...overrides,
  };
}

function text(html: string) {
  return html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

function render(state: SectionState<ViewList>, view: "new" | "near_graduation" | "graduated" = "new", selected: string | null = null) {
  return renderToStaticMarkup(
    <DiscoveryList view={view} state={state} selectedLaunchId={selected} loadingMore={false} onLoadMore={() => {}} onShowView={() => {}} />,
  );
}

test("rows link to their coin in the served order and disambiguate duplicate names and tickers", () => {
  const rows = [row("02"), row("01", { partner: { partnerId: id("bb"), status: "admitted" } }), row("07", { lifecycle: "migrated", graduatedAtMs: 1_790_235_061_218 })];
  const html = render({ status: "ready", value: { rows, nextCursor: null }, provenance }, "new", id("01"));
  const links = [...html.matchAll(/<a [^>]*href="\/coin\/([^"]+)"/g)].map((match) => decodeURIComponent(match[1]));
  assert.deepEqual(links, rows.map((item) => item.coinType));
  assert.match(html, /<ol/);
  for (const short of ["0x0202…0202", "0x0101…0101", "0x0707…0707"]) assert.ok(html.includes(short), short);
  assert.equal(html.match(/aria-current="page"/g)?.length, 1);
  assert.match(html, /aria-current="page"[^>]*href="\/coin\/0x0101|href="\/coin\/0x0101[^"]*"[^>]*aria-current="page"/);
  const words = text(html);
  assert.match(words, /FROG Froggy Live/);
  assert.match(words, /Graduated/);
  assert.match(words, /Created 24 Sept ’26/);
  assert.match(words, /Partner launch/);
  assert.doesNotMatch(words, /Source/);
  assert.doesNotMatch(html, /Load more/);
});

test("a row without metadata says so instead of inventing a name", () => {
  const html = render({ status: "ready", value: { rows: [row("05", { name: null, symbol: null })], nextCursor: null }, provenance });
  assert.match(text(html), /No ticker Unnamed coin/);
  assert.match(html, /0x0505…0505/);
});

test("near graduation rows state the quote left and progress; a next page is offered while one exists", () => {
  const html = render({ status: "ready", value: { rows: [row("03", { quoteRemaining: "0", progressBps: 10_000, lifecycle: "migration_ready" })], nextCursor: "next" }, provenance }, "near_graduation");
  assert.match(text(html), /0 SUI to graduate · 100%/);
  assert.match(text(html), /Graduating/);
  assert.match(html, /<button[^>]*>Load more launches<\/button>/);
});

test("an empty view says no matching Blast launch and offers the other views and Launch", () => {
  const near = text(render({ status: "empty", provenance }, "near_graduation"));
  assert.match(near, /Empty No Blast launch is near graduation right now\./);
  assert.match(near, /Show all launches/);
  assert.match(near, /Launch a coin/);
  const html = render({ status: "empty", provenance }, "new");
  assert.match(html, /href="\/launch"/);
  assert.doesNotMatch(text(html), /Show all launches/);
  assert.doesNotMatch(html, /<ol/);
});

test("Unavailable shows no rows; Stale keeps the last verified rows with their provenance", () => {
  const down = render({ status: "unavailable", reason: "the indexer is starting" });
  assert.match(text(down), /Unavailable Launches couldn’t load\./);
  assert.doesNotMatch(down, /<ol|href="\/coin/);
  const stale = render({ status: "stale", value: { rows: [row("01")], nextCursor: null }, provenance, reason: "Refresh failed: the indexer did not answer" });
  assert.match(text(stale), /Delayed Launches may be out of date/);
  assert.match(stale, /href="\/coin\/0x0101/);
  assert.doesNotMatch(text(stale), /Checkpoint 130/);
});

test("the rail offers exactly New, Near graduation and Graduated, explains the order, and has no Hot", () => {
  const html = renderToStaticMarkup(<DiscoveryRail selectedLaunchId={null} />);
  const views = [...html.matchAll(/<button[^>]*aria-pressed="(true|false)"[^>]*>([^<]+)<\/button>/g)].map((match) => [match[2], match[1]]);
  assert.deepEqual(views, [["New", "true"], ["Near graduation", "false"], ["Graduated", "false"]]);
  assert.doesNotMatch(text(html), /\bHot\b|Trending/i);
  assert.match(text(html), /Newest launch first, by creation checkpoint\./);
  assert.match(text(html), /Loading Fetching launches…/);
});

test("Near graduation explains that it lists live and graduating launches at 60% or more", () => {
  assert.equal(VIEW_INFO.near_graduation.order, "Highest progress first. Live and graduating launches at 60% or more.");
});

test("after choosing a launch the rail comes back on the same view and pages, marking the launch", () => {
  const rows = Array.from({ length: 12 }, (_, index) => row((index + 16).toString(16), { lifecycle: "migrated", graduatedAtMs: 1_790_235_061_218 }));
  const chosen = rows[11].launchId;
  rememberRail({
    view: "graduated",
    states: {
      new: { status: "loading" },
      near_graduation: { status: "loading" },
      graduated: { status: "ready", value: { rows, nextCursor: null }, provenance },
    },
    focusLaunchId: chosen,
  });
  try {
    const html = renderToStaticMarkup(<DiscoveryRail selectedLaunchId={chosen} />);
    assert.match(html, /aria-pressed="true"[^>]*>Graduated</);
    assert.equal([...html.matchAll(/href="\/coin\//g)].length, 12);
    const active = html.match(/<a\b[^>]*aria-current="page"[^>]*>/)?.[0];
    assert.ok(active?.includes(`href="/coin/${encodeURIComponent(rows[11].coinType)}"`));
    assert.ok(active?.includes(`data-launch-id="${chosen}"`));
  } finally {
    rememberRail(null);
  }
});
