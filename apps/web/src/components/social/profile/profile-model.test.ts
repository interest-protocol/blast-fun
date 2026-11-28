import assert from "node:assert/strict";
import test from "node:test";

import { multiple, px, signedUsd0, timeLeft } from "@blast/core/lib/format.ts";
import type { MePresalePosition, ProfileCall, ProfilePresale } from "@blast/core/modules/social/contracts/profile-page.ts";
import { NO_COST_BASIS, NO_PORTFOLIO_TREND, type SocialPortfolio } from "@blast/core/modules/social/contracts/portfolio.ts";

import { editRefusalMessage, nameCheck } from "./edit-profile";
import { portfolioTrend, trendCaption, trendData, trendDomain, trendFrom, trendPath } from "./portfolio-trend";
import {
  backedTogether,
  balanceCoins,
  callRow,
  goldFigures,
  inRightNowOf,
  moneyParts,
  mutualsLine,
  ownInRightNow,
  positionView,
  vestingView,
  trackTiles,
} from "./profile-model";

const NOW = Date.UTC(2026, 9, 3, 12);
const HOUR = 3_600_000;

function presale(id: string, status: ProfilePresale["status"], over: Partial<ProfilePresale> = {}): ProfilePresale {
  return { presale_id: `0x${id.padStart(64, "0")}`, symbol: id.toUpperCase(), name: id, icon_url: "", status, venue: "cetus", start_ms: Date.UTC(2026, 9, 14, 18), end_ms: NOW + 6 * HOUR + 12 * 60_000 + 41_000, fill_pct: 73, quote_symbol: "USDC", quote_decimals: 6, launched_ms: null, first_unlock_ms: null, ...over };
}

function call(p: ProfilePresale, over: Partial<ProfileCall> = {}): ProfileCall {
  return {
    presale: p, committed_usd: "300.00", committed_atoms: "300000000", entry_price_usd: null, price_usd: null, multiple: null,
    value_usd: null, pnl_usd: null, last_commit_ms: NOW, series: null, ...over,
  };
}

test("UI-06: shared formats build the prototype's strings (px, multiple, timeLeft) and a signed PnL", () => {
  assert.equal(px(3.42), "$3.42");
  assert.equal(px(0.2109), "$0.2109");
  assert.equal(px(0.0005), "$0.0005");
  assert.equal(px(0.000556), "$0.000556");
  assert.equal(multiple(4.2), "4.2×");
  assert.equal(timeLeft(11 * 24 * HOUR), "11d 0h");
  assert.equal(timeLeft(6 * HOUR + 12 * 60_000 + 41_000), "6h 12m");
  assert.equal(timeLeft(76_000), "1m 16s");
  assert.equal(timeLeft(-5), "0m 0s");
  assert.equal(signedUsd0(3240.4), "+$3,240");
  assert.equal(signedUsd0(-120), "−$120");
  assert.equal(signedUsd0(0.3), "$0");
});

test("profile counts do not reuse hypothetical call performance as account PnL", () => {
  const tiles = trackTiles({ presales_backed: 6, launched: 2, pnl_usd: "880.00" });
  assert.deepEqual(tiles.map((tile) => tile.label), ["Presales backed", "Backed, now trading"]);
  assert.deepEqual(tiles.map((tile) => tile.value), ["6", "2"]);
  assert.deepEqual(trackTiles(null).map((tile) => tile.value), ["–", "–"]);
  assert.ok(!trackTiles(null).some((tile) => /Best call|Hit rate/.test(tile.label)));
});

test("UI-06: the mutuals line names first names and adds 'and others you follow' only when there are more", () => {
  const people = [{ callsign: "mirachen", display_name: "Mira Chen", avatar_url: null }, { callsign: "theopark", display_name: "Theo Park", avatar_url: null }, { callsign: "ana", display_name: null, avatar_url: null }];
  assert.equal(mutualsLine({ accounts: people, total: 9 }), "Followed by Mira, Theo, ana and others you follow");
  assert.equal(mutualsLine({ accounts: people, total: 3 }), "Followed by Mira, Theo and ana");
  assert.equal(mutualsLine({ accounts: people.slice(0, 1), total: 1 }), "Followed by Mira");
  assert.equal(mutualsLine({ accounts: [], total: 0 }), null);
});

