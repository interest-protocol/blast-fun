import { tradeRequestKey, type TradeQuoteSnapshot } from "#web/components/social/trade/trade-quotes.ts";
import { mountSwap } from "../../../../test/fixtures/social/coins/coins.test-support.tsx";
import assert from "node:assert/strict";
import test from "node:test";

import { SALE_B } from "../../../../../../packages/server/test/fixtures/modules/social/trades/fixtures.ts";

import type { WalletCoinView } from "./coin-model";
import { amtExact } from "@blast/core/web/exact-amount.ts";
import { atomsValue } from "@blast/core/web/format.ts";
import { FIXTURE_COINS } from "../../../../test/fixtures/social/coins/coins-fixture-model.ts";
import { swapCta, swapPanels, swapQuoteRequest, txRows, txSummary, usdText } from "./swap-model";
import { recordedQuotes, RECORDED_BEE } from "../../../../test/fixtures/social/coins/swap-recorded.ts";

/**
 * Social feed R3-33-AC-1, AC-5, AC-7 against R3-30's **recorded mainnet
 * responses**: the real quote service over the Cetus aggregator's recorded
 * answers and mainnet's recorded dry runs (no network). Every figure the swap
 * shows is the response's own, after formatting only.
 */

const [, SUI] = FIXTURE_COINS as [WalletCoinView, WalletCoinView];
const USDC = FIXTURE_COINS[0]!;
const answered = (quote: Awaited<ReturnType<typeof recordedQuotes>>["embedded"], inCoin: WalletCoinView, outCoin: WalletCoinView): TradeQuoteSnapshot => ({
  key: tradeRequestKey(swapQuoteRequest(inCoin, outCoin, BigInt(quote.amount_in ?? "0"))),
  quote,
  shown: quote,
  loading: false,
  error: null,
});

test("R3-33-AC-1: 0.1 SUI → BEE, every figure on screen is the recorded response's after formatting", async () => {
  const { embedded } = await recordedQuotes();
  assert.equal(embedded.route_label, "SUI → BEE · Cetus");
  const snapshot = answered(embedded, SUI, RECORDED_BEE);
  const panels = swapPanels({ inCoin: SUI, outCoin: RECORDED_BEE, snapshot, hidden: false });
  assert.equal(panels.out.text, amtExact({ n: BigInt(embedded.amount_out!), scale: 9 }));
  assert.equal(panels.out.text, "332,001,975", "332,001,975.262684891\u00a0BEE, whole units from 10,000");
  assert.equal(panels.inUsd, `≈ ${usdText(embedded.amount_in_usd)}`);
  assert.equal(panels.inUsd, "≈ $0.12");
  assert.equal(panels.outUsd, `≈ ${usdText(embedded.amount_out_usd)}`);
  const summary = txSummary({ inCoin: SUI, outCoin: RECORDED_BEE, quote: embedded, walletFee: "sponsored" });
  // Owner (2026-10-06): the gate's line at the response's own exact rate — 332,001,975.262684891 BEE for 0.1 SUI.
  assert.equal(summary.price, "1\u00a0SUI = 3,320,019,752\u00a0BEE");
  assert.equal(summary.gas, "Free");
  const rows = txRows({ outCoin: RECORDED_BEE, quote: embedded, walletFee: "sponsored" });
  assert.deepEqual(rows.map((row) => [row.label, row.value, row.tone]), [
    // OA-29: mainnet's two dry runs of the same route measure 8,233 bp — red above 10%.
    ["Price impact", "82.33%", "down"],
    ["Max slippage", "Auto · 0.5%", null],
    ["Network fee", "Paid by Blast", null],
    ["Route", "SUI → BEE · Cetus", null],
  ]);
  assert.equal(amtExact({ n: BigInt(embedded.min_out!), scale: 9 }), "330,341,965");
  const cta = swapCta({ signedIn: true, inCoin: SUI, outCoin: RECORDED_BEE, atoms: 100_000_000n, snapshot, nowMs: embedded.quoted_at_ms, busy: false, failed: false });
  assert.deepEqual(cta, { label: "Swap", enabled: true, action: "trade", busy: false });
  // No float anywhere: the amount the screen writes is the atoms' own digits.
  assert.equal(Math.floor(atomsValue(embedded.amount_out!, 9)!).toLocaleString("en-US"), "332,001,975");
});

