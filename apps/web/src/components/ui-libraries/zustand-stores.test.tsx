import assert from "node:assert/strict";
import test from "node:test";

import { renderToString } from "react-dom/server";

import { DEFAULT_DEVICE_PREFS, setDevicePref, useDevicePrefs } from "#web/components/blast-ui/device-prefs.ts";
import {
  FEEL_SOUND_KEY,
  followSoundEnabled,
  resetSoundEnabledCache,
  setSoundEnabled,
  subscribeSoundEnabled,
  useSoundEnabled,
} from "#web/components/blast-feel/feel-sound-pref.ts";
import { blastModeCovering, coverPage, onUncover } from "#web/components/social/blast-mode/live/mode-cover.ts";
import { COIN_PINS_KEY, resetCoinPinsCache, toggleCoinPin, useCoinPins } from "#web/components/social/coins/coin-pins.ts";
import { useCommitClock } from "#web/components/social/commit/commit-clock.ts";

import { deviceStore } from "./device-store";

/**
 * OA-28 M6: the client-side stores moved onto zustand with their hooks
 * unchanged (server state is TanStack Query's, oa38). Each still tells its
 * readers synchronously, once per change; the server and hydration still
 * render the default state; and the localStorage-backed ones keep the
 * prototype's keys and plain JSON, written before any reader hears the change.
 */

type Values = Map<string, string>;

/** A browser page whose `localStorage` is a map. */
function page(initial: Readonly<Record<string, string>> = {}): Values {
  const values: Values = new Map(Object.entries(initial));
  (globalThis as { window?: unknown }).window = {
    localStorage: { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => void values.set(key, value) },
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  };
  return values;
}

test.after(() => {
  delete (globalThis as { window?: unknown }).window;
});

test("device store: read once on first use without telling anyone; a change tells every reader at once", () => {
  let reads = 0;
  const store = deviceStore(() => {
    reads += 1;
    return ["a"] as readonly string[];
  });
  let heard = 0;
  const off = store.subscribe(() => void (heard += 1));
  const first = store.get();
  assert.equal(store.get(), first, "the same value until it changes (useSyncExternalStore compares identity)");
  assert.equal(reads, 1);
  assert.equal(heard, 0, "the first read is a fill, not a change");
  store.set(["b"]);
  assert.equal(heard, 1);
  store.hold(["c"]);
  assert.equal(heard, 1, "hold is silent (the caller tells its own reader)");
  assert.deepEqual(store.get(), ["c"]);
  store.forget(false);
  assert.equal(heard, 1);
  assert.deepEqual(store.get(), ["a"], "read again after forgetting");
  assert.equal(reads, 2);
  let seen: readonly string[] | null = null;
  const off2 = store.subscribe(() => void (seen = store.get()));
  store.forget(true);
  assert.equal(reads, 3, "a reader told of the forget reads storage again");
  assert.deepEqual(seen, ["a"]);
  off();
  off2();
  store.set(["z"]);
  assert.equal(heard, 2, "an unsubscribed reader hears nothing");
});

test("coin pins: the prototype's key and JSON array; none on the server", () => {
  const values = page({ [COIN_PINS_KEY]: JSON.stringify(["sui"]) });
  resetCoinPinsCache();
  function Pins() {
    return <i>{useCoinPins().join(",") || "none"}</i>;
  }
  toggleCoinPin("usdc");
  assert.equal(renderToString(<Pins />), "<i>none</i>", "the server and hydration render no favourites");
  assert.equal(values.get(COIN_PINS_KEY), JSON.stringify(["sui", "usdc"]));
  const next = toggleCoinPin("sui");
  assert.deepEqual(next, ["usdc"]);
  assert.equal(values.get(COIN_PINS_KEY), JSON.stringify(["usdc"]));
  values.set(COIN_PINS_KEY, JSON.stringify(["x", "x", "y"]));
  resetCoinPinsCache();
  assert.deepEqual(toggleCoinPin("z"), ["x", "y", "z"], "another tab's write is read again after a reset");
});

test("device prefs: one key written per change, the other left alone; defaults on the server", () => {
  const values = page({ "blast.explorer": "not json" });
  function Prefs() {
    const prefs = useDevicePrefs();
    return <i>{`${prefs.celebrate} ${prefs.explorer}`}</i>;
  }
  setDevicePref("celebrate", false);
  assert.equal(values.get("blast.celebrate"), "false");
  assert.equal(values.get("blast.explorer"), "not json", "the other key is left as it is: no choice is written for the reader");
  assert.equal(renderToString(<Prefs />), `<i>${DEFAULT_DEVICE_PREFS.celebrate} ${DEFAULT_DEVICE_PREFS.explorer}</i>`);
  setDevicePref("celebrate", false);
  assert.equal(values.size, 2, "an unchanged value writes nothing");
});

test("sound (OA-33): on by default on the server; the choice is in storage before the synth's switch hears it, in the same call", () => {
  const values = page();
  resetSoundEnabledCache();
  function Sound() {
    return <i>{String(useSoundEnabled())}</i>;
  }
  setSoundEnabled(false);
  assert.equal(renderToString(<Sound />), "<i>true</i>", "the server snapshot uses the default");
  setSoundEnabled(true);
  const seen: (string | undefined)[] = [];
  const off = subscribeSoundEnabled(() => void seen.push(values.get(FEEL_SOUND_KEY)));
  const heard: boolean[] = [];
  const unfollow = followSoundEnabled((enabled) => heard.push(enabled));
  setSoundEnabled(false);
  assert.deepEqual(seen, ["false"], "stored first, then told");
  assert.deepEqual(heard, [true, false], "followed now and on the change, before setSoundEnabled returned");
  resetSoundEnabledCache();
  assert.deepEqual(heard, [true, false], "forgetting the cached choice tells nobody");
  off();
  unfollow();
});

test("commit clock: 0 on the server and while hydrating", () => {
  function Clock() {
    return <i>{useCommitClock()}</i>;
  }
  assert.equal(renderToString(<Clock />), "<i>0</i>");
});

test("the page cover: readers hear one uncover, once the last cover lifts", () => {
  let uncovered = 0;
  const stop = onUncover(() => void (uncovered += 1));
  const a = coverPage();
  const b = coverPage();
  a();
  assert.equal(blastModeCovering(), true);
  assert.equal(uncovered, 0);
  b();
  assert.equal(uncovered, 1);
  stop();
});
