import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";

import type { Candle, MigrationMarker, PoolCandlePage } from "@blast/core/modules/launchpad-contract/venue-history.ts";
import type { Provenance } from "@blast/core/modules/launchpad-contract/read.ts";
import type { Section } from "@blast/core/modules/launchpad-contract/section.ts";

import type { ChartSource } from "./chart-client";
import { chartKey, chartRequest, type ChartControls, type ChartState } from "./chart-model";
import { ChartView, type ChartSourceName } from "./ChartView";

const T0 = 1_790_337_600_000;
const MINUTE = 60_000;
const CURVE_KEY = `blast_curve:0x${"a1".repeat(32)}`;
const VENUE_KEY = `cetus:0x${"c3".repeat(32)}`;
const MIGRATION: MigrationMarker = { cursor: "22:2:2:0", timestampMs: T0 + 5 * MINUTE + 19_000, curvePoolKey: CURVE_KEY, venuePoolKey: VENUE_KEY };
const PROVENANCE: Provenance = {
  source: "blast-infra",
  network: "localnet",
  deployment: "5d2f2a4be1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c",
  checkpoint: 38,
  timestampMs: T0 + 12 * MINUTE,
  observedAt: T0 + 12 * MINUTE + 400,
  lagMs: 400,
};
const CONTROLS: ChartControls = { interval: "1m", range: "all" };
const SOURCE: ChartSource = {
  expected: null,
  curvePoolKey: CURVE_KEY,
  venuePoolKey: VENUE_KEY,
  migration: MIGRATION,
  symbol: "FROGGY",
  quoteSymbol: "SUI",
  memeDecimals: 6,
  quoteDecimals: 9,
};

function candle(minute: number, open: string, close: string, volumeQuote = 2_000_000_000n): Candle {
  const [low, high] = Number(open) <= Number(close) ? [open, close] : [close, open];
  return { bucketStart: T0 + minute * MINUTE, open, high, low, close, volumeQuote, volumeMeme: 1n, volumeUsd: null, buys: 1, sells: 1, trades: 2 };
}

function page(poolKey: string, candles: Candle[]): PoolCandlePage {
  const venue = poolKey.split(":")[0] as PoolCandlePage["venue"];
  return { poolKey, source: venue === "blast_curve" ? "curve" : "venue", venue, interval: "1m", candles, migration: MIGRATION };
}

// The curve trades at minutes 0, 1 and 4 (no trades at 2 and 3), then migrates during minute 5;
// the venue's first swap is in the same minute, and it trades again at 7.
const CURVE_PAGE = page(CURVE_KEY, [candle(0, "0.0025", "0.003"), candle(1, "0.003", "0.004"), candle(4, "0.004", "0.0035"), candle(5, "0.0035", "0.005")]);
const VENUE_PAGE = page(VENUE_KEY, [candle(5, "0.015625", "0.016"), candle(7, "0.016", "0.0155")]);
const ready = (data: PoolCandlePage): Section<PoolCandlePage> => ({ state: "available", data, provenance: PROVENANCE });

const MIGRATED: ChartState = { key: "1m|all", curve: ready(CURVE_PAGE), venue: ready(VENUE_PAGE), migration: MIGRATION };

function render(state: ChartState, hidden: readonly ChartSourceName[] = [], source: ChartSource = SOURCE, controls: ChartControls = CONTROLS, compact = false, quoteUsd?: string) {
  return renderToStaticMarkup(
    <ChartView
      compact={compact}
      state={state}
      source={source}
      quoteUsd={quoteUsd}
      controls={controls}
      request={chartRequest(controls, T0 + 12 * MINUTE)}
      hidden={hidden}
      pending={false}
      updates={null}
      onControls={() => {}}
      onToggle={() => {}}
      onRefresh={() => {}}
    />,
  );
}

function text(html: string) {
  return html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
}

const count = (html: string, pattern: RegExp) => html.match(pattern)?.length ?? 0;

test("the curve and the venue are separate, labeled series around the committed migration", () => {
  const html = render(MIGRATED);
  const words = text(html);
  assert.match(words, /Bonding curve/);
  assert.match(words, /Cetus pool/);
  assert.match(text(html), /View Bonding curve chart values/);
  assert.match(text(html), /View Cetus pool chart values/);
  assert.equal(count(html, /data-marker="legend"/g), 1);
  assert.equal(count(words, /25 Sept ’26 · 12:05:00/g), 2, "both source tables retain the same-time candle");
  assert.match(html, /data-tradingview-plot/);
  assert.match(words, /Bonding curve candles, 1m intervals/);
  assert.match(words, /Cetus pool candles, 1m intervals/);
  assert.doesNotMatch(words, new RegExp(CURVE_KEY));
  assert.doesNotMatch(words, new RegExp(VENUE_KEY));
});