test("R3-33-AC-7: the same route for a wallet session reads `Paid by Blast` (owner ruling 2026-11-20), and a visitor's is priced but signs in", async () => {
  const { session, visitor } = await recordedQuotes();
  assert.equal(txRows({ outCoin: RECORDED_BEE, quote: session, walletFee: "sponsored" })[2]!.value, "Paid by Blast");
  assert.equal(txSummary({ inCoin: SUI, outCoin: RECORDED_BEE, quote: session, walletFee: "sponsored" }).gas, "Free");
  assert.equal(visitor.network_fee, null);
  assert.equal(visitor.offer_refused, "sign_in");
  const snapshot = answered(visitor, SUI, RECORDED_BEE);
  assert.equal(swapPanels({ inCoin: SUI, outCoin: RECORDED_BEE, snapshot, hidden: false }).out.text, "332,001,975", "a visitor sees the price");
  assert.equal(txRows({ outCoin: RECORDED_BEE, quote: visitor, walletFee: "sponsored" })[0]!.value, "—", "no dry run, no impact (OA-29 no_dry_run)");
  assert.equal(swapCta({ signedIn: true, inCoin: SUI, outCoin: RECORDED_BEE, atoms: 100_000_000n, snapshot, nowMs: visitor.quoted_at_ms, busy: false, failed: false }).label, "Sign in");
});

test("R3-33-AC-5: a pair no pool reaches shows the quote's unavailable line, no number, and the button off", async () => {
  const { noRoute, threeLegs } = await recordedQuotes();
  assert.equal(noRoute.unavailable_reason, "no_pool");
  const aye = { ...RECORDED_BEE, key: "aye", coinType: noRoute.out_coin, symbol: "AYE" };
  const snapshot = answered(noRoute, SUI, aye);
  assert.deepEqual(swapPanels({ inCoin: SUI, outCoin: aye, snapshot, hidden: false }).out, { text: "—", muted: true, pending: false });
  assert.deepEqual(txRows({ outCoin: aye, quote: noRoute, walletFee: "sponsored" }).map((row) => row.value), ["—", "Auto · 0.5%", "Paid by Blast", "—"]);
  assert.deepEqual(swapCta({ signedIn: true, inCoin: SUI, outCoin: aye, atoms: 100_000_000n, snapshot, nowMs: 0, busy: false, failed: false }), {
    label: "Swap", enabled: false, action: null, busy: false, reason: "No market for this trade yet. Choose a different token.",
  });
  // The recorded three-leg route keeps its own string.
  assert.equal(txRows({ outCoin: RECORDED_BEE, quote: threeLegs, walletFee: "sponsored" })[3]!.value, "USDC → SUI → BEE · Sui pools and Cetus");
});

test("the trade screen reads and renders a recorded quote through its requester", async (t) => {
  const { embedded } = await recordedQuotes();
  const screen = await mountSwap(t, {
    signedIn: true, onSignIn: () => undefined, listCoins: async () => [],
    requestQuote: async () => ({ status: "ok", body: { ...embedded, quoted_at_ms: Date.now(), expires_at_ms: Date.now() + 20_000 }, httpStatus: 200 }),
    trade: async () => ({ status: "traded" }),
  }, { outCoin: RECORDED_BEE });
  await screen.type("0.1"); await screen.settle();
  assert.equal(SALE_B, RECORDED_BEE.coinType);
  assert.match(screen.trade().textContent!, /^Swap$/);
  assert.equal(screen.trade().disabled, false);
  // The sentence above the button says the minimum and the fee; the detail keeps the impact.
  assert.match(screen.container.textContent!, /Sell 0\.1\u00a0SUI for at least 330,341,965\u00a0BEE\. Blast fee 0%\./);
  const detail = screen.container.querySelector<HTMLButtonElement>(".txSum")!;
  await screen.act(async () => detail.click());
  assert.match(screen.container.textContent!, /82.33%/);
  assert.ok(USDC);
});
