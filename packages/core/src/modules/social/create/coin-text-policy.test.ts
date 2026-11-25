import assert from "node:assert/strict";
import test from "node:test";

import { isHighlightable } from "./coin-text-policy.ts";

test("the highlight hides slurs and coins about the founder, and keeps ordinary names", () => {
  const hidden = ["Adeniyi", "The Aden", "TheAdeniyi", "ADEN1YI", "a.d.e.n", "Eman", "EmanAbio", "eman abio", "Abiodun", "Nigger"];
  for (const name of hidden) assert.equal(isHighlightable({ name, symbol: "COIN" }), false, name);
  assert.equal(isHighlightable({ name: "Moon", symbol: "ADEN" }), false, "the ticker counts too");
  const shown = ["Froggy", "Cadence", "Garden", "Ada", "Batman", "Madeline", null];
  for (const name of shown) assert.equal(isHighlightable({ name, symbol: "COIN" }), true, String(name));
});
