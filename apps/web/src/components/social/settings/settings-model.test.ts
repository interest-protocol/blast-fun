import assert from "node:assert/strict";
import test from "node:test";

import { qty } from "@blast/core/lib/format.ts";

import {
  DEFAULT_NOTIFICATION_PREFERENCES,
  NOTIFICATION_PREFERENCE_KEYS,
  type SocialSettingsResponse,
} from "@blast/core/modules/social/contracts/settings.ts";

import {
  applyPatch,
  COPY,
  isEmptyPatch,
  mergePatches,
  NOTIFICATION_ROWS,
  shortWallet,
  TOASTS,
  walletName,
  walletRows,
  walletSince,
} from "./settings-model.ts";

const SETTINGS: SocialSettingsResponse = {
  privacy: "public",
  sharing_since_ms: 1,
  commit_too_coin_type: null, blast_mode_confirm_actions: false,
  public_portfolio: false,
  explorer: "suiscan",
  sound: true,
  notifications: DEFAULT_NOTIFICATION_PREFERENCES,
};

test("UI-07: the eight notification rows, in the design's order and words, one per stored switch", () => {
  assert.deepEqual(NOTIFICATION_ROWS.map((row) => row.key), [...NOTIFICATION_PREFERENCE_KEYS]);
  assert.deepEqual(NOTIFICATION_ROWS.map((row) => row.title), [
    "Opens soon", "80% filled", "Last hour", "Funded", "Claims open", "Unlocks", "People you follow", "Up since your call",
  ]);
  assert.equal(COPY.privacyNote, "Onchain data is public. A private account can still appear by wallet address in big-move posts, without your name.");
});

test("UI-07: wallet linking and failure feedback retain their copy", () => {
  assert.equal(TOASTS.linked("Slush"), "Slush wallet linked");
  assert.equal(TOASTS.copied, "Address copied");
  assert.equal(TOASTS.logOutFailed, "Sign-out did not finish. You are still signed in. Try again.");
});

test("UI-07: wallets are named, shortened, dated and ordered as the design lists them", () => {
  assert.equal(walletName("embedded"), "Blast wallet");
  assert.equal(walletName("slush"), "Slush");
  assert.equal(walletName("external"), "External wallet");
  const address = "0x3f9a8c21d04b7e91a2c5f6e8b3d0794c1e2a5b6f8d9c0e1f2a3b4c5d6e7b1c21d";
  // R3: one rule everywhere (the reference's `addrShort`), first 10 and last 8.
  assert.equal(shortWallet(address), "0x3f9a8c21…e7b1c21d");
  assert.equal(shortWallet("0x1"), "0x1");
  assert.equal(shortWallet("0x234567890abcdef12"), "0x234567890abcdef12");
  assert.equal(shortWallet("0x234567890abcdef123"), "0x23456789…bcdef123");
  const oct1 = Date.UTC(2026, 9, 1, 12);
  assert.equal(walletSince({ kind: "embedded", linked_at_ms: oct1 }, "UTC"), "Created Oct 1");
  assert.equal(walletSince({ kind: "slush", linked_at_ms: oct1 + 86_400_000 }, "UTC"), "Linked Oct 2");
  assert.equal(walletSince({ kind: "external", linked_at_ms: oct1 }, "UTC"), "Linked Oct 1");
  const rows = walletRows([
    { address: "0xb", kind: "slush", linked_at_ms: 1 },
    { address: "0xc", kind: "external", linked_at_ms: 3 },
    { address: "0xa", kind: "embedded", linked_at_ms: 5 },
    { address: "0xd", kind: "external", linked_at_ms: 2 },
  ]);
  assert.deepEqual(rows.map((wallet) => wallet.address), ["0xa", "0xb", "0xd", "0xc"]);
});

test("UI-07: patches merge (switches merge too), apply over the stored settings, and an empty one is nothing", () => {
  const merged = mergePatches(
    { private: true, notifications: { funded: false } },
    { explorer: "suivision", notifications: { unlocks: false, funded: true } },
  );
  assert.deepEqual(merged, { private: true, explorer: "suivision", notifications: { funded: true, unlocks: false } });
  const shown = applyPatch(SETTINGS, { ...merged, public_portfolio: true });
  assert.equal(shown.privacy, "private");
  assert.equal(shown.public_portfolio, true);
  assert.equal(shown.explorer, "suivision");
  assert.deepEqual(shown.notifications, { ...DEFAULT_NOTIFICATION_PREFERENCES, unlocks: false });
  assert.equal(applyPatch(SETTINGS, { private: false }).privacy, "public");
  assert.deepEqual(applyPatch(SETTINGS, {}), SETTINGS);
  assert.equal(isEmptyPatch({}), true);
  assert.equal(isEmptyPatch({ notifications: {} }), true);
  assert.equal(isEmptyPatch({ notifications: { funded: false } }), false);
  assert.equal(isEmptyPatch({ private: false }), false);
});

test("UI-07: the coin amounts the wallet card's rows use: qty", () => {
  assert.equal(qty(412.38), "412.38");
  assert.equal(qty(18_400), "18,400");
  assert.equal(qty(4_100_000), "4.1M");
  assert.equal(qty(1_200_000_000), "1.2B");
  assert.equal(qty(0.5), "0.5");
});
