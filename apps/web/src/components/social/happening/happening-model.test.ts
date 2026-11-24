import assert from "node:assert/strict";
import test from "node:test";

import { FIXTURE_NOW } from "../../../../test/fixtures/social/feed-fixtures.ts";
import { CBLT, KSTL, MRDN, SABL, TIDE, happeningPresale, happeningRead, tapeEvent, THEO_EVENT } from "../../../../test/fixtures/social/happening/happening-fixtures.ts";
import {
  arrivals,
  backedTitle,
  dripGapMs,
  fastestRows,
  fillLine,
  liveLine,
  recapSlide,
  soonLine,
  tapeAction,
  tapeLabel,
  tapeWho,
} from "./happening-model";

test("UI-05 live line: '312 people' and '$48.2K'; one wallet is '1 person'", () => {
  assert.deepEqual(liveLine({ wallets: 312, usd: "48200.00" }), { people: "312 people", usd: "$48.2K" });
  assert.deepEqual(liveLine({ wallets: 1, usd: "40.00" }), { people: "1 person", usd: "$40" });
  assert.deepEqual(liveLine({ wallets: 1_204, usd: "1250000.00" }), { people: "1,204 people", usd: "$1.25M" });
});

test("UI-05 tape words (§17): blasted into, claimed tokens, a refund, trades; names and the accessible label", () => {
  assert.deepEqual(tapeAction(tapeEvent()), { verb: "blasted", amount: "$116", rest: "into TIDE" });
  assert.deepEqual(tapeAction(tapeEvent({ kind: "presale_claim", usd: null, tokens: "1240000", symbol: "LUMN" })), { verb: "claimed", amount: "1.24M", rest: "LUMN" });
  assert.deepEqual(tapeAction(tapeEvent({ kind: "presale_claim", usd: null, refund: "250", symbol: "HLCN" })), { verb: "claimed", amount: "$250", rest: "back from HLCN" });
  assert.deepEqual(tapeAction(tapeEvent({ kind: "trade_buy", usd: "757.00", symbol: "DEEP" })), { verb: "bought", amount: "$757", rest: "DEEP" });
  assert.deepEqual(tapeAction(tapeEvent({ kind: "trade_sell", usd: "12.00", symbol: "DEEP" })), { verb: "sold", amount: "$12", rest: "DEEP" });
  assert.equal(tapeWho(THEO_EVENT).firstName, "Theo");
  assert.equal(tapeWho(tapeEvent()).name, "0x0016…a95f");
  assert.equal(tapeLabel(THEO_EVENT, "Following"), "Theo Park, who you follow, blasted $757 TIDE");
  assert.equal(tapeLabel(THEO_EVENT, "Follows you"), "Theo Park, who follows you, blasted $757 TIDE");
  assert.equal(tapeLabel(tapeEvent({ usd: "108.00" }), null), "A wallet blasted $108 TIDE");
});

test("UI-05 arrivals: only events newer than the shown ones and not shown yet, oldest first; drip spreads them over the poll", () => {
  const a = tapeEvent({ activity_id: "1:0:0:0", occurred_at_ms: 10 });
  const b = tapeEvent({ activity_id: "2:0:0:0", occurred_at_ms: 20 });
  const c = tapeEvent({ activity_id: "3:0:0:0", occurred_at_ms: 30 });
  const old = tapeEvent({ activity_id: "0:0:0:0", occurred_at_ms: 5 });
  assert.deepEqual(arrivals([a], [c, b, a, old]).map((event) => event.activity_id), ["2:0:0:0", "3:0:0:0"]);
  assert.deepEqual(arrivals([c], [c, b]), []);
  assert.equal(dripGapMs(1, 30_000), 4_000);
  assert.equal(dripGapMs(9, 30_000), 3_000);
  assert.equal(dripGapMs(40, 30_000), 1_200);
});

