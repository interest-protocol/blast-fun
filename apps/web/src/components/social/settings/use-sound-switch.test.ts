import assert from "node:assert/strict";
import test from "node:test";

import {
  adoptAccountSound,
  FEEL_SOUND_PENDING_KEY,
  resetSoundEnabledCache,
  setSoundEnabled,
  soundChangeMark,
} from "#web/components/blast-feel/feel-sound-pref.ts";
import { DEFAULT_NOTIFICATION_PREFERENCES } from "@blast/core/modules/social/contracts/settings.ts";

import { keepDeviceSound, saveAccountSound, soundSaveFailureMessage } from "./use-sound-switch.ts";

/**
 * R3-12: a signed-in account keeps its sound choice through the settings
 * route, with only that field in the body and the session's own credentials
 * (OA-16); a refusal leaves the device's choice and says so. OA-33: saves go
 * in the reader's order, a kept save settles the device's pending choice, and
 * the choice a reader made on this device is handed — once — to an account
 * that has none.
 */

type Sent = { url: string; init: RequestInit };

function stub(status: number, body: unknown) {
  const sent: Sent[] = [];
  const fetch = (async (url: string, init: RequestInit) => {
    sent.push({ url, init });
    return new Response(JSON.stringify(body), { status });
  }) as unknown as typeof globalThis.fetch;
  return { sent, fetch };
}

const STORED = {
  privacy: "public",
  sharing_since_ms: 1,
  commit_too_coin_type: null, blast_mode_confirm_actions: false,
  public_portfolio: false,
  explorer: "suiscan",
  sound: false,
  notifications: DEFAULT_NOTIFICATION_PREFERENCES,
};

test("R3-12: turning sound off while signed in PUTs only { sound } to the settings route, with the session's token", async () => {
  const saved = stub(200, STORED);
  assert.equal(await saveAccountSound(async () => "tok", false, saved.fetch), null);
  assert.equal(saved.sent.length, 1);
  assert.equal(saved.sent[0]!.url, "/api/social/me/settings");
  assert.equal(saved.sent[0]!.init.method, "PUT");
  assert.deepEqual(JSON.parse(String(saved.sent[0]!.init.body)), { sound: false });
  assert.deepEqual(saved.sent[0]!.init.headers, { authorization: "Bearer tok", "content-type": "application/json" });
  // A wallet session has no token: its cookie goes instead, and no header is built by hand.
  const wallet = stub(200, { ...STORED, sound: true });
  assert.equal(await saveAccountSound(async () => null, true, wallet.fetch), null);
  assert.deepEqual(wallet.sent[0]!.init.headers, { "content-type": "application/json" });
  assert.equal(wallet.sent[0]!.init.credentials, "same-origin");
});

test("R3-12: a refused or failed save keeps the device's choice and says the account did not", async () => {
  const limited = stub(429, { error: { code: "rate_limited", message: "x" } });
  assert.equal(await saveAccountSound(async () => "tok", true, limited.fetch), "Sound is on on this device. Your account couldn’t save it, so another device keeps its own choice. Code: rate_limited.");
  const broken = stub(200, { nope: true });
  assert.equal(await saveAccountSound(async () => "tok", false, broken.fetch), "Sound is off on this device. Your account couldn’t save it, so another device keeps its own choice. Code: invalid_response.");
  assert.equal(soundSaveFailureMessage(false), "Sound is off on this device. Your account couldn’t save it, so another device keeps its own choice. Code: request_failed.");
});

test.after(() => {
  delete (globalThis as { window?: unknown }).window;
});

/** A device whose `localStorage` is a map (the sound flag and its pending mark live there). */
function device(): Map<string, string> {
  const values = new Map<string, string>();
  (globalThis as { window?: unknown }).window = {
    localStorage: { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => void values.set(key, value) },
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  };
  resetSoundEnabledCache();
  return values;
}

/** A fetch whose answers the test releases one at a time. */
function held() {
  const sent: unknown[] = [];
  const waiting: (() => void)[] = [];
  const fetch = ((_url: string, init: RequestInit) => {
    sent.push(JSON.parse(String(init.body)));
    return new Promise<Response>((resolve) => {
      waiting.push(() => resolve(new Response(JSON.stringify({ ...STORED, ...JSON.parse(String(init.body)) }), { status: 200 })));
    });
  }) as unknown as typeof globalThis.fetch;
  const settle = async () => {
    await new Promise((resolve) => setImmediate(resolve));
  };
  return { sent, fetch, release: () => waiting.shift()?.(), settle };
}

test("OA-33: sound saves go one at a time, in the reader's order, so a handed-over choice never lands after a newer flip", async () => {
  const values = device();
  setSoundEnabled(true);
  const net = held();
  // The session hands the account this device's on; the reader turns it off before that answers.
  const handed = keepDeviceSound(async () => "tok", true, net.fetch);
  setSoundEnabled(false);
  const flipped = saveAccountSound(async () => "tok", false, net.fetch);
  await net.settle();
  assert.deepEqual(net.sent, [{ sound: true }], "the flip waits for the save before it");
  net.release();
  assert.equal(await handed, true);
  assert.equal(values.get(FEEL_SOUND_PENDING_KEY), "true", "the account kept on, but this device now says off: still pending");
  await net.settle();
  assert.deepEqual(net.sent, [{ sound: true }, { sound: false }], "then the flip, last, as the reader made it");
  net.release();
  assert.equal(await flipped, null);
  assert.equal(values.get(FEEL_SOUND_PENDING_KEY), "false", "the account keeps the device's choice: settled");
  assert.equal(adoptAccountSound(null, soundChangeMark()), null, "nothing left to hand over");
});

test("OA-33: the device's choice is handed over once even when two reads answer together; a failure is quiet and retried next time", async () => {
  const values = device();
  setSoundEnabled(true);
  const net = held();
  const first = keepDeviceSound(async () => "tok", true, net.fetch);
  const second = keepDeviceSound(async () => "tok", true, net.fetch);
  assert.equal(await second, false, "the second read finds the first already handing it over");
  await net.settle();
  net.release();
  assert.equal(await first, true);
  assert.equal(net.sent.length, 1);
  assert.equal(values.get(FEEL_SOUND_PENDING_KEY), "false");

  // A refusal shows nothing (the reader did nothing just now) and leaves it pending for the next session.
  setSoundEnabled(false);
  assert.equal(await keepDeviceSound(async () => "tok", false, stub(429, { error: { code: "rate_limited", message: "x" } }).fetch), false);
  assert.equal(values.get(FEEL_SOUND_PENDING_KEY), "true");
  assert.equal(adoptAccountSound(null, soundChangeMark()), false);
});
