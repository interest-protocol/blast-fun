import assert from "node:assert/strict";
import test from "node:test";

import {
  FEEL_SOUND_KEY,
  resetSoundEnabledCache,
  setSoundEnabled,
  soundChangeMark,
  soundEnabledNow,
} from "#web/components/blast-feel/feel-sound-pref.ts";
import { DEFAULT_NOTIFICATION_PREFERENCES } from "@blast/core/modules/social/contracts/settings.ts";

import { adoptAccountSettings } from "./use-account-settings-sync.ts";

/**
 * OA-33 (amending OA-25 Q3a) at the point a signed-in session reads its
 * account's settings: an account that has never chosen (`sound: null`) never
 * turns sound on; an explicit choice is adopted; and the choice the reader
 * made on this device is handed to an account that has none — once, with
 * only `{ sound }` in the body and the session's own credentials (OA-16).
 */

type Sent = Readonly<{ url: string; method: string | undefined; body: unknown; headers: unknown }>;

function page(stored: Readonly<Record<string, string>> = {}) {
  const values = new Map(Object.entries(stored));
  (globalThis as { window?: unknown }).window = {
    localStorage: { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => void values.set(key, value) },
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  };
  resetSoundEnabledCache();
  const sent: Sent[] = [];
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    const body: unknown = init.body === undefined ? undefined : JSON.parse(String(init.body));
    sent.push({ url, method: init.method, body, headers: init.headers });
    return new Response(JSON.stringify({ ...ANSWER, ...(body as object) }), { status: 200 });
  }) as unknown as typeof globalThis.fetch;
  return { values, sent };
}

const ANSWER = {
  privacy: "public",
  sharing_since_ms: 1,
  commit_too_coin_type: null, blast_mode_confirm_actions: false,
  public_portfolio: false,
  explorer: "suiscan",
  sound: null,
  notifications: DEFAULT_NOTIFICATION_PREFERENCES,
} as const;

const token = async () => "tok";
const settled = () => new Promise((resolve) => setImmediate(resolve));
const realFetch = globalThis.fetch;

test.after(() => {
  delete (globalThis as { window?: unknown }).window;
  globalThis.fetch = realFetch;
});

test("OA-33: an account that has not chosen leaves a device with no choice off, and nothing is written anywhere", async () => {
  const { values, sent } = page();
  adoptAccountSettings({ explorer: "suiscan", sound: null }, soundChangeMark(), token);
  await settled();
  assert.equal(soundEnabledNow(), false);
  assert.equal(values.has(FEEL_SOUND_KEY), false);
  assert.deepEqual(sent, [], "no choice to hand over");
});

test("OA-33: an account's explicit choice is adopted onto the device, and nothing is sent back", async () => {
  for (const sound of [true, false]) {
    const { values, sent } = page({ [FEEL_SOUND_KEY]: JSON.stringify(!sound) });
    adoptAccountSettings({ explorer: "suivision", sound }, soundChangeMark(), token);
    await settled();
    assert.equal(soundEnabledNow(), sound);
    assert.equal(values.get(FEEL_SOUND_KEY), JSON.stringify(sound));
    assert.deepEqual(sent, []);
  }
});

test("OA-33: the reader's own choice here is handed to an account with none — once — and a late read never undoes a newer flip", async () => {
  const { sent } = page();
  // A visitor turns sound on, then signs in to an account that never chose.
  setSoundEnabled(true);
  adoptAccountSettings({ explorer: "suiscan", sound: null }, soundChangeMark(), token);
  await settled();
  assert.equal(soundEnabledNow(), true, "the device keeps it");
  assert.deepEqual(sent, [
    { url: "/api/social/me/settings", method: "PUT", body: { sound: true }, headers: { authorization: "Bearer tok", "content-type": "application/json" } },
  ]);
  // The next read (the Settings page, a new tab): the account kept it, and nothing is pending.
  adoptAccountSettings({ explorer: "suiscan", sound: null }, soundChangeMark(), token);
  await settled();
  assert.equal(sent.length, 1, "handed over once");

  // A read that started before the reader's newer flip neither adopts nor hands over anything.
  const mark = soundChangeMark();
  setSoundEnabled(false);
  adoptAccountSettings({ explorer: "suiscan", sound: true }, mark, token);
  adoptAccountSettings({ explorer: "suiscan", sound: null }, mark, token);
  await settled();
  assert.equal(soundEnabledNow(), false);
  assert.equal(sent.length, 1);
});