test("UI-05 right column rows (§5.2, §5.3): two or more open; '99% · 1m 16s left'; 'Oct 14, 18:00 UTC · in 11d 0h'", () => {
  assert.equal(fastestRows(happeningRead()).length, 2);
  assert.deepEqual(fastestRows(happeningRead({ fastest: [TIDE] })), []);
  assert.equal(fillLine(TIDE.presale, FIXTURE_NOW), "99% · 1m 16s left");
  assert.equal(fillLine(MRDN.presale, FIXTURE_NOW), "73% · 6h 0m left");
  assert.equal(soonLine(SABL.presale, Date.UTC(2026, 9, 3, 18)), "Oct 14, 18:00 UTC · in 11d 0h");
  assert.equal(backedTitle(["Luca Romano", "Mira Chen", "Ana Souza"]), "Luca, Mira, Ana backed this");
});

test("admin-pinned closed and cancelled sales offer View, never Blast or Notify", () => {
  for (const presale of [
    { ...TIDE.presale, lifecycle: "cancelled" },
    { ...TIDE.presale, lifecycle: "closed" },
    { ...TIDE.presale, end_ms: FIXTURE_NOW - 1 },
  ]) {
    const slide = recapSlide(happeningPresale(presale), FIXTURE_NOW);
    assert.equal(slide.status, presale.lifecycle === "cancelled" ? "cancelled" : "closed");
    assert.equal(slide.cta, "view");
    assert.equal(slide.metric, null);
  }
});

test("UI-05 recap slides (§16): open, funded, trading and upcoming in the design's words", () => {
  const open = recapSlide(TIDE, FIXTURE_NOW);
  assert.equal(open.status, "open");
  assert.equal(open.when, "closes in 1m 16s");
  // R3-06 / visual check 2026-10-05 (HOME-2): the raise rounds down while it fills (398,600 is $398K, never $399K).
  assert.deepEqual(open.sub, [{ desk: "$398K of $400K", phone: "99% of $400K" }, { desk: "2,216 backers" }]);
  assert.deepEqual(open.metric, { figure: "99%", caption: null, bar: 99, tone: null });
  assert.equal(open.cta, "blast");
  const funded = recapSlide(CBLT, FIXTURE_NOW);
  assert.equal(funded.when, "1.25× oversubscribed");
  assert.deepEqual(funded.sub.map((part) => part.desk), ["$313K from 2,140 backers", "Trading opens on Bluefin"]);
  // R3-05 item 4 / OA-24: the caption is the overshoot, not the amount ("raised").
  assert.deepEqual(funded.metric, { figure: "1.25×", caption: "oversubscribed", bar: null, tone: null });
  const trading = recapSlide(KSTL, FIXTURE_NOW);
  assert.equal(trading.when, "on Cetus");
  assert.deepEqual(trading.whenMultiple, { text: "4.2×", precise: "4.2000×", tone: "up" });
  assert.deepEqual(trading.sub.map((part) => part.desk), ["$0.0005 → $0.0021", "since the presale"]);
  assert.deepEqual(trading.metric, { figure: "4.2×", caption: "since presale", bar: null, tone: "up" });
  const unpriced = recapSlide(happeningPresale({ ...KSTL.presale, market: null }, { launched_ms: Date.UTC(2026, 9, 1, 12) }), FIXTURE_NOW);
  assert.equal(unpriced.metric, null);
  assert.deepEqual(unpriced.sub.map((part) => part.desk), ["Launched Oct 1, 12:00 UTC"]);
  const upcoming = recapSlide(SABL, Date.UTC(2026, 9, 3, 18));
  assert.equal(upcoming.when, "opens Oct 14, 18:00 UTC");
  assert.deepEqual(upcoming.sub.map((part) => part.desk), ["Target $400K", "1,840 interested"]);
  assert.deepEqual(upcoming.metric, { figure: "11d 0h", caption: "to go", bar: null, tone: null });
  assert.equal(upcoming.cta, "notify");
  assert.equal(upcoming.pile, false);
});