test("UI-06: a call row: entry, now and the multiple once trading; the status chip otherwise; no series yet", () => {
  const trading = callRow(call(presale("kstl", "trading"), { entry_price_usd: "0.0005", price_usd: "0.0021", multiple: "4.2000" }));
  assert.equal(trading.sub, "$300 at $0.0005 · now $0.0021");
  assert.deepEqual(trading.result, { text: "4.2×", tone: "up" });
  assert.equal(trading.hasSeries, false);
  assert.deepEqual(callRow(call(presale("lumn", "trading"), { entry_price_usd: "0.002", price_usd: "0.0013", multiple: "0.6500" })).result, { text: "0.7×", tone: "down" });
  const open = callRow(call(presale("mrdn", "open"), { committed_usd: "2000.00" }));
  assert.equal(open.sub, "$2,000 committed");
  assert.equal(open.result, null);
  assert.deepEqual(open.status, { label: "Open", tone: "open" });
  assert.equal(callRow(call(presale("cblt", "funded"), { entry_price_usd: "0.001" })).sub, "$300 at $0.001");
  assert.equal(callRow(call(presale("hlcn", "cancelled"))).status.label, "Cancelled");
});

test("UI-06 (§5.5): In right now, Backed together and the watchlist lines", () => {
  const mrdn = presale("mrdn", "open");
  const kstl = presale("kstl", "trading");
  const calls = [call(mrdn, { committed_usd: "15000.00" }), call(kstl, { committed_usd: "25000.00", multiple: "4.2000", entry_price_usd: "0.0005", price_usd: "0.0021" })];
  // The boards' row: the fill and time left under the name, what was put in on the right.
  assert.deepEqual(inRightNowOf(calls, NOW).map((row) => [row.sub, row.right?.top, row.right?.bottom]), [["73% filled · 6h 12m left", "$15,000", undefined]]);
  const extra = { committed_atoms: "0", claimed_tokens: null, refunded_usd: null, refunded_atoms: null, value_usd: null, multiple: null, ...NO_COST_BASIS };
  const mine: MePresalePosition[] = [
    { presale: mrdn, committed_usd: "100.00", status: "open", ...extra },
    { presale: kstl, committed_usd: "300.00", status: "delivered", ...extra },
    { presale: presale("tide", "open"), committed_usd: "250.00", status: "open", ...extra },
  ];
  assert.deepEqual(ownInRightNow(mine, NOW, false).map((row) => [row.sub, row.right?.top]), [["73% filled · 6h 12m left", "$100"], ["73% filled · 6h 12m left", "$250"]]);
  assert.equal(ownInRightNow(mine, NOW, true)[0]!.right?.top, "••••");
  const together = backedTogether("Luca", mine, calls, false);
  assert.deepEqual(together.map((row) => [row.sub, row.status, row.right?.top]), [["You $100 · Luca $15,000", "open", undefined], ["You $300 · Luca $25,000", null, "4.2×"]]);
});

test("UI-06 (§6.3): the gold card sums the known parts; an unavailable part makes the total unknown, never smaller", () => {
  const portfolio: SocialPortfolio = {
    balances: { sui: { atoms: "412380000000", usd: "1410.34" }, usdc: { atoms: "860000000", usd: "860.00" } },
    positions: [
      { presale_id: "0x1", symbol: "A", commitment: "100000000", status: "open", claimed_tokens: null, claimed_quote_refund: null, quote_symbol: "USDC", quote_decimals: 6, sale_decimals: 9, ...NO_COST_BASIS },
      { presale_id: "0x2", symbol: "B", commitment: "750000000", status: "closed", claimed_tokens: null, claimed_quote_refund: null, quote_symbol: "USDC", quote_decimals: 6, sale_decimals: 9, ...NO_COST_BASIS },
      { presale_id: "0x3", symbol: "C", commitment: "250000000", status: "claimable", claimed_tokens: null, claimed_quote_refund: null, quote_symbol: "USDC", quote_decimals: 6, sale_decimals: 9, ...NO_COST_BASIS },
    ],
    coins: null,
    vesting: null,
    totals: null,
    trend: NO_PORTFOLIO_TREND,
    // R3-40: the server's dollars over every quote (`position-value.ts`); the card reads them.
    commitments: { committed_usd: "850.00", claimable_usd: "250.00" },
    prices_as_of_ms: NOW,
    unavailable: ["coins", "vesting", "totals"],
  };
  const figures = goldFigures(portfolio);
  assert.deepEqual(figures, { total: null, committed: 850, claimable: 250, tokens: null, usdc: 860, sui: 1410.34, suiQty: 412.38, usdcQty: 860 });
  assert.deepEqual(moneyParts(4760.34), { whole: "$4,760", cents: ".34" });
  assert.equal(goldFigures({ ...portfolio, balances: null }).total, null);
  const coins = balanceCoins(figures);
  assert.deepEqual(coins.map((coin) => coin.name), ["SUI", "USDC"]);
});

