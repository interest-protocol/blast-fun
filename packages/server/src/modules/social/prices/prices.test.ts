import assert from "node:assert/strict";
import test from "node:test";

import { assertChainReadThroughViews } from "@blast/core/modules/database/modules.ts";
import { SocialRouteError } from "@blast/core/modules/social/route-kit/errors.ts";
import {
  PRICE_DEFAULT_POINTS,
  PRICE_MAX_POINTS,
  priceStepFor,
  priceTierFor,
  socialPricesPath,
  PRICE_WINDOWS,
  PRICE_WINDOW_MS,
} from "@blast/core/modules/social/contracts/prices.ts";
import { bpsToPct, changeBps } from "@blast/core/modules/social/prices/change.ts";
import { dayOpenAt, PRICE_FIGURES_SQL, PRICE_PRESALES_SQL, PRICE_SERIES_SQL, windowPlan } from "@blast/server/modules/social/prices/history.ts";
import { parsePricesQuery } from "@blast/server/modules/social/prices/route.ts";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const ID = `0x${"ab".repeat(32)}`;
const SUI = `0x${"0".repeat(63)}2::sui::SUI`;

test("R3-20 change: exact basis points from decimal strings, half away from zero", () => {
  // 3.5 → 3.43627 is −1.8208…% → −182 bps; the card reads −1.82%.
  assert.equal(changeBps("3.43627", "3.5"), -182);
  assert.equal(bpsToPct(changeBps("3.43627", "3.5")), -1.82);
  assert.equal(changeBps("0.0021", "0.0020"), 500);
  assert.equal(changeBps("3.5", "3.5"), 0);
  // Exactly half a basis point rounds away from zero, both ways (floats would not: 1.00005 / 1 − 1 is 0.0000499999…).
  assert.equal(changeBps("1.00005", "1"), 1);
  assert.equal(changeBps("0.99995", "1"), -1);
  assert.equal(changeBps("1.000049999999999999", "1"), 0);
  // Different scales, tiny sale-coin prices and a big move.
  assert.equal(changeBps("0.000002096", "0.000002"), 480);
  assert.equal(changeBps("12", "0.000001"), 119_999_990_000);
  assert.equal(changeBps("0", "2"), -10_000);
  // No figure rather than a made-up 0.
  assert.equal(changeBps(null, "1"), null);
  assert.equal(changeBps("1", null), null);
  assert.equal(changeBps("1", "0"), null);
  assert.equal(changeBps("1", "0.000"), null);
  assert.equal(changeBps("-1", "1"), null);
  assert.equal(changeBps("1e3", "1"), null);
  assert.equal(bpsToPct(null), null);
});

test("R3-20 tiers: the finest that covers a window in at most 288 buckets; thinned to the points a chart draws", () => {
  assert.equal(priceTierFor(DAY), "5m");
  assert.equal(priceTierFor(DAY + 1), "1h");
  assert.equal(priceTierFor(12 * DAY), "1h");
  assert.equal(priceTierFor(12 * DAY + 1), "1d");
  // 24 h of 5m buckets drawn in 60 points: every fifth bucket (25 minutes), 58 of them.
  assert.equal(priceStepFor(DAY, "5m", 60), 25 * 60_000);
  assert.equal(priceStepFor(DAY, "5m", 288), 300_000);
  assert.equal(priceStepFor(DAY, "5m", 1_000), 300_000);
  // A two-year-old coin still draws at most 60 points: 13 days apart.
  assert.equal(priceStepFor(730 * DAY, "1d", 60), 13 * DAY);
});

test("R3-20 windows: the last 24 h on 5m buckets, or since launch on the tier its age needs", () => {
  const clock = 1_791_000_000_000;
  const coin = { presaleId: null, coinType: SUI, launchedMs: null };
  assert.deepEqual(windowPlan("24h", coin, clock, 60), {
    tier: "5m", from: clock - DAY, lo: clock - DAY - 300_000, hi: clock, step: 25 * 60_000, head: clock - DAY, after: clock - DAY,
  });
  assert.equal(windowPlan("launch", coin, clock, 60), null, "a coin has no launch");
  const sale = (age: number) => ({ presaleId: ID, coinType: `${ID}::coin::X`, launchedMs: clock - age });
  // Six hours old: 5m buckets, from the one holding the launch.
  assert.deepEqual(windowPlan("launch", sale(6 * HOUR), clock, 60), {
    tier: "5m", from: clock - 6 * HOUR, lo: clock - 6 * HOUR - 300_000, hi: clock, step: 600_000, head: clock - 6 * HOUR, after: clock - 6 * HOUR - 1,
  });
  assert.equal(windowPlan("launch", sale(3 * DAY), clock, 60)!.tier, "1h");
  assert.equal(windowPlan("launch", sale(40 * DAY), clock, 60)!.tier, "1d");
  assert.equal(windowPlan("launch", { ...sale(0), launchedMs: clock + 1 }, clock, 60), null, "not launched by the clock");
});

