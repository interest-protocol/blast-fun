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

test("the first ten mix all stages, include eligible V1 coins, and keep the strongest two curve signals", () => {
  const prototype = homeCoinRows[0]!;
  const legacy = BLAST_V1_COINS.map(coin => ({ ...prototype, coin_type: coin.coinType, symbol: coin.symbol, name: coin.name }));
  const market = [...homeCoinRows, ...legacy, { ...prototype, coin_type: "0xa::coin::EXTRA", symbol: "EXTRA" }].map((coin, i) => ({
    ...coin, price_usd: "0.25", mobile_market: { market_cap_usd: null, change_1h_bps: i === 0 ? 250 : -50 },
    activity: { ...coin.activity, window: "1h" as const },
  }));
  const closest = curve("CLOSE", 8_500, 10 * day);
  const old = curve("OLD", 7_500, 8 * day);
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
        { presale: earlier.presale, last_commit_ms: FIXTURE_NOW - 60 * 60_000 },
      ],
    }),
    now: FIXTURE_NOW,
  });
  assert.deepEqual(rows.map(({ stage, symbol }) => `${stage} ${symbol}`), [
    "Trading KSTL", "Bonding CLOSE", "Presale MRDN", "Trading LUMN", "Bonding RISING", "Presale EARLY",
    "Trading MANIFEST", "Trading Wheels", "Trading BLAST", "Trading HELMET",
  ]);
  assert.equal(rows[1]?.figure, "85%");
  assert.equal(rows[1]?.detail, "Closest to graduation");
  assert.deepEqual(rows[0]?.change, { text: "+2.5%", tone: "up" });
  assert.deepEqual(rows[3]?.change, { text: "−0.5%", tone: "down" });
  assert.equal(rows[2]?.detail, "Just backed");
  assert.equal(rows[4]?.detail, "Launched 20m ago");
  assert.equal(rows[5]?.detail, "Backed 1h ago");
  assert.equal(rows[6]?.legacy, true);

  const onlyMarket = mixedDiscoveryEntries({ market, happening: null, now: FIXTURE_NOW });
  assert.deepEqual(onlyMarket.map(({ symbol }) => symbol), market.map(({ symbol }) => symbol));

  const stale = mixedDiscoveryEntries({
    market,
    happening: happeningRead({
      fastest: [live], opening_soon: [scheduled],
      recent_presales: [{ presale: earlier.presale, last_commit_ms: FIXTURE_NOW - 61 * 60_000 }],
    }),
    now: FIXTURE_NOW,
  });
  assert.deepEqual(stale.map(({ symbol }) => symbol), market.map(({ symbol }) => symbol));
});

test("Discover leaves out quiet markets and untouched or older low-progress curves", () => {
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
  assert.deepEqual(rows.map(({ stage, symbol, figure }) => [stage, symbol, figure]), [
    ["Trading", "ACTIVE", "$10"], ["Graduating", "READY", "100%"], ["Trading", "TRACKED", "$5+"],
  ]);
});