test("R3-08, OA-25 Q16: the 30-day line is the read's daily snapshots; without a month of them the slot is empty", () => {
  // No portfolio, or a read whose trend has no points (less than a month of snapshots), or that could not be read: no line.
  assert.equal(portfolioTrend(null), null);
  const base = { balances: null, positions: null, commitments: null, coins: null, vesting: null, totals: null, prices_as_of_ms: null, unavailable: [] } as const;
  assert.equal(portfolioTrend({ ...base, trend: { days: 30, points: [], change_bps: null } }), null);
  assert.equal(portfolioTrend({ ...base, trend: null, unavailable: ["trend"] }), null);
  assert.equal(trendFrom({ days: 30, points: [{ day: "2026-10-05", value_usd: "100.00" }], change_bps: null }), null);
  // A month of snapshots: the points are the read's, placed by day; the caption is the read's exact basis points.
  const body = {
    days: 30 as const,
    points: [["2026-09-05", "100.00"], ["2026-09-06", "90.00"], ["2026-09-07", "130.00"], ["2026-10-05", "118.00"]].map(([day, value_usd]) => ({ day: day!, value_usd: value_usd! })),
    change_bps: "1800",
  };
  const trend = portfolioTrend({ ...base, trend: body })!;
  assert.deepEqual(trend.points.map((point) => [point.at_ms, point.usd]), [[Date.UTC(2026, 8, 5), 100], [Date.UTC(2026, 8, 6), 90], [Date.UTC(2026, 8, 7), 130], [Date.UTC(2026, 9, 5), 118]]);
  assert.deepEqual(trendCaption(trend), { label: "30 days", value: "+18%", description: "30-day trend: up 18%" });
  // Whole percent, half up, sign from the exact change (the reference's `d30 >= 0`): −0.4% reads −0%, 0 reads +0%.
  const caption = (changeBps: string | null) => trendCaption({ points: trend.points, changeBps }).value;
  assert.deepEqual(["-1800", "1850", "1849", "-40", "0", "-1", "123456789012345678901234"].map(caption), ["\u221218%", "+19%", "+18%", "\u22120%", "+0%", "\u22120%", "+1234567890123456789012%"]);
  // An undefined change (the value 30 days before was zero): the line, and no figure.
  assert.deepEqual(trendCaption({ points: trend.points, changeBps: null }), { label: "30 days", value: null, description: "30-day trend" });
  // The reference's geometry, each point at its day: a skipped day stays a gap between two real values.
  const path = trendPath(trend.points);
  assert.equal(path.line, "M0.0 75.0 L13.3 100.0 L26.7 0.0 L400.0 30.0");
  assert.equal(path.area, `${path.line} L400 140 L0 140Z`);
  // A flat series sits on the middle line rather than dividing by zero.
  assert.equal(trendPath([{ at_ms: 0, usd: 5 }, { at_ms: 1, usd: 5 }]).line, "M0.0 50.0 L400.0 50.0");
  // OA-28 M4: the recharts plot is given the same geometry — 90 at the floor, 130 at the top, the area closed 40%
  // of the box below (90 − 0.4 × 40 = 74 → y 140), a flat 5 on the middle line — and each point where trendPath
  // writes it: x by its day across the box, both coordinates to one decimal of the 400×100 box.
  assert.deepEqual(trendDomain(trend.points), { min: 90, max: 130, base: 74 });
  assert.deepEqual(trendDomain([{ at_ms: 0, usd: 5 }, { at_ms: 1, usd: 5 }]), { min: 4, max: 6, base: 3.2 });
  const drawn = trendData(trend.points).map((point) => `${(point.x * 400).toFixed(1)} ${(100 - ((point.v - 90) / 40) * 100).toFixed(1)}`);
  assert.equal(`M${drawn.join(" L")}`, path.line);
});