test("a missing interval is absent from the chart and named in the table, never a candle or a price", () => {
  const html = render(MIGRATED);
  assert.match(text(html), /No trades, no candle: 2 intervals/);
  assert.doesNotMatch(html, /<path[^>]*data-source/, "no line is drawn through the candles");
});

test("the table keeps each series’ candle values", () => {
  const words = text(render(MIGRATED));
  // 0.0025 Quote atoms per Meme atom with 6 and 9 decimals: 0.0000025 SUI per FROGGY.
  assert.match(words, /25 Sept ’26 · 12:00:00 0\.0000025 SUI 0\.000003 SUI 0\.0000025 SUI 0\.000003 SUI Up 2 SUI 1 buy, 1 sell/);
  assert.match(words, /0\.000015625 SUI/);
  assert.doesNotMatch(words, /Source Network|Checkpoint|blast_curve:/);
});

test("the candle table preserves the full price in the chart's display units", () => {
  const curve = page(CURVE_KEY, [candle(0, "0.0025", "0.002345678901234567")]);
  const words = text(render({ ...MIGRATED, curve: ready(curve) }, [], SOURCE, CONTROLS, false, "0.925"));
  assert.match(words, /\$0\.000002169752983641974475/);
});

test("an unavailable venue leaves the curve's history and the marker visible", () => {
  const html = render({ ...MIGRATED, venue: { state: "unavailable", reason: "not_ready", provenance: PROVENANCE } });
  const words = text(html);
  assert.match(words, /Cetus pool candles couldn’t load/);
  assert.match(text(html), /View Bonding curve chart values/);
  assert.doesNotMatch(text(html), /View Cetus pool chart values/);
  assert.equal(count(html, /data-marker="legend"/g), 1);
  assert.doesNotMatch(words, /No swaps/);
});

test("an outage keeps the last candles under a Stale label with when they were verified", () => {
  const stale: Section<PoolCandlePage> = { state: "stale", data: CURVE_PAGE, provenance: PROVENANCE, reason: "unreachable" };
  const html = render({ ...MIGRATED, curve: stale, venue: { state: "unavailable", reason: "unreachable" } });
  const words = text(html);
  assert.match(words, /Delayed Bonding curve candles may be out of date/);
  assert.match(text(html), /View Bonding curve chart values/);
  assert.doesNotMatch(words, /blast-infra|Last verified/);
});

test("hiding a source removes it from the chart and the table, never the marker", () => {
  const html = render(MIGRATED, ["curve"]);
  assert.doesNotMatch(text(html), /View Bonding curve chart values/);
  assert.match(text(html), /View Cetus pool chart values/);
  assert.doesNotMatch(text(html), new RegExp(`Bonding curve candles, ${CURVE_KEY}`));
  assert.equal(count(html, /data-marker="legend"/g), 1);
  assert.match(html, /<input type="checkbox"[^>]*(?![^>]*checked)[^>]*>/);
});

test("before migration the curve is the only source, and a migration without a tracked pool says so", () => {
  const before: ChartState = { key: "1m|all", curve: ready({ ...CURVE_PAGE, migration: null }), venue: null, migration: null };
  const words = text(render(before, [], { ...SOURCE, venuePoolKey: null, migration: null }));
  assert.match(words, /Bonding curve/);
  assert.doesNotMatch(words, /Cetus|Migration committed/);

  const untracked: ChartState = { ...MIGRATED, venue: null, migration: { ...MIGRATION, venuePoolKey: null } };
  const after = text(render(untracked, [], { ...SOURCE, venuePoolKey: null }));
  assert.match(after, /Graduation/);
  assert.match(after, /Venue pool candles couldn’t load/);
});

test("an empty range is Empty, and a loading source names what it reads", () => {
  const words = text(render({ ...MIGRATED, curve: { state: "empty", provenance: PROVENANCE }, venue: { state: "loading" } }));
  assert.match(words, /No bonding-curve trades in this range/);
  assert.match(words, /Loading cetus pool candles/);
});

