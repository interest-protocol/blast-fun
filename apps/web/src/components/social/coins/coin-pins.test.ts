import assert from "node:assert/strict";
import test from "node:test";

import {
  COIN_PINS_KEY,
  PIN_MAX,
  livePins,
  pinLabel,
  pinSort,
  readCoinPins,
  togglePin,
  writeCoinPins,
  type PinStorage,
} from "./coin-pins";

/** R3-10 (FEATURE-MAP-R3 §14.2): favourite coins, up to five, per device, leading every list of your coins. */

function store(initial: Record<string, string> = {}, refuse = false): PinStorage & { readonly data: Record<string, string> } {
  const data = { ...initial };
  return {
    data,
    getItem: (key) => data[key] ?? null,
    setItem: (key, value) => {
      if (refuse) throw new Error("storage is full");
      data[key] = value;
    },
  };
}

test("R3-10: five favourites at most, and a sixth star changes nothing", () => {
  assert.equal(PIN_MAX, 5);
  let pins: readonly string[] = [];
  for (const key of ["usdc", "sui", "a", "b", "c"]) pins = togglePin(pins, key);
  assert.deepEqual(pins, ["usdc", "sui", "a", "b", "c"]);
  // The sixth is refused, by value: the same order comes back.
  assert.deepEqual(togglePin(pins, "d"), ["usdc", "sui", "a", "b", "c"]);
  // Starring again unstars, and the rest keep their order.
  assert.deepEqual(togglePin(pins, "sui"), ["usdc", "a", "b", "c"]);
  // With room again, the new one goes last — favourites stay in the order they were picked.
  assert.deepEqual(togglePin(togglePin(pins, "sui"), "d"), ["usdc", "a", "b", "c", "d"]);
});

test("R3-10: the stored list is read defensively; a refusing store keeps the choice in memory", () => {
  assert.deepEqual(readCoinPins(null), []);
  assert.deepEqual(readCoinPins(store()), []);
  assert.deepEqual(readCoinPins(store({ [COIN_PINS_KEY]: "not json" })), []);
  assert.deepEqual(readCoinPins(store({ [COIN_PINS_KEY]: '{"a":1}' })), []);
  // Duplicates, blanks and non-strings are dropped, and the list is cut to five.
  assert.deepEqual(readCoinPins(store({ [COIN_PINS_KEY]: '["a","a","",7,"b","c","d","e","f"]' })), ["a", "b", "c", "d", "e"]);
  const live = store();
  assert.equal(writeCoinPins(live, ["usdc", "sui"]), true);
  assert.deepEqual(readCoinPins(live), ["usdc", "sui"]);
  assert.equal(writeCoinPins(store({}, true), ["usdc"]), false);
  assert.equal(writeCoinPins(null, ["usdc"]), false);
});

test("R3-10: pins lead the list, in pin order; a pin for a coin the wallet no longer holds is ignored", () => {
  const coins = [{ key: "usdc" }, { key: "sui" }, { key: "kstl" }, { key: "lumn" }];
  assert.deepEqual(pinSort(coins, ["lumn", "sui"]).map((coin) => coin.key), ["lumn", "sui", "usdc", "kstl"]);
  // No favourites leaves the read's own order (USDC, SUI, then sale coins by value) untouched.
  assert.equal(pinSort(coins, []), coins);
  // A pin naming a coin that is gone neither reorders nor empties the list.
  assert.equal(pinSort(coins, ["gone"]), coins);
  assert.deepEqual(livePins(["gone", "sui", "kstl"], coins), ["sui", "kstl"]);
});

test("R3-10: the star says what it does, and why it cannot", () => {
  assert.equal(pinLabel("USDC", false, false), "Pin USDC to favourites");
  assert.equal(pinLabel("USDC", true, false), "Unpin USDC");
  assert.equal(pinLabel("USDC", true, true), "Unpin USDC");
  // Five already starred: the sixth star is disabled and says the limit instead of staying silent.
  assert.equal(pinLabel("USDC", false, true), "Up to 5 favourites");
});