test("UI-06 (OA-14, OA-44): the edit sheet's name rule and its copy, the gate's hint and empty line, and the refusals", () => {
  assert.deepEqual(nameCheck("  Kai   Moreno ", "kaimoreno"), { state: "ok", length: 10, message: "Your handle stays @kaimoreno." });
  assert.deepEqual(nameCheck("   ", "kaimoreno"), { state: "bad", length: 0, message: "Your name can’t be empty." });
  assert.equal(nameCheck("x".repeat(33), "kaimoreno").state, "bad");
  assert.equal(nameCheck("Kai\u200bMoreno", "kaimoreno").state, "bad");
  assert.equal(nameCheck("🚀".repeat(32), "kaimoreno").state, "ok");
  assert.equal(editRefusalMessage({ status: "refused", code: "blocked_term", retryAfterSeconds: null }), "Your profile contains a word that is not allowed. Code: blocked_term.");
  assert.equal(editRefusalMessage({ status: "refused", code: "picture_upload_unavailable", retryAfterSeconds: 30 }), "Photo uploads are not available right now. Nothing was saved. Code: picture_upload_unavailable.");
  assert.equal(editRefusalMessage({ status: "error" }), "Nothing was saved. Check your connection and try again. Code: request_failed.");
});

test("UI-06 (live design: your holdings): positions, sale coins and vesting rows read as the design's", () => {
  const extra = { committed_atoms: "0", claimed_tokens: null, refunded_usd: null, refunded_atoms: null, value_usd: null, multiple: null, ...NO_COST_BASIS };
  const view = (p: MePresalePosition) => { const v = positionView(p, false, NOW); return [v.sub, v.right.kind === "claim" ? v.right.label : `${v.right.top}/${v.right.bottom}`]; };
  assert.deepEqual(view({ presale: presale("mrdn", "open"), committed_usd: "100.00", status: "open", ...extra }), ["$100 committed", "Open/6h 12m left"]);
  assert.deepEqual(view({ presale: presale("cblt", "funded"), committed_usd: "500.00", status: "closed", ...extra }), ["$500 committed", "Funded/claims at launch"]);
  assert.deepEqual(view({ presale: presale("hlcn", "cancelled"), committed_usd: "250.00", status: "claimable", ...extra }), ["$250 refund ready", "Claim refund"]);
  assert.deepEqual(view({ presale: presale("hlcn", "cancelled"), committed_usd: "250.00", status: "delivered", ...extra, refunded_usd: "250.00" }), ["$250 refunded to USDC", "Refunded/to USDC"]);
  assert.deepEqual(view({ presale: presale("kstl", "trading"), committed_usd: "300.00", status: "delivered", committed_atoms: "300000000", claimed_tokens: "600000", refunded_usd: null, refunded_atoms: null, value_usd: "1260.00", multiple: "4.2000", ...NO_COST_BASIS }), ["600,000 KSTL claimed", "$1,260/4.2×"]);
  assert.equal(positionView({ presale: presale("mrdn", "open"), committed_usd: "100.00", status: "open", ...extra }, true, NOW).sub, "•••• committed");

  // T-020: the gold card's Tokens are the portfolio's sale coins.
  const base: SocialPortfolio = {
    balances: { usdc: { atoms: "100000000", usd: null }, sui: { atoms: "0", usd: "0.00" } }, positions: [],
    commitments: { committed_usd: "0.00", claimable_usd: "0.00" },
    coins: [], vesting: { has_schedule: false, href: null }, totals: null, trend: NO_PORTFOLIO_TREND, prices_as_of_ms: null, unavailable: ["totals"],
  };
  const held = (value_usd: string | null) => [{ coin_type: "0xk::kstl::KSTL", symbol: "KSTL", balance: "1", value_usd, ...NO_COST_BASIS }];
  assert.deepEqual([goldFigures({ ...base, coins: held("20.00") }).tokens, goldFigures({ ...base, coins: held("20.00") }).total], [20, 120]);
  assert.deepEqual([goldFigures({ ...base, coins: held(null) }).tokens, goldFigures({ ...base, coins: held(null) }).total], [null, null]);
  assert.deepEqual([goldFigures(base).tokens, goldFigures(base).total], [0, 100]);
  // An unread holding is unknown; an empty list above is a confirmed zero.
  assert.deepEqual([goldFigures({ ...base, coins: null }).tokens, goldFigures({ ...base, coins: null }).total], [null, null]);

  const DAY = 86_400_000;
  const vesting = { schedule_id: "v", presale: presale("lumn", "trading"), symbol: "LUMN", total: "400000", claimed: "10000", claimable: "21111", claimable_usd: null, start_ms: NOW - 14 * 24 * HOUR, cliff_end_ms: NOW - 14 * 24 * HOUR, end_ms: NOW + 166 * 24 * HOUR, vested_pct: 7 };
  const v = vestingView(vesting, false, NOW);
  assert.deepEqual([v.title, v.sub, v.progress, v.right.kind === "claim" ? v.right.label : ""], ["lumn · Vesting", "400,000 LUMN · linear over 6 mo", "7% unlocked · fully vested", "Claim 21,111 LUMN"]);
  assert.equal(v.fullyVestAtMs, vesting.end_ms);
  // #173: a creator's raise vests in the quote coin and says so.
  const raise = vestingView({ ...vesting, symbol: "TSUI", total: "690", claimable: "69" }, false, NOW);
  assert.deepEqual([raise.sub, raise.right.kind === "claim" ? raise.right.label : ""], ["690 TSUI · linear over 6 mo", "Claim 69 TSUI"]);
  // OA-18: a 3-month cliff from launch (the design's "linear over 12 mo, 3-mo cliff"): until it ends, "Cliff / ends <day>".
  const start = Date.UTC(2026, 9, 1);
  const cliff = vestingView({ ...vesting, start_ms: start, cliff_end_ms: start + 90 * DAY, end_ms: start + 360 * DAY, claimable: "0", claimed: "0", vested_pct: 0 }, false, start + 10 * DAY);
  assert.deepEqual(cliff.right, { kind: "figures", top: "Cliff", bottom: "ends", bottomAtMs: start + 90 * DAY, tone: null });
  assert.equal(cliff.sub, "400,000 LUMN · linear over 12 mo, 3-mo cliff");
  assert.deepEqual(cliff.balances, { claimed: "0", remaining: "400,000", available: "0" });
});