test("the newest-candles note shows only when the page was capped at 2,000 candles and is full", () => {
  const now = T0 + 12 * MINUTE;
  const curveOnly = { ...SOURCE, venuePoolKey: null, migration: null };
  const view = (controls: ChartControls, candles: Candle[]) =>
    text(
      renderToStaticMarkup(
        <ChartView
          state={{ key: chartKey(controls), curve: ready({ ...page(CURVE_KEY, candles), interval: controls.interval, migration: null }), venue: null, migration: null }}
          source={curveOnly}
          controls={controls}
          request={chartRequest(controls, now)}
          hidden={[]}
          pending={false}
          updates={null}
          onControls={() => {}}
          onToggle={() => {}}
          onRefresh={() => {}}
        />,
      ),
    );
  // Every week of a 30-day range traded: its five candles are the whole range, nothing is left unread.
  const month: ChartControls = { interval: "1w", range: "30d" };
  const from = chartRequest(month, now).from!;
  const weeks = [0, 1, 2, 3, 4].map((week) => candle((from - T0) / MINUTE + week * 7 * 24 * 60, "0.0025", "0.0025"));
  assert.doesNotMatch(view(month, weeks), /Newest/);
  // All history in 1m candles: a full page of 2,000 may leave older history unread.
  const all: ChartControls = { interval: "1m", range: "all" };
  const full = Array.from({ length: 2000 }, (_, minute) => candle(minute - 1990, "0.0025", "0.0025"));
  assert.match(view(all, full), /Newest 2,000 candles · older history not loaded\./);
  assert.doesNotMatch(view(all, full.slice(1)), /Newest/);
  // A 30-day range holds more 1m buckets than a page: capped as well.
  assert.match(view({ interval: "1m", range: "30d" }, full), /Newest 2,000 candles in range · older history not loaded\./);
});

test("hiding every source says so, rather than leaving the chart blank", () => {
  const words = text(render(MIGRATED, ["curve", "venue"]));
  assert.match(words, /No chart series selected\./);
  assert.doesNotMatch(text(render(MIGRATED, ["venue"])), /No chart series selected/);
});

test("the chart describes the selected range and interval without exposing checkpoints", () => {
  const provenance = { ...PROVENANCE, timestampMs: T0 + 30 * MINUTE };
  const state: ChartState = { ...MIGRATED, venue: { state: "stale", data: VENUE_PAGE, reason: "not_ready", provenance } };
  const bounded: ChartControls = { interval: "1m", range: "1h" };
  assert.match(render(state, ["venue"], SOURCE, bounded), /price in SUI\. Last hour, 1m intervals/i);
  assert.match(render(state, ["venue"]), /price in SUI\. All history, 1m intervals/i);
  assert.doesNotMatch(text(render(state, ["venue"], SOURCE, bounded)), /[Cc]heckpoint/);
});

test("each candle keeps its exact direction in the accessible table", () => {
  const html = render(MIGRATED);
  // The curve rises at minutes 0, 1 and 5 and falls at 4; the venue rises at 5 and falls at 7.
  assert.match(html, /data-tradingview-plot/);
  const words = text(html);
  assert.match(words, /Interval start \(UTC\) Open High Low Close Direction Volume Trades/);
  assert.match(words, /25 Sept ’26 · 12:04:00 0\.000004 SUI 0\.000004 SUI 0\.0000035 SUI 0\.0000035 SUI Down/);
  assert.match(words, /25 Sept ’26 · 12:00:00 0\.0000025 SUI 0\.000003 SUI 0\.0000025 SUI 0\.000003 SUI Up/);
  // Drawn direction and the table's word come from one exact order: no candle in these pages is unchanged.
  assert.equal(count(html, /data-direction="flat"/g), 0);
  assert.equal(count(html, /data-open-tick/g), 0);
});

test("an unchanged candle remains named Unchanged", () => {
  const html = render({ key: "1m|all", curve: ready(page(CURVE_KEY, [candle(0, "0.003", "0.003")])), venue: null, migration: null });
  assert.match(html, /data-tradingview-plot/);
  assert.equal(count(html, /data-direction="up"/g), 0);

  assert.match(text(html), /Unchanged/);

});