test("R3-20 day open is the most recent 00:00 UTC", () => {
  assert.equal(dayOpenAt(Date.UTC(2026, 9, 6, 13, 5)), Date.UTC(2026, 9, 6));
  assert.equal(dayOpenAt(Date.UTC(2026, 9, 6)), Date.UTC(2026, 9, 6));
  assert.equal(dayOpenAt(Date.UTC(2026, 9, 6) - 1), Date.UTC(2026, 9, 5));
});

test("R3-20 statements read chain data only through chain_read_v1 views, with both sides of every range bound", () => {
  for (const text of [PRICE_FIGURES_SQL, PRICE_SERIES_SQL, PRICE_PRESALES_SQL]) assert.doesNotThrow(() => assertChainReadThroughViews(text));
  // Each price-at lookup (24 h ago, the day open) is one 5m range bounded below and above, and the series by `lo` and `hi`.
  assert.equal((PRICE_FIGURES_SQL.match(/ph\.resolution = '5m'\s+AND ph\.bucket_ms > \$\d::bigint - 3600000 AND ph\.bucket_ms <= \$\d::bigint/g) ?? []).length, 2);
  assert.doesNotMatch(PRICE_FIGURES_SQL, /'1h'|'1d'|COALESCE/, "no coarse fallback: its estimate turned JIT on at launch scale");
  // The read is the same for every source (blast-infra's `pyth` and `pool` rows).
  assert.doesNotMatch(`${PRICE_FIGURES_SQL}${PRICE_SERIES_SQL}`, /source/);
  assert.match(PRICE_SERIES_SQL, /ph\.bucket_ms > k\.lo AND ph\.bucket_ms <= k\.hi AND ph\.as_of_ms > k\.after AND ph\.as_of_ms <= k\.hi/);
  assert.match(PRICE_SERIES_SQL, /LIMIT 290/);
  assert.doesNotMatch(`${PRICE_FIGURES_SQL}${PRICE_SERIES_SQL}`, /OFFSET/i);
});

const url = (query: string) => new URL(`https://blast.fun/api/social/prices?${query}`);
const refused = (query: string, parameter: string) =>
  assert.throws(
    () => parsePricesQuery(url(query)),
    (error: unknown) => error instanceof SocialRouteError && error.code === "invalid_parameter" && error.extra.parameter === parameter,
    query,
  );

test("R3-20 route query: presales and coins (deduplicated), a window and the points a chart draws", () => {
  assert.deepEqual(parsePricesQuery(url(`presale=${ID}&presale=${ID}&coin=${SUI}`)), {
    presales: [ID], coins: [SUI], window: "24h", points: PRICE_DEFAULT_POINTS,
  });
  assert.deepEqual(parsePricesQuery(url(`presale=${ID}&window=launch&points=288`)), { presales: [ID], coins: [], window: "launch", points: 288 });
  assert.equal(parsePricesQuery(url(socialPricesPath({ presales: [ID], window: "launch", points: 45 }).split("?")[1]!)).points, 45);
  refused("", "presale");
  refused("presale=0x12", "presale");
  refused(Array.from({ length: 51 }, (_, n) => `presale=0x${n.toString(16).padStart(64, "0")}`).join("&"), "presale");
  refused("coin=SUI", "coin");
  refused(`coin=${SUI}&window=launch`, "window");
  refused(`presale=${ID}&window=2d`, "window");
  refused(`presale=${ID}&window=24h&window=launch`, "window");
  refused(`presale=${ID}&points=1`, "points");
  refused(`presale=${ID}&points=${PRICE_MAX_POINTS + 1}`, "points");
  refused(`presale=${ID}&points=1.5`, "points");
});

test("chart ranges and requested source tiers keep every history read bounded", () => {
  const clock = Date.UTC(2026, 9, 26, 12);
  const key = { presaleId: ID, coinType: SUI, launchedMs: clock - 90 * DAY };
  for (const window of PRICE_WINDOWS) {
    const request = parsePricesQuery(url(`presale=${ID}&window=${window}&interval=1d&points=288`));
    assert.equal(request.window, window);
    assert.equal(request.interval, "1d");
    const plan = windowPlan(window, key, clock, 288, "1d")!;
    assert.equal(plan.from, window === "launch" ? key.launchedMs : clock - PRICE_WINDOW_MS[window]);
    assert.equal(plan.tier, "1d");
    assert.equal(plan.hi, clock);
    assert.ok(plan.lo < plan.hi);
  }
  assert.equal(windowPlan("7d", key, clock, 288, "5m")!.tier, "1h", "a fine requested interval cannot truncate a longer range");
  assert.equal(windowPlan("30d", key, clock, 288, "5m")!.tier, "1d");
  refused(`presale=${ID}&interval=1s`, "interval");
  refused(`presale=${ID}&interval=5m&interval=1h`, "interval");
});

test("R3-20 client path: defaults stay out of the URL, so equal asks share one cached answer", () => {
  assert.equal(socialPricesPath({ presales: [ID] }), `/api/social/prices?presale=${ID}`);
  assert.equal(socialPricesPath({ coins: [SUI], window: "24h", points: 60 }), `/api/social/prices?coin=${encodeURIComponent(SUI)}`);
  assert.equal(socialPricesPath({ presales: [ID], window: "launch", points: 45 }), `/api/social/prices?presale=${ID}&window=launch&points=45`);
});
