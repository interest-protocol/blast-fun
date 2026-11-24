import assert from "node:assert/strict";
import test from "node:test";

import * as pref from "./feel-sound-pref.ts";
import {
  adoptAccountSound,
  FEEL_SOUND_DEFAULT,
  FEEL_SOUND_KEY,
  FEEL_SOUND_PENDING_KEY,
  followSoundEnabled,
  markSoundSaved,
  readSoundChoice,
  resetSoundEnabledCache,
  setSoundEnabled,
  soundChangeMark,
  soundEnabledNow,
} from "./feel-sound-pref.ts";

/**
 * Sound is off until the reader turns it on (the owner, 2026-10-06, amending
 * OA-25 Q3a). The device's flag is the live one: off with nothing stored, a
 * stored choice kept. A signed-in session adopts the account's choice only
 * when the account has one (`sound` non-null) — never turning sound on by
 * itself — unless the reader changed the flag on this device while the read
 * was in flight. An account with no choice is handed the one the reader made
 * on this device, but never one this device copied from another account.
 */

type Store = Readonly<{ storage: Storage; values: Map<string, string> }>;

function memoryStorage(initial: Readonly<Record<string, string>> = {}): Store {
  const values = new Map(Object.entries(initial));
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
  } as unknown as Storage;
  return { storage, values };
}

/** A fresh page on a device whose `localStorage` is `storage`, or refuses to be reached (a private window). */
function device(storage: Storage | "refusing"): void {
  const page = {
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    get localStorage(): Storage {
      if (storage === "refusing") throw new Error("SecurityError");
      return storage;
    },
  };
  (globalThis as { window?: unknown }).window = page;
  resetSoundEnabledCache();
}

test.after(() => {
  delete (globalThis as { window?: unknown }).window;
});

test("OA-33: with nothing stored the flag is off — for a visitor, and after a sign-in whose account has not chosen", () => {
  const { storage, values } = memoryStorage();
  device(storage);
  assert.equal(FEEL_SOUND_DEFAULT, false);
  assert.equal("FEEL_SOUND_ACCOUNT_DEFAULT" in pref, false, "no account default exists any more");
  assert.equal(readSoundChoice(storage), null, "no choice stored");
  assert.equal(soundEnabledNow(), false);
  // The first sign-in: the account's read answers `sound: null`.
  assert.equal(adoptAccountSound(null, soundChangeMark()), null, "nothing to hand over: nobody chose");
  assert.equal(soundEnabledNow(), false, "signing in never turns sound on");
  assert.equal(values.has(FEEL_SOUND_KEY), false, "and nothing was written as if it were a choice");
});

test("OA-33: a stored choice is the reader's and is kept, whatever an account with no choice says", () => {
  for (const stored of [true, false]) {
    const { storage, values } = memoryStorage({ [FEEL_SOUND_KEY]: JSON.stringify(stored) });
    device(storage);
    assert.equal(readSoundChoice(storage), stored);
    assert.equal(soundEnabledNow(), stored);
    assert.equal(adoptAccountSound(null, soundChangeMark()), null, "a value from before (the prototype's) is not pending");
    assert.equal(soundEnabledNow(), stored);
    assert.equal(values.get(FEEL_SOUND_KEY), JSON.stringify(stored));
  }
  // Malformed is not a choice.
  for (const raw of ["not json", '"yes"', "1", "null"]) {
    const { storage } = memoryStorage({ [FEEL_SOUND_KEY]: raw });
    device(storage);
    assert.equal(readSoundChoice(storage), null, raw);
    assert.equal(soundEnabledNow(), false, raw);
  }
});

test("OA-33: an account's explicit choice is adopted — on and off — and kept on the device", () => {
  const { storage, values } = memoryStorage();
  device(storage);
  assert.equal(adoptAccountSound(true, soundChangeMark()), null);
  assert.equal(soundEnabledNow(), true, "the account chose on, on another device");
  assert.equal(values.get(FEEL_SOUND_KEY), "true");
  assert.equal(adoptAccountSound(false, soundChangeMark()), null);
  assert.equal(soundEnabledNow(), false);
  assert.equal(values.get(FEEL_SOUND_KEY), "false", "an explicit off is kept too, not just the absence of on");
  // Adopting is not the reader's own change: it does not move the mark.
  const before = soundChangeMark();
  adoptAccountSound(true, before);
  assert.equal(soundChangeMark(), before);
});