test("compact chart exposes controls and history notices without a chart disclosure", () => {
  const html = render({ ...MIGRATED, venue: { state: "unavailable", reason: "not_ready" } }, [], SOURCE, CONTROLS, true);
  assert.match(text(html), /Cetus pool price history couldn’t load/);
  assert.doesNotMatch(html, /Chart info|chart values/i);
  assert.doesNotMatch(html, /Source details|type="checkbox"/);
  assert.equal(count(html, /aria-label="Chart range and interval: All · 1m"/g), 1);
  assert.doesNotMatch(html, /<select|>Refresh chart</);
  assert.doesNotMatch(text(html), /Candles & volume/, "a handful of candles is drawn as a line, so no style picker");
  assert.doesNotMatch(text(html), /Source Network|Show 4 bonding curve candles/);
});

test("delayed history with no known candles does not claim that there were no trades", () => {
  const curve = { state: "stale", data: { ...CURVE_PAGE, candles: [] }, reason: "not_ready", provenance: PROVENANCE } as const;
  const venue = { state: "empty", provenance: PROVENANCE } as const;
  const html = render({ ...MIGRATED, curve, venue }, [], SOURCE, CONTROLS, true);
  assert.match(html, /role="alert"/);
  assert.match(text(html), /Price history is delayed\. Try again/);
  assert.doesNotMatch(text(html), /No price history yet|No trades in this range/);
});

test("before the first trade the price heading has no dangling unit and the opening price is visible", () => {
  const source = { ...SOURCE, venuePoolKey: null, migration: null, opening: { timestampMs: T0 + 17_000, price: "0.002" } };
  const state: ChartState = { key: "1m|all", curve: { state: "empty", provenance: PROVENANCE }, venue: null, migration: null };
  const html = render(state, [], source, CONTROLS, true);
  assert.match(html, /<h2>Price<\/h2>/);
  assert.match(text(html), /Opening price 0\.000002 SUI/);
  assert.doesNotMatch(text(html), /Candles & volume/, "no chart, so no style to switch");
});

test("the first curve candle starts at the launch price when the range covers it", () => {
  const source = { ...SOURCE, opening: { timestampMs: T0 + 17_000, price: "0.002" } };
  const words = text(render(MIGRATED, [], source, CONTROLS, true, "3.42"));
  assert.match(words, /Price · USD/);
  assert.match(text(render(MIGRATED, [], source)), /25 Sept ’26 · 12:00:00 0\.000002 SUI 0\.000003 SUI 0\.000002 SUI 0\.000003 SUI Up/);

  const later = { ...MIGRATED, curve: ready({ ...CURVE_PAGE, candles: [candle(1, "0.003", "0.004")] }) };
  assert.match(text(render(later, [], source)), /25 Sept ’26 · 12:01:00 0\.000002 SUI 0\.000004 SUI 0\.000002 SUI 0\.000004 SUI Up/);
});

test("the full chart reads its price line in USD with a rate and in the quote without one", () => {
  const usd = text(render(MIGRATED, ["venue"], SOURCE, CONTROLS, false, "2"));
  assert.match(usd, /Last \$0\.0₄1 · High \$0\.0₄1 · Low \$0\.0₅5/);
  assert.equal(count(usd, /USD prices use the current SUI rate/g), 1);
  assert.match(usd, /\$0\.000005 \$0\.000006 \$0\.000005 \$0\.000006 Up 2 SUI/);
  const quote = text(render(MIGRATED, ["venue"]));
  assert.match(quote, /Last 0\.000005 SUI · High 0\.000005 SUI · Low 0\.0000025 SUI/);
  assert.doesNotMatch(quote, /USD prices/);
});

test("unknown token decimals suppress price labels and the plot even with a USD rate", () => {
  const source = { ...SOURCE, quoteDecimals: null };
  const html = render(MIGRATED, [], source, CONTROLS, true, "3.42");
  assert.doesNotMatch(html, /data-tradingview-plot|Price · USD/);
  assert.match(text(html), /Price units couldn’t load/);
  assert.doesNotMatch(text(render(MIGRATED, [], source)), /Quote atoms per Meme atom|2000000000/);
});

test("candles retain opening and closing prices more precise than their extrema", () => {
  const mixed = { ...candle(0, "1.123456", "1.567891"), low: "1", high: "2" };
  const state = { ...MIGRATED, curve: ready(page(CURVE_KEY, [mixed])) };
  const words = text(render(state, ["venue"]));
  assert.match(words, /0\.001123456 SUI 0\.002 SUI 0\.001 SUI 0\.001567891 SUI/);
});
