import assert from "node:assert/strict";
import test from "node:test";

import { isHighlightable } from "./coin-text-policy.ts";

test("the highlight hides slurs and coins about the founder, and keeps ordinary names", () => {
  const hidden = ["Adeniyi", "The Aden", "TheAdeniyi", "ADEN1YI", "a.d.e.n", "Eman", "EmanAbio", "eman abio", "Abiodun", "Abi0dun", "TheAden", "theEman", "Nigger"];
  for (const name of hidden) assert.equal(isHighlightable({ name, symbol: "COIN" }), false, name);
  assert.equal(isHighlightable({ name: "Moon", symbol: "ADEN" }), false, "the ticker counts too");
  const shown = ["Froggy", "Cadence", "Garden", "Ada", "Batman", "Madeline", null];
  for (const name of shown) assert.equal(isHighlightable({ name, symbol: "COIN" }), true, String(name));
});

test("the highlight hides sexual coins, spelled out or glued, and keeps words that only contain the letters", () => {
  const hidden = ["PornCoin", "P0RN", "p o r n", "s e x", "S3X", "Sexy Cat", "Big Tits", "Nudes", "Hentai Inu", "NSFW",
    "OnlyFans", "Pussy Cat", "FuckCoin", "Milf", "Dicks", "Hoes", "Horny Pepe", "Jerk Off", "XXX", "SexCoin", "DickButt",
    "Blow Job", "Only Fan", "Orgies", "pu55y", "5ex", "Asshole"];
  for (const name of hidden) assert.equal(isHighlightable({ name, symbol: "COIN" }), false, name);
  const shown = ["Essex", "Grape", "Peacock", "Cucumber", "Analysis", "Titan", "Dickens", "Torpedo", "Cockpit", "Shoe",
    "Class", "Assets", "Sextant", "Tamil Finance", "Tamil-Finance", "Prince-Stark", "Top-Ornament", "Milford", "Dik Dik",
    "Jerk Official", "Bass Coin", "Agent 47"];
  for (const name of shown) assert.equal(isHighlightable({ name, symbol: "COIN" }), true, name);
});
