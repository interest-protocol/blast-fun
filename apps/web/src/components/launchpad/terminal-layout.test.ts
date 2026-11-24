import assert from "node:assert/strict";
import test from "node:test";

import {
  DESKTOP_DESTINATIONS,
  MOBILE_DESTINATIONS,
  nextDestination,
  TERMINAL_REGIONS,
  type TerminalRegion,
  terminalRegionVisibility,
} from "./terminal-layout.ts";

function visibleOn(
  breakpoint: "desktop" | "mobile",
  state: Parameters<typeof terminalRegionVisibility>[1],
): TerminalRegion[] {
  return TERMINAL_REGIONS.filter(
    (region) => terminalRegionVisibility(region, state)[breakpoint],
  );
}

test("mobile Chart view hosts the market, chart, Overview and Holders slots", () => {
  assert.deepEqual(visibleOn("mobile", { destination: "overview", mobileView: "chart" }), [
    "market",
    "chart",
    "overview",
    "holders",
  ]);
});

test("desktop shows discovery, workspace and rail with only the chosen destination", () => {
  for (const destination of DESKTOP_DESTINATIONS) {
    assert.deepEqual(visibleOn("desktop", { destination, mobileView: "discover" }), [
      "discovery",
      "market",
      "chart",
      destination,
      "execution",
    ]);
  }
});

test("mobile Theses view hosts the market context, Theses and Activity slots", () => {
  assert.deepEqual(visibleOn("mobile", { destination: "overview", mobileView: "theses" }), [
    "market",
    "theses",
    "activity",
  ]);
});

test("mobile Discover view shows discovery alone", () => {
  assert.deepEqual(visibleOn("mobile", { destination: "holders", mobileView: "discover" }), [
    "discovery",
  ]);
});

test("mobile has exactly Discover, Chart, Trade and Theses, and Trade is never in page flow", () => {
  assert.deepEqual([...MOBILE_DESTINATIONS], ["discover", "chart", "trade", "theses"]);
  for (const mobileView of ["discover", "chart", "theses"] as const) {
    assert.equal(
      terminalRegionVisibility("execution", { destination: "overview", mobileView }).mobile,
      false,
    );
  }
});

test("arrow, Home and End keys move between desktop destinations and wrap", () => {
  assert.equal(nextDestination("overview", "ArrowRight"), "theses");
  assert.equal(nextDestination("holders", "ArrowRight"), "overview");
  assert.equal(nextDestination("overview", "ArrowLeft"), "holders");
  assert.equal(nextDestination("activity", "Home"), "overview");
  assert.equal(nextDestination("theses", "End"), "holders");
  assert.equal(nextDestination("theses", "Enter"), null);
});