test("A-03, A-04, P-13: a holding's Claim carries what it claims in place, with the gate's toast; hidden amounts never reach the toast", () => {
  const extra = { committed_atoms: "250000000", claimed_tokens: null, refunded_usd: null, refunded_atoms: null, value_usd: null, multiple: null, ...NO_COST_BASIS };
  const target = (p: MePresalePosition) => { const right = positionView(p, true, NOW).right; return right.kind === "claim" ? right.target : null; };
  const hlcn = presale("hlcn", "cancelled");
  assert.deepEqual(target({ presale: hlcn, committed_usd: "250.00", status: "claimable", ...extra }), {
    key: `refund:${hlcn.presale_id}`, kind: "claim_refund", presaleId: hlcn.presale_id,
    done: { title: "250.00 USDC refund claimed", sub: "From hlcn, now in your USDC" },
  });
  const kstl = presale("kstl", "trading");
  assert.deepEqual(target({ presale: kstl, committed_usd: "300.00", status: "claimable", ...extra })?.key, `tokens:${kstl.presale_id}`);
  const vesting = { schedule_id: `0x${"70".repeat(32)}`, presale: presale("lumn", "trading"), symbol: "LUMN", total: "400000", claimed: "10000", claimable: "21111", claimable_usd: null, start_ms: NOW - 14 * 24 * HOUR, cliff_end_ms: NOW - 14 * 24 * HOUR, end_ms: NOW + 166 * 24 * HOUR, vested_pct: 7 };
  const right = vestingView(vesting, true, NOW).right;
  assert.deepEqual(right.kind === "claim" && [right.label, right.target], [
    "Claim •••• LUMN",
    { key: `vesting:${vesting.schedule_id}`, kind: "claim_vesting", presaleId: vesting.presale.presale_id, scheduleId: vesting.schedule_id, vesting: { claimed: vesting.claimed, claimable: vesting.claimable }, done: { title: "Claimed 21,111 LUMN", sub: "lumn · Vesting" } },
  ]);
});

