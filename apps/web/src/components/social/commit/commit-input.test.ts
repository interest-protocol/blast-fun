import assert from "node:assert/strict";
import test from "node:test";

import { KAI, STORY_NOW, TIDE, tideFacts } from "../../../../test/fixtures/social/commit/commit-fixtures.ts";
import { FIXTURE_SUI, fixtureWallet } from "../../../../test/fixtures/social/trade/trade-fixtures.ts";
import { commitErrorText, HOLD_COIN_NO_PRICE, HOLD_COIN_NOT_HELD, quickInput } from "./commit-input";
import { walletCoinViews } from "../coins/coin-model";

test("a hold with no coin chosen pays the sale's own coin, sized in dollars, with no why", () => {
  const quick = quickInput(tideFacts(), 100, STORY_NOW, null);
  assert.ok(quick && "input" in quick);
  assert.deepEqual([quick.input.payWith, quick.input.typed, quick.input.why, quick.input.whyError], ["USDC", "100", "", null]);
});

test("a hold pays only the coin chosen in Settings: sized at its price, refused when not held or not priced", () => {
  const wallet = fixtureWallet();
  const facts = { ...tideFacts(), wallet };
  const quick = quickInput(facts, 342, STORY_NOW, FIXTURE_SUI);
  assert.ok(quick && "input" in quick);
  assert.deepEqual([quick.coin.coinType, quick.input.payWith, quick.input.typed], [FIXTURE_SUI, "SUI", "100"]);
  assert.deepEqual(quickInput(facts, 50, STORY_NOW, `0x${"c".repeat(64)}::coin::COIN`), { refusal: HOLD_COIN_NOT_HELD });
  for (const unread of [null, { ...wallet, coins: null }]) assert.equal(quickInput({ ...facts, wallet: unread }, 50, STORY_NOW, FIXTURE_SUI), null, "a failed wallet read is unreadable, not a coin it doesn't hold");
  const unpriced = { ...facts, wallet: { ...wallet, coins: wallet.coins!.map((coin) => coin.coin_type === FIXTURE_SUI ? { ...coin, usd_price: null } : coin) } };
  assert.deepEqual(quickInput(unpriced, 50, STORY_NOW, FIXTURE_SUI), { refusal: HOLD_COIN_NO_PRICE });
});

test("a refusal found at the press is the gate's own sentence, verbatim (AC-10)", () => {
  const input = { sale: { ...TIDE, presalePrice: 0.0005 }, viewer: KAI, payWith: "USDC", typed: "250", why: "", whyError: null, blockers: [], nowMs: STORY_NOW } as const;
  assert.equal(commitErrorText("closed", input), "Tidal isn't taking commitments");
  assert.equal(commitErrorText("min", input), "The minimum is $10");
  assert.equal(commitErrorText("cap", input), "The most one wallet can put in is $20,000");
  assert.equal(commitErrorText("insufficient", input), "Not enough to cover it");
  assert.equal(commitErrorText("blocked", input), "That didn’t go through");
  assert.equal(commitErrorText("unreadable", null), "That didn’t go through");
});

test("a held payment can use a positive exact balance with public metadata alone", () => {
  const wallet = fixtureWallet();
  const sui = walletCoinViews(wallet).find((coin) => coin.coinType === FIXTURE_SUI)!;
  const exact = 1_000_000_000_000n;
  const facts = { ...tideFacts(), wallet: { ...wallet, coins: null } };
  const funded = quickInput(facts, 50, STORY_NOW, sui.coinType, exact, { ...sui, atoms: 0n, amount: 0 });
  assert.ok(funded && "coin" in funded);
  assert.equal(funded.coin.atoms, exact);
  assert.deepEqual(quickInput(facts, 50, STORY_NOW, sui.coinType, exact), { refusal: HOLD_COIN_NO_PRICE });
  assert.deepEqual(quickInput(facts, 50, STORY_NOW, sui.coinType, 0n, sui), { refusal: HOLD_COIN_NOT_HELD });
});
