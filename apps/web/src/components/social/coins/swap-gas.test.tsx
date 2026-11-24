import assert from "node:assert/strict";
import test from "node:test";
import { mountSwap } from "../../../../test/fixtures/social/coins/coins.test-support.tsx";
import { FIXTURE_COINS } from "../../../../test/fixtures/social/coins/coins-fixture-model.ts";
import { fixtureQuote } from "../../../../test/fixtures/social/coins/swap-fixture.ts";
import type { CoinSheetTrading } from "./SwapForm";

const TSUI = { ...FIXTURE_COINS[1]!, key: "tsui", symbol: "TSUI", coinType: "0x963331df9a26c8674c33eb97655fe44807d5ff1aa4092bcbe2bdbe044b17b03d::test_sui::TEST_SUI", atoms: 9949790000000000n };
const MESSAGE = "Blast can’t pay this trade’s network fee right now. Your wallet needs at least 0.002820419 native SUI. Add SUI and try again.";

function trading(trade: CoinSheetTrading["trade"]): CoinSheetTrading {
  return { signedIn: true, onSignIn: () => undefined, listCoins: async () => [], trade,
    requestQuote: async (request) => ({ status: "ok", httpStatus: 200, body: {
      ...fixtureQuote(request, [TSUI, ...FIXTURE_COINS], { quote: "ok", trade: "ok", signedIn: true, fee: "sponsored" }, Date.now()),
      in_coin: TSUI.coinType, quote_id: `quote-${request.amount_in}`, offer_refused: null,
    } }),
  };
}

test("zero native SUI fee refusal is a wrapping alert, never a payable button or Free summary", async (t) => {
  let submits = 0;
  const kit = trading(async () => { submits += 1; return { status: "fee_required", feeMist: "2350349", payable: false, message: MESSAGE }; });
  const screen = await mountSwap(t, kit, { inCoin: TSUI });
  await screen.type("100000"); await screen.settle();
  await screen.press();
  assert.equal(submits, 1);
  assert.equal(screen.trade().disabled, true);
  assert.equal(screen.trade().textContent, "Swap", "the button keeps its verb, off; the alert says what to add");
  assert.equal(screen.container.querySelector('[role="alert"]')?.textContent, MESSAGE);
  assert.doesNotMatch(screen.container.textContent!, /Free|Not enough TSUI/);
  await screen.act(async () => screen.trade().click());
  assert.equal(submits, 1);
  await screen.type("100001"); await screen.settle();
  assert.equal(screen.container.querySelector('[role="alert"]'), null, "editing starts a new amount, with no stale error or fee consent");
  assert.doesNotMatch(screen.trade().textContent!, /Pay/);
});

test("terminal failure stays disabled after the old error timer and quotes cannot retry it", async (t) => {
  let submits = 0;
  const screen = await mountSwap(t, trading(async () => { submits += 1; return { status: "failed", code: "insufficient_balance", message: MESSAGE }; }), { inCoin: TSUI });
  await screen.type("100000"); await screen.settle();
  await screen.press();
  await screen.act(async () => { await new Promise((resolve) => setTimeout(resolve, 3200)); });
  assert.equal(screen.trade().disabled, true);
  assert.equal(screen.container.querySelector('[role="alert"]')?.textContent, MESSAGE);
  assert.ok(screen.trade().textContent!.length < 40, "explanations stay out of the button");
  await screen.act(async () => screen.trade().click());
  assert.equal(submits, 1);
});

test("paying an affordable fee requires a second press with the same attempt key and matching summary", async (t) => {
  const asks: Parameters<CoinSheetTrading["trade"]>[0][] = [];
  const screen = await mountSwap(t, trading(async (ask) => { asks.push(ask); return asks.length === 1 ? { status: "fee_required", feeMist: "2350349" } : { status: "failed", code: "price_moved", message: "Price moved. Refresh the quote." }; }), { inCoin: TSUI });
  await screen.type("100000"); await screen.settle();
  await screen.press();
  assert.equal(screen.trade().textContent, "Swap", "the fee is the money sentence's; the button keeps its verb");
  assert.match(screen.container.querySelector('[id$="-cost"]')!.textContent!, /Network fee ≈ 0\.00235\u00a0SUI\./);
  assert.doesNotMatch(screen.container.textContent!, /Free/);
  assert.match(screen.container.textContent!, /Paid from your SUI/);
  await screen.press();
  assert.equal(asks[1]?.acceptFee, true);
  assert.equal(asks[1]?.idempotencyKey, asks[0]?.idempotencyKey);
});