test("R3-12: the reader's change here beats a late account read, whatever that read says", () => {
  const { storage } = memoryStorage();
  device(storage);
  for (const account of [true, false, null] as const) {
    const mark = soundChangeMark();
    setSoundEnabled(false);
    assert.equal(adoptAccountSound(account, mark), null, `a late ${String(account)} hands nothing over and changes nothing`);
    assert.equal(soundEnabledNow(), false);
    const again = soundChangeMark();
    setSoundEnabled(true);
    assert.equal(adoptAccountSound(account === null ? null : !account, again), null);
    assert.equal(soundEnabledNow(), true, "the reader's newer on stands");
  }
});

test("OA-33: the reader's own choice is handed to an account that has none, until an account keeps it", () => {
  const { storage, values } = memoryStorage();
  device(storage);
  // A visitor turns sound on, then signs in to an account that never chose.
  setSoundEnabled(true);
  assert.equal(values.get(FEEL_SOUND_PENDING_KEY), "true");
  assert.equal(adoptAccountSound(null, soundChangeMark()), true, "hand the account this device's on");
  assert.equal(soundEnabledNow(), true, "and keep it here");
  // The save has not answered yet: a second read still hands it over (the save is idempotent).
  assert.equal(adoptAccountSound(null, soundChangeMark()), true);
  // A save for some other value does not settle it.
  markSoundSaved(false);
  assert.equal(adoptAccountSound(null, soundChangeMark()), true);
  // The account kept it: nothing is pending any more.
  markSoundSaved(true);
  assert.equal(values.get(FEEL_SOUND_PENDING_KEY), "false");
  assert.equal(adoptAccountSound(null, soundChangeMark()), null);
  // An explicit off is handed over the same way.
  setSoundEnabled(false);
  assert.equal(adoptAccountSound(null, soundChangeMark()), false);
});

test("OA-33: a choice copied from one account is never handed to another that signs in on the same device", () => {
  const { storage } = memoryStorage();
  device(storage);
  // The reader's own choice, then an account with its own: the account's wins and nothing is pending.
  setSoundEnabled(false);
  assert.equal(adoptAccountSound(true, soundChangeMark()), null);
  assert.equal(soundEnabledNow(), true);
  // Another person signs in here, to an account that never chose: the device's flag stays, but it is not theirs to keep.
  assert.equal(adoptAccountSound(null, soundChangeMark()), null);
  assert.equal(soundEnabledNow(), true);
  // The same after a reload: the pending mark is stored, not only remembered.
  resetSoundEnabledCache();
  assert.equal(adoptAccountSound(null, soundChangeMark()), null);
});

test("storage that refuses (a private window) keeps the choice, and what is pending, for the page's life", () => {
  device("refusing");
  assert.equal(soundEnabledNow(), false);
  setSoundEnabled(true);
  assert.equal(soundEnabledNow(), true);
  assert.equal(adoptAccountSound(null, soundChangeMark()), true);
  markSoundSaved(true);
  assert.equal(adoptAccountSound(null, soundChangeMark()), null);
});

test("the synth's switch follows the flag synchronously: now, on the reader's change and on an adopted one", () => {
  const { storage } = memoryStorage({ [FEEL_SOUND_KEY]: "false" });
  device(storage);
  const seen: boolean[] = [];
  const unfollow = followSoundEnabled((enabled) => seen.push(enabled));
  assert.deepEqual(seen, [false], "told at once");
  setSoundEnabled(true);
  assert.deepEqual(seen, [false, true], "before setSoundEnabled returns");
  adoptAccountSound(false, soundChangeMark());
  assert.deepEqual(seen, [false, true, false], "before adoptAccountSound returns");
  adoptAccountSound(null, soundChangeMark());
  assert.deepEqual(seen, [false, true, false], "an account with no choice changes nothing");
  unfollow();
  setSoundEnabled(true);
  assert.deepEqual(seen, [false, true, false]);
});