test("R3-40-AC-1: a profile reads a SUI sale's calls and positions in dollars, as the gate's rows do; with no dollar figure, in SUI from the atoms; a refund names SUI", () => {
  const drift = presale("drft", "open", { quote_symbol: "SUI", quote_decimals: 9 });
  const luca = call(drift, { committed_usd: "13680.00", committed_atoms: "4000000000000" });
  assert.deepEqual(inRightNowOf([luca], NOW).map((row) => row.right?.top), ["$13,680"]);
  // The gate's call row: `usd(x.amt) at px(price) · now px(now)`.
  const trading = call(presale("drft", "trading", { quote_symbol: "SUI", quote_decimals: 9 }), {
    committed_usd: "13680.00", committed_atoms: "4000000000000", entry_price_usd: "0.00076", price_usd: "0.0021", multiple: "2.7600",
  });
  assert.equal(callRow(trading).sub, "$13,680 at $0.00076 · now $0.0021");
  const extra = { claimed_tokens: null, refunded_usd: null, refunded_atoms: null, value_usd: null, multiple: null, ...NO_COST_BASIS };
  const priced: MePresalePosition = { presale: drift, committed_usd: "427.50", committed_atoms: "125000000000", status: "open", ...extra };
  assert.deepEqual(ownInRightNow([priced], NOW, false).map((row) => row.right?.top), ["$428"]);
  assert.equal(positionView(priced, false, NOW).sub, "$428 committed");
  // `committed_usd` is null without a fresh SUI price (it used to carry SUI units as dollars): the row reads the atoms.
  const mine: MePresalePosition = { ...priced, committed_usd: null };
  assert.deepEqual(ownInRightNow([mine], NOW, false).map((row) => row.right?.top), ["125 SUI"]);
  assert.equal(positionView(mine, false, NOW).sub, "125 SUI committed");
  assert.equal(positionView(mine, true, NOW).sub, "•••• committed");
  const back = positionView({ ...mine, presale: { ...drift, status: "cancelled" }, status: "delivered", refunded_atoms: "125000000000" }, false, NOW);
  assert.deepEqual([back.sub, back.right], ["125 SUI refunded to SUI", { kind: "figures", top: "Refunded", bottom: "to SUI", tone: null }]);
  assert.deepEqual(backedTogether("Luca", [priced], [luca], false).map((row) => row.sub), ["You $428 · Luca $13,680"]);
});

test("vesting claims show the exact unlocked amount and explain what is still locked", () => {
  const vesting = { schedule_id: "v", presale: presale("lumn", "trading"), symbol: "LUMN", total: "440000000", claimed: "10000.000000001", claimable: "21111.123456789", claimable_usd: null, start_ms: NOW - 14 * 24 * HOUR, cliff_end_ms: NOW - 14 * 24 * HOUR, end_ms: NOW + 166 * 24 * HOUR, vested_pct: 7 };
  const view = vestingView(vesting, false, NOW);
  assert.equal(view.right.kind === "claim" ? view.right.label : "", "Claim 21,111.123456789 LUMN");
  assert.equal(view.balances.available, "21,111.123456789");
  assert.equal(view.balances.claimed, "10,000.000000001");
  assert.match(view.progress, /fully vested/);
  assert.equal(view.right.kind === "claim" ? view.right.target.done.title : "", "Claimed 21,111.123456789 LUMN");
});

test("vesting remaining balances preserve precision, include unlocked funds, and hide with other amounts", () => {
  const schedule = { schedule_id: "v", presale: presale("lumn", "trading"), symbol: "LUMN", total: "9007199254740993.000000009", claimed: "0.000000008", claimable: "1", claimable_usd: null, start_ms: NOW - HOUR, cliff_end_ms: NOW - HOUR, end_ms: NOW + HOUR, vested_pct: 50 };
  assert.equal(vestingView(schedule, false, NOW).balances.remaining, "9,007,199,254,740,993.000000001");
  assert.equal(vestingView({ ...schedule, claimed: schedule.total, claimable: "0" }, false, NOW).balances.remaining, "0");
  assert.equal(vestingView({ ...schedule, total: "1", claimed: "2" }, false, NOW).balances.remaining, "—");
  assert.deepEqual(vestingView(schedule, true, NOW).balances, { claimed: "••••", remaining: "••••", available: "••••" });
});
