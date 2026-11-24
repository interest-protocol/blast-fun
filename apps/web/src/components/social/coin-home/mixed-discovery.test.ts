import assert from "node:assert/strict";
import test from "node:test";

import type { DiscoveryResponse, DiscoveryRow } from "@blast/core/modules/launchpad-discovery/rows.ts";
import { BLAST_V1_COINS } from "@blast/core/modules/social/portfolio/core-coins.ts";

import { FIXTURE_NOW } from "#web/test/fixtures/social/feed-fixtures.ts";
import { happeningPresale, happeningRead } from "#web/test/fixtures/social/happening/happening-fixtures.ts";
import { homeCoinRows } from "#web/test/fixtures/workspace/coin-fixtures.ts";
import { mixedDiscoveryEntries } from "./mixed-discovery.ts";

const minute = 60_000;
const day = 1_440 * minute;
const curve = (symbol: string, progressBps: number, age: number): DiscoveryRow => ({
  launchId: `launch-${symbol}`, coinType: `0xab::coin::${symbol}`, quoteType: "0x2::sui::SUI",
  lifecycle: "live", name: symbol, symbol, iconUrl: null, createdAtMs: FIXTURE_NOW - age,
  graduatedAtMs: null, quoteRemaining: "100000000000", quoteDecimals: 9, progressBps, partner: null,
});
const catalog = (rows: readonly DiscoveryRow[]): DiscoveryResponse => ({
  view: "new",
  section: { state: "available", data: { rows, nextCursor: null }, provenance: {
    source: "blast-infra", network: "mainnet", deployment: "test", checkpoint: 7,
    timestampMs: FIXTURE_NOW, observedAt: FIXTURE_NOW, lagMs: 0,
  } },
});

test("the first ten mix all stages and make room for the leading curve and latest backed sale", () => {
  const prototype = homeCoinRows[0]!;
  const legacy = BLAST_V1_COINS.map(coin => ({ ...prototype, coin_type: coin.coinType, symbol: coin.symbol, name: coin.name }));
  const market = [...homeCoinRows, ...legacy, { ...prototype, coin_type: "0xa::coin::EXTRA", symbol: "EXTRA" }].map((coin, i) => ({
    ...coin, price_usd: "0.25", mobile_market: { market_cap_usd: null, change_1h_bps: i === 0 ? 250 : -50 },
    activity: { ...coin.activity, window: "1h" as const, buyers: 1, participants: 1, latest_ms: FIXTURE_NOW - minute },
  }));
  const closest = curve("CLOSE", 8_500, 10 * day);
  const old = curve("OLD", 1_500, 8 * day);
  const rising = curve("RISING", 2_600, 20 * minute);
  const low = curve("LOW", 2_200, 10 * minute);
  const alreadyTrading = { ...curve("DUPLICATE", 10_000, day), coinType: legacy[0]!.coin_type };
  const live = happeningPresale({ end_ms: FIXTURE_NOW + 30_000 });
  const earlier = happeningPresale({ presale_id: "0x2", symbol: "EARLY", end_ms: FIXTURE_NOW + day });
  const scheduled = happeningPresale({ presale_id: "0x3", symbol: "SOON", lifecycle: "pending", start_ms: FIXTURE_NOW + day, end_ms: FIXTURE_NOW + 2 * day });
  const ended = happeningPresale({ presale_id: "0x4", symbol: "ENDED", end_ms: FIXTURE_NOW });
  const rows = mixedDiscoveryEntries({
    market,
    closest: catalog([alreadyTrading, closest, old, low, rising]),
    fresh: catalog([low, rising, old]),
    happening: happeningRead({
      fastest: [ended, live], opening_soon: [scheduled],
      recent_presales: [
        { presale: scheduled.presale, last_commit_ms: FIXTURE_NOW - 5_000 },
        { presale: ended.presale, last_commit_ms: FIXTURE_NOW - 10_000 },
        { presale: live.presale, last_commit_ms: FIXTURE_NOW - 30_000 },
        { presale: earlier.presale, last_commit_ms: FIXTURE_NOW - 10 * minute, backers_1h: 8, committed_1h: earlier.presale.raise_target },
      ],
    }),
    now: FIXTURE_NOW,
  });
  const rowFor = (symbol: string) => rows.find(row => row.symbol === symbol);
  assert.equal(rows.length, 10);
  assert.equal(rowFor("CLOSE")?.figure, "85%");
  assert.equal(rowFor("CLOSE")?.detail, "Closest to graduation");
  assert.equal(rowFor("MRDN")?.detail, "Just backed");
  assert.deepEqual(rows.filter(row => row.stage === "Presale").map(row => row.symbol), ["MRDN", "EARLY"]);
  assert.equal(rowFor("MANIFEST")?.legacy, true);
  assert.ok(rows.every(({ symbol }) => !["DUPLICATE", "SOON", "ENDED", "OLD"].includes(symbol)));

  const onlyMarket = mixedDiscoveryEntries({ market, happening: null, now: FIXTURE_NOW });
  assert.deepEqual(new Set(onlyMarket.map(({ symbol }) => symbol)), new Set(market.map(({ symbol }) => symbol)));
  assert.deepEqual(onlyMarket.find(row => row.symbol === "KSTL")?.change, { text: "+2.5%", tone: "up" });
  assert.deepEqual(onlyMarket.find(row => row.symbol === "LUMN")?.change, { text: "−0.5%", tone: "down" });

  const stale = mixedDiscoveryEntries({
    market,
    happening: happeningRead({
      fastest: [live], opening_soon: [scheduled],
      recent_presales: [{ presale: earlier.presale, last_commit_ms: FIXTURE_NOW - 61 * 60_000 }],
    }),
    now: FIXTURE_NOW,
  });
  assert.deepEqual(stale, onlyMarket);
});

