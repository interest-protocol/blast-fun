import assert from "node:assert/strict";
import test from "node:test";

import { DEFAULT_DEVICE_PREFS, DEVICE_PREF_KEYS, readDevicePrefs, writeDevicePref } from "./device-prefs.ts";
import { explorerAccountUrl, explorerTransactionUrl } from "@blast/core/lib/explorer.ts";

function memory(entries: Record<string, string> = {}) {
  const map = new Map(Object.entries(entries));
  return { getItem: (key: string) => map.get(key) ?? null, setItem: (key: string, value: string) => void map.set(key, value), map };
}

test("UI-07: device preferences: Celebrations on and Suiscan by default; junk and blocked storage read as defaults", () => {
  assert.deepEqual(DEFAULT_DEVICE_PREFS, { celebrate: true, explorer: "suiscan" });
  assert.deepEqual(DEVICE_PREF_KEYS, { celebrate: "blast.celebrate", explorer: "blast.explorer" });
  assert.deepEqual(readDevicePrefs(null), DEFAULT_DEVICE_PREFS);
  assert.deepEqual(readDevicePrefs(memory({ "blast.celebrate": "false", "blast.explorer": '"suivision"' })), { celebrate: false, explorer: "suivision" });
  assert.deepEqual(readDevicePrefs(memory({ "blast.celebrate": "{", "blast.explorer": '"etherscan"' })), DEFAULT_DEVICE_PREFS);
  const throwing = { getItem: () => { throw new Error("SecurityError"); }, setItem: () => { throw new Error("QuotaExceeded"); } };
  assert.deepEqual(readDevicePrefs(throwing), DEFAULT_DEVICE_PREFS);
  assert.equal(writeDevicePref(throwing, "celebrate", false), false);
  const store = memory();
  assert.equal(writeDevicePref(store, "explorer", "suivision"), true);
  assert.equal(store.map.get("blast.explorer"), '"suivision"');
});

test("UI-07: explorer links follow the chosen explorer, on mainnet, and refuse malformed values", () => {
  const digest = "8Xq7v3qA1pBvXk9qP1uK4mK8tQ2yH3nB5cD6eF7gH8jK";
  const address = `0x${"ab".repeat(32)}`;
  assert.equal(explorerTransactionUrl("suiscan", digest), `https://suiscan.xyz/mainnet/tx/${digest}`);
  assert.equal(explorerTransactionUrl("suivision", digest), `https://suivision.xyz/txblock/${digest}`);
  assert.equal(explorerAccountUrl("suiscan", address), `https://suiscan.xyz/mainnet/account/${address}`);
  assert.equal(explorerAccountUrl("suivision", address), `https://suivision.xyz/account/${address}`);
  assert.equal(explorerTransactionUrl("suiscan", "../../x"), null);
  assert.equal(explorerAccountUrl("suiscan", "0xzz"), null);
});

test("old Home pause settings do not change active device preferences", () => {
  assert.deepEqual(readDevicePrefs(memory({ "blast.liveRankings": "false" })), DEFAULT_DEVICE_PREFS);
});
