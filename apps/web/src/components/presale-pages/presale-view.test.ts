import { monthsBetween } from "@blast/core/lib/format.ts";
import assert from "node:assert/strict";
import test from "node:test";

import { FIXTURE_NOW, fixtureDetail, fixtureList, fixtureViewer, fixtureId } from "../../../../../packages/core/test/fixtures/presale-pages/presale-fixtures.ts";
import { fundingPercentText, isOversubscribed, claimableTokenText, nextFigure, stepIndex, stepProgress, stepSubs, vestPlain, whenOf } from "@blast/core/modules/presale/presentation.ts";

test("claim quantities preserve every indexed atom, including fractions and large balances", () => {
  const sale = { ...fixtureDetail("kstl").presale, sale_decimals: 9 };
  const mine = { ...fixtureViewer()[fixtureId("kstl")]!.mine!, claimed: false };
  assert.equal(claimableTokenText(sale, { ...mine, claimable_tokens: "440000000000000000" }), "440,000,000 KSTL");
  assert.equal(claimableTokenText(sale, { ...mine, claimable_tokens: "9007199254740993000000001" }), "9,007,199,254,740,993.000000001 KSTL");
  for (const claimable_tokens of [null, undefined, "-1", "1e9"]) assert.equal(claimableTokenText(sale, { ...mine, claimable_tokens }), null);
});

const byName = (status: "live" | "upcoming" | "ended", name: string) =>
  fixtureList(status, status === "live" ? "ending" : status === "upcoming" ? "opening" : "recent").presales.find((sale) => sale.name === name)!;

test("UI-09: each phase's row says what matters next, in the design's words", () => {
  assert.deepEqual(whenOf(byName("live", "Meridian")), { kind: "left", endMs: byName("live", "Meridian").end_ms });
  assert.deepEqual(whenOf(byName("upcoming", "Sable")), { kind: "opens", day: "Oct 14", time: "18:00 UTC" });
  // OA-13: a sale opens the moment it is created on chain, so until then a pending sale has no start.
  assert.deepEqual(whenOf({ ...byName("upcoming", "Sable"), start_ms: 0 }), { kind: "plain", text: "Not open yet" });
  assert.deepEqual(whenOf(byName("ended", "Kestrel")), { kind: "multiple", value: "4.2×", up: true });
  assert.deepEqual(whenOf(byName("ended", "Lumen")), { kind: "multiple", value: "0.6×", up: false });
  assert.deepEqual(whenOf(byName("ended", "Cobalt")), { kind: "oversubscribed", value: "1.25×" });
  assert.deepEqual(whenOf(byName("ended", "Halcyon")), { kind: "plain", text: "Refunds open" });
  assert.deepEqual(whenOf({ ...byName("ended", "Kestrel"), multiple: null }), { kind: "plain", text: "Trading on Cetus" });
});

test("UI-10: the stepper and the strip follow the phase", () => {
  assert.deepEqual(["pending", "open", "closed", "funded", "trading"].map((phase) => stepIndex(phase as never)), [0, 0, 1, 1, 2]);
  const mrdn = fixtureDetail("mrdn");
  assert.deepEqual(stepSubs(mrdn), ["Opened Oct 2", "Oct 4", "On Cetus"]);
  const sabl = fixtureDetail("sabl");
  assert.equal(stepSubs({ ...sabl, presale: { ...sabl.presale, start_ms: 0 } })[0], "Not open yet");
  assert.equal(nextFigure(mrdn.presale).label, "Closes");
  assert.equal(nextFigure(mrdn.presale).note, "Oct 4, 00:12 UTC");
  assert.deepEqual(nextFigure(fixtureDetail("cblt").presale), { label: "Closed", at: fixtureDetail("cblt").presale.ended_ms ?? fixtureDetail("cblt").presale.end_ms, note: "Claims open at launch" });
  assert.deepEqual(nextFigure(fixtureDetail("kstl").presale), { label: "Launched", at: fixtureDetail("kstl").presale.launched_ms ?? fixtureDetail("kstl").presale.end_ms, note: "on Cetus" });
  assert.deepEqual(nextFigure(fixtureDetail("hlcn").presale), { label: "Ended", at: fixtureDetail("hlcn").presale.ended_ms ?? fixtureDetail("hlcn").presale.end_ms, note: "Refunds are open" });
  assert.equal(monthsBetween(FIXTURE_NOW, FIXTURE_NOW + 360 * 86_400_000), 12);
  assert.equal(vestPlain(360 * 86_400_000), "Unlocks steadily from launch, all of it after 12 mo. No one can cancel the schedule.");
});

const timesOf = (detail: ReturnType<typeof fixtureDetail>) => ({
  startMs: detail.presale.opened_ms ?? detail.presale.start_ms,
  endMs: detail.presale.end_ms,
});

test("R3-85 (OA-41 8645–8654): the bar after the current step is how far along that step is, clamped 0–1", () => {
  // Open: from the start to the close. Meridian opened 42 h ago and closes in 6 h 12 m 41 s.
  const mrdn = fixtureDetail("mrdn");
  const open = stepProgress("open", timesOf(mrdn), FIXTURE_NOW);
  assert.ok(Math.abs(open - 42 / (42 + 6 + 12 / 60 + 41 / 3600)) < 1e-9, String(open));
  assert.equal(stepProgress("open", timesOf(mrdn), mrdn.presale.end_ms + 1), 1);
  assert.equal(stepProgress("open", timesOf(mrdn), 0), 0);
  // Without a start (OA-13: a sale has none until it is created on chain) there is no bar.
  assert.equal(stepProgress("open", { ...timesOf(mrdn), startMs: null }, FIXTURE_NOW), 0);
  // Trading is the final sale milestone; vesting never adds a synthetic timer.
  for (const phase of ["trading", "funded", "closed", "pending", "cancelled"] as const) assert.equal(stepProgress(phase, timesOf(fixtureDetail("cblt")), FIXTURE_NOW), 0, phase);
});

test("discovery funding distinguishes zero, below, exact target and atom-level overflow", () => {
  const sale = fixtureList("live", "ending").presales[0]!;
  for (const [raised_atoms, fill_bps, text, overflow] of [["0", 0, "0%", false], ["500", 5000, "50%", false], ["1000", 10000, "100%", false], ["1001", 10000, ">100%", true], ["1100", 11000, "110%", true]] as const) {
    const value = { ...sale, target_atoms: "1000", raised_atoms, fill_bps };
    assert.equal(fundingPercentText(value), text);
    assert.equal(isOversubscribed(value), overflow);
  }
  assert.equal(isOversubscribed({ target_atoms: "0", raised_atoms: "1000" }), false);
});