test("#588: a sale scheduled to open later is an upcoming slide (its opening time, Notify) until its start, then open", () => {
  const start = Date.UTC(2026, 9, 14, 18);
  const row = happeningPresale({ ...TIDE.presale, lifecycle: "open", start_ms: start, end_ms: start + 3 * 86_400_000 });
  const before = recapSlide(row, start - 86_400_000);
  assert.equal(before.status, "upcoming");
  assert.equal(before.when, "opens Oct 14, 18:00 UTC");
  assert.equal(before.cta, "notify");
  const after = recapSlide(row, start);
  assert.equal(after.status, "open");
  assert.equal(after.cta, "blast");
});

test("OA-24: a funded sale that just met its target reads \"1.00× subscribed\", line and caption; above it, oversubscribed", () => {
  const at = (raised: string) => recapSlide(happeningPresale({ ...CBLT.presale, raise_target: "250000000000", raised }), FIXTURE_NOW);
  const exact = at("250000000000");
  assert.equal(exact.when, "1.00× subscribed");
  assert.deepEqual(exact.metric, { figure: "1.00×", caption: "subscribed", bar: null, tone: null });
  // Anything that rounds to 1.00 is "subscribed" (the gate's `toFixed(2) === '1.00'`), 1.01 is over.
  assert.equal(at("251000000000").when, "1.00× subscribed");
  assert.equal(at("252500000000").when, "1.01× oversubscribed");
  assert.equal(at("252500000000").metric?.caption, "oversubscribed");
  assert.equal(recapSlide(CBLT, FIXTURE_NOW).when, "1.25× oversubscribed");
});

test("R3-40-AC-1: Today on Blast reads a SUI sale's raise in SUI (`99.9K SUI of 100K SUI`); the tape reads its commit in dollars, as the gate's does, and its refund in SUI", () => {
  const drift = happeningPresale({
    ...TIDE.presale, name: "Driftwood", symbol: "DRFT", quote_symbol: "SUI", quote_decimals: 9, quote_usd: null,
    raise_target: "100000000000000", raised: "99970000000000", participants: 640,
  });
  const open = recapSlide(drift, FIXTURE_NOW);
  // R3-40-AC-4: floored in SUI while it fills, so it never reads as its target; and no SUI price is needed.
  assert.deepEqual(open.sub[0], { desk: "99.9K SUI of 100K SUI", phone: "99% of 100K SUI" });
  const funded = recapSlide(happeningPresale({ ...drift.presale, lifecycle: "funded", raised: "125000000000000" }), FIXTURE_NOW);
  assert.equal(funded.when, "1.25× oversubscribed");
  assert.equal(funded.sub[0]!.desk, "125K SUI from 640 backers");
  const upcoming = recapSlide(happeningPresale({ ...drift.presale, lifecycle: "pending", raised: "0", start_ms: Date.UTC(2026, 9, 14, 18) }), FIXTURE_NOW);
  assert.equal(upcoming.sub[0]!.desk, "Target 100K SUI");
  // The gate's `usd(e.usd)` for every commit.
  const commit = tapeEvent({ symbol: "DRFT", usd: "427.50", quote_symbol: "SUI" });
  assert.deepEqual(tapeAction(commit), { verb: "blasted", amount: "$428", rest: "into DRFT" });
  // A refund is in whole units of the sale's coin: SUI, never its SUI units as dollars.
  const refund = tapeEvent({ kind: "presale_claim", symbol: "DRFT", usd: null, refund: "125.5", quote_symbol: "SUI" });
  assert.deepEqual(tapeAction(refund), { verb: "claimed", amount: "125.5 SUI", rest: "back from DRFT" });
  // The USDC tape row is unchanged.
  assert.deepEqual(tapeAction(tapeEvent()), { verb: "blasted", amount: "$116", rest: "into TIDE" });
});

test("phone multipliers are compact while the accessible figure preserves precision", () => {
  const row = happeningPresale({ ...KSTL.presale, name: "A very long token name", market: { ...KSTL.presale.market!, multiple: "3700.125" } });
  assert.deepEqual(recapSlide(row, FIXTURE_NOW).whenMultiple, { text: "3.7K×", precise: "3700.125×", tone: "up" });
});