test("Discover uses measured trade volume and leaves out quiet markets and untouched curves", () => {
  const prototype = homeCoinRows[0]!;
  const quiet = {
    ...prototype,
    activity: { ...prototype.activity, window: "1h" as const, bought: [], sold: [], committed: [] },
    mobile_market: { market_cap_usd: null, change_1h_bps: 0 },
  };
  const venue = { usd: "10", usd_complete: true };
  const trading = {
    ...quiet, symbol: "ACTIVE", coin_type: "0xa::coin::ACTIVE",
    dex_volume: { ...venue, venues: { cetus: venue, bluefin: { ...venue, usd: "0" } } },
  };
  const zeroDex = { ...trading, symbol: "ZERO", coin_type: "0xa::coin::ZERO", dex_volume: { ...trading.dex_volume, usd: "0" } };
  const traded = {
    ...quiet, symbol: "TRACKED", coin_type: "0xa::coin::TRACKED",
    activity: {
      ...quiet.activity,
      bought: [{ quote_type: "0x2::sui::SUI", quote_symbol: "SUI", quote_decimals: 9, atoms: "100", usd: "5", usd_complete: false }],
      committed: [{ quote_type: "0x2::sui::SUI", quote_symbol: "SUI", quote_decimals: 9, atoms: "200", usd: "1000", usd_complete: true }],
    },
  };
  const old = curve("OLD", 5_999, day);
  const superseded = { ...curve("SUPERSEDED", 9_990, day), coinType: quiet.coin_type };
  const untouched = curve("UNTOUCHED", 0, minute);
  const ready = { ...curve("READY", 10_000, day), lifecycle: "migration_ready" as const };
  const rows = mixedDiscoveryEntries({
    market: [quiet, zeroDex, trading, traded], closest: catalog([ready, superseded, old]), fresh: catalog([untouched, old, ready]),
    happening: null, now: FIXTURE_NOW,
  });
  assert.deepEqual(Object.fromEntries(rows.map(({ stage, symbol, figure }) => [symbol, [stage, figure]])), {
    ACTIVE: ["Trading", "$10"], READY: ["Graduating", "100%"], TRACKED: ["Trading", "$5+"],
  });
});

