import assert from "node:assert/strict";
import test from "node:test";

import { BAR_SLIDE, slideBarFill } from "./bar-slide";

test("first fill snaps; changed fill slides; repeated fill leaves the transition alone", () => {
  const bar = { style: { transform: "", transition: "" } };
  slideBarFill(bar, 73.68);
  assert.deepEqual(bar.style, { transform: "scaleX(0.7368)", transition: "" });
  slideBarFill(bar, 73.68);
  assert.equal(bar.style.transition, "");
  slideBarFill(bar, 74.39);
  assert.deepEqual(bar.style, { transform: "scaleX(0.7439)", transition: BAR_SLIDE });
  slideBarFill(bar, -20);
  assert.equal(bar.style.transform, "scaleX(0)");
  slideBarFill(bar, 120);
  assert.equal(bar.style.transform, "scaleX(1)");
});

test("CSSOM-normalized fills remain unchanged on a repeated render", async () => {
  const { JSDOM } = await import("jsdom");
  const dom = new JSDOM();
  try {
    const bar = dom.window.document.createElement("i");
    slideBarFill(bar, 25);
    bar.style.transform = "scaleX(0.25)"; // Browsers remove trailing zeroes when serializing CSSOM.
    slideBarFill(bar, 25);
    assert.equal(bar.style.transition, "", "a repeated initial fill must not enable a transition");
  } finally {
    dom.window.close();
  }
});