test("broad recent activity outranks a large trade, including on an older curve outside both catalogs", () => {
  const market = (symbol: string, participants: number, usd: string, age: number, bps: number) => {
    const prototype = homeCoinRows[0]!;
    const volume = { usd, usd_complete: true };
    return {
      ...prototype, symbol, coin_type: `0xa::coin::${symbol}`, price_usd: "0.25",
      activity: { ...prototype.activity, window: "1h" as const, participants, buyers: participants, latest_ms: FIXTURE_NOW - age },
      dex_volume: { ...volume, venues: { cetus: volume, bluefin: { ...volume, usd: "0" } } },
      mobile_market: { market_cap_usd: null, change_1h_bps: bps },
    };
  };
  const rows = mixedDiscoveryEntries({
    market: [market("WHALE", 1, "100000", minute, 8_000), market("BROAD", 8, "200", 2 * minute, 100), market("STALE", 2, "500", 59 * minute, 0)],
    closest: catalog([curve("LEAD", 4_500, day)]),
    fresh: catalog([curve("NEW", 0, minute)]),
    happening: happeningRead({ active_curves: [{
      coin_type: "0xbb::coin::ACTIVE_CURVE", symbol: "ACTIVE_CURVE", name: "Active Curve", icon_url: null, verified_team: false,
      created_ms: FIXTURE_NOW - 8 * day, participants: 8, last_action_ms: FIXTURE_NOW - minute, volume_usd: "150.00",
    }] }),
    now: FIXTURE_NOW,
  });
  assert.deepEqual(rows.map(({ symbol }) => symbol), ["BROAD", "ACTIVE_CURVE", "WHALE", "STALE", "LEAD"]);
  assert.equal(rows[1]?.detail, "8 wallets in 1h");
});

test("a one-hour quote change only qualifies with confirmed trade activity", () => {
  const prototype = homeCoinRows[0]!;
  const zeroVolume = { usd: "0", usd_complete: true };
  const quoteOnly = {
    ...prototype, symbol: "QUOTE", coin_type: "0xa::coin::QUOTE", price_usd: "0.25",
    activity: { ...prototype.activity, window: "1h" as const },
    dex_volume: { ...zeroVolume, venues: { cetus: zeroVolume, bluefin: zeroVolume } },
    mobile_market: { market_cap_usd: null, change_1h_bps: 45 },
  };
  const sold = {
    ...quoteOnly, symbol: "SOLD", coin_type: "0xa::coin::SOLD",
    activity: { ...quoteOnly.activity, sellers: 1 },
  };
  const yesterday = {
    ...sold, symbol: "YESTERDAY", coin_type: "0xa::coin::YESTERDAY",
    activity: { ...sold.activity, window: "24h" as const },
  };
  const rows = mixedDiscoveryEntries({ market: [quoteOnly, sold, yesterday], happening: null, now: FIXTURE_NOW });
  assert.deepEqual(rows.map(({ symbol, figure, detail, change }) => [symbol, figure, detail, change?.text]), [
    ["SOLD", null, "1 trader in 1h", "+0.45%"],
  ]);
});

test("the leading funded curve earns a place even below 60 percent", () => {
  const leader = curve("LEAD", 2_954, day);
  const runnerUp = curve("NEXT", 2_340, day);
  const untouched = curve("UNTOUCHED", 0, minute);
  const rows = mixedDiscoveryEntries({
    market: [], closest: catalog([leader, runnerUp, untouched]), fresh: catalog([untouched]),
    happening: null, now: FIXTURE_NOW,
  });
  assert.deepEqual(rows.map(({ stage, symbol, figure, detail }) => [stage, symbol, figure, detail]), [
    ["Bonding", "LEAD", "29.54% of target", "Leading curve"],
  ]);
  assert.deepEqual(mixedDiscoveryEntries({
    market: [], closest: catalog([untouched]), fresh: catalog([untouched]), happening: null, now: FIXTURE_NOW,
  }), []);
});
