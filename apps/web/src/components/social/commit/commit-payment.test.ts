import { createTestQueryClient } from "#web/lib/query/test-client.ts";
import assert from "node:assert/strict";
import test from "node:test";

import type { SocialTradeQuote, SocialTradeQuoteRequest } from "@blast/core/modules/social/contracts/trades.ts";
import { QUICK_COMMIT_MAX_IMPACT_BPS, type CommitInput } from "@blast/core/modules/social/commit/quote.ts";
import { STORY_NOW, TIDE, tideFacts } from "../../../../test/fixtures/social/commit/commit-fixtures.ts";
import { FIXTURE_SUI, FIXTURE_USDC, fixtureTradeQuote, fixtureWallet } from "../../../../test/fixtures/social/trade/trade-fixtures.ts";
import { walletCoinViews } from "../coins/coin-model";
import type { CommitBlastInput } from "./CommitPanel";
import type { CommitKit } from "./commit-kit";
import { createCommitQuotes } from "./commit-quote";
import { HOLD_COIN_PRICE_OFF, HOLD_VALUE_UNKNOWN, quickAvailableUsd } from "./commit-input";
import { paymentPreview, prepareCommitPayment } from "./commit-payment";
import { commitSaleOf, commitViewerOf } from "./commit-view";
import { judgeHeldBlast, sendHeldBlast } from "./use-held-blast";

// A wallet with no USDC and 80 SUI at $2.
const wallet = fixtureWallet("sponsored", { usdc: 0n, kstl: 0n, lumn: 0n });
const facts = {
  ...tideFacts({ viewer: { usdc: 0, sui: 80, suiUsd: 2 } }),
  wallet: { ...wallet, coins: wallet.coins!.map((coin) => coin.coin_type === FIXTURE_SUI ? { ...coin, atoms: "80000000000", usd_price: "2" } : coin) },
};
const sui = walletCoinViews(facts.wallet).find((coin) => coin.coinType === FIXTURE_SUI)!;
const input: CommitInput = { sale: TIDE, viewer: facts.viewer, payWith: "SUI", typed: "50", why: "  thesis  ", whyError: null, blockers: [], nowMs: STORY_NOW };
const quoteFor = (request: SocialTradeQuoteRequest): SocialTradeQuote => ({
  ...fixtureTradeQuote(request, { signedIn: true, wallet: fixtureWallet("sponsored", { usdc: 0n }), nowMs: STORY_NOW }),
  amount_out: "99500000", min_out: "99123456",
});

test("held Blast pays with the Settings coin: one atomic swap-and-USDC-purchase order", async () => {
  const sent: CommitBlastInput[] = [];
  const requests: SocialTradeQuoteRequest[] = [];
  const kit: Pick<CommitKit, "quotes" | "send" | "quotePayment" | "holdCoin"> = {
    quotes: createCommitQuotes({ client: createTestQueryClient(), read: async () => facts }),
    holdCoin: { peek: () => FIXTURE_SUI, read: async () => FIXTURE_SUI },
    quotePayment: async (request) => { requests.push(request); return { status: "ok", body: quoteFor(request), httpStatus: 200 }; },
    send: async (_facts, order, options) => {
      sent.push(order);
      assert.deepEqual(options?.source, { entryId: "post", through: "Mira" });
      return { status: "sent", digest: "atomic" };
    },
  };
  try {
    const judged = await judgeHeldBlast(kit, TIDE.presaleId, 100, STORY_NOW);
    assert.ok(!("refusal" in judged));
    await sendHeldBlast(kit, judged, { entryId: "post", through: "Mira" });
    assert.equal(requests.length, 1);
    assert.equal(requests[0]!.amount_in, "50000000000");
    assert.deepEqual(sent, [{ payWith: "USDC", pay: 50, usd: 99.12, quote: 99.123456, why: "", swapQuoteId: "q1.fixture_quote_sell_50000000000", quoteAtoms: "99123456", paymentSymbol: "SUI" }]);
    // The wallet's SUI price is half the route's: a $50 hold would commit $99.12.
    assert.deepEqual(await judgeHeldBlast(kit, TIDE.presaleId, 50, STORY_NOW), { refusal: HOLD_COIN_PRICE_OFF });
  } finally {
    kit.quotes.dispose();
  }
});

test("a held swap worth less than asked by more than the route's costs plus the cap is refused", async () => {
  // Costs 100 + 100 + 50 + 50 bps, plus the 300 bps cap: a $100 hold must commit at least $94.
  const kitAt = (minOut: string) => ({
    quotes: createCommitQuotes({ client: createTestQueryClient(), read: async () => facts }),
    holdCoin: { peek: () => FIXTURE_SUI, read: async () => FIXTURE_SUI },
    quotePayment: (async (request) => ({ status: "ok", httpStatus: 200, body: { ...quoteFor(request), price_impact_bps: 100, fee_bps: 100, blast_fee_bps: 50, slippage_bps: 50, min_out: minOut } })) satisfies CommitKit["quotePayment"],
  });
  const [inside, outside] = [kitAt("94010000"), kitAt("93990000")];
  try {
    assert.ok(!("refusal" in await judgeHeldBlast(inside, TIDE.presaleId, 100, STORY_NOW)));
    assert.deepEqual(await judgeHeldBlast(outside, TIDE.presaleId, 100, STORY_NOW), { refusal: HOLD_COIN_PRICE_OFF });
  } finally {
    inside.quotes.dispose();
    outside.quotes.dispose();
  }
});

test("any held coin can pay into a sale quoted in a coin with no dollar rate: the swap's output is the commitment", async () => {
  const sale = { ...TIDE, quoteCoin: "LOFI", quoteType: `0x${"b".repeat(64)}::lofi::LOFI`, quoteDecimals: 9, minCommitment: null, walletCap: null };
  const read: CommitKit["quotePayment"] = async (request) => ({ status: "ok", httpStatus: 200, body: quoteFor(request) });
  const prepared = await prepareCommitPayment({ ...input, sale }, sui, read, () => STORY_NOW);
  assert.ok("order" in prepared, JSON.stringify(prepared));
  assert.deepEqual([prepared.order.payWith, prepared.order.quoteAtoms, prepared.order.paymentSymbol], ["LOFI", "99123456", "SUI"]);
  // A hold has no confirm screen: with no dollar value to check, it refuses.
  const kit = { quotes: createCommitQuotes({ client: createTestQueryClient(), read: async () => ({ ...facts, sale }) }), holdCoin: { peek: () => FIXTURE_SUI, read: async () => FIXTURE_SUI }, quotePayment: (async (request) => ({ status: "ok", httpStatus: 200, body: { ...quoteFor(request), price_impact_bps: 10 } })) satisfies CommitKit["quotePayment"] };
  try {
    assert.deepEqual(await judgeHeldBlast(kit, TIDE.presaleId, 50, STORY_NOW), { refusal: HOLD_VALUE_UNKNOWN });
  } finally {
    kit.quotes.dispose();
  }
});

test("a held swap rechecks the indexed price when the swap quote returns", async () => {
  const quoteType = `0x${"b".repeat(64)}::lofi::LOFI`;
  const detail = {
    ...facts.detail,
    presale: { ...facts.detail.presale, quote_type: quoteType, quote_symbol: "LOFI", phase: "open" as const, end_ms: TIDE.endMs },
    quote_price: { usd_price: "0.50", as_of_ms: STORY_NOW - 119_000 },
  };
  const sale = commitSaleOf(detail, { suiUsd: 2 }, STORY_NOW);
  const viewer = commitViewerOf({ wallet: facts.wallet, sale, entry: null, allowlist: null });
  const quotes = createCommitQuotes({ client: createTestQueryClient(), read: async () => ({ ...facts, detail, sale, viewer }) });
  const holdCoin = { peek: () => FIXTURE_SUI, read: async () => FIXTURE_SUI };
  let now = STORY_NOW;
  const quotePayment: CommitKit["quotePayment"] = async (request) => {
    now += 2_000;
    return { status: "ok", body: { ...quoteFor(request), price_impact_bps: 10, min_out: "199000000" }, httpStatus: 200 };
  };
  try {
    const result = await judgeHeldBlast({ quotes, holdCoin, quotePayment }, TIDE.presaleId, 100, () => now);
    assert.equal("refusal" in result ? result.refusal : null, HOLD_VALUE_UNKNOWN);
  } finally {
    quotes.dispose();
  }
});

test("routed payments reject stale quotes, changed pairs or amounts, and unavailable routes", async () => {
  let calls = 0;
  const read: CommitKit["quotePayment"] = async (request) => { calls += 1; return { status: "ok", httpStatus: 200, body: quoteFor(request) }; };
  const prepared = await prepareCommitPayment(input, sui, read, () => STORY_NOW);
  assert.ok(!("refusal" in prepared));
  const quote = quoteFor({ in_coin: FIXTURE_SUI, out_coin: FIXTURE_USDC, side: "sell", amount_in: "50000000000" });
  for (const altered of [
    { ...quote, expires_at_ms: STORY_NOW },
    { ...quote, in_coin: quote.out_coin },
    { ...quote, out_coin: quote.in_coin },
    { ...quote, amount_in: "49000000000" },
    { ...quote, side: "buy" as const },
    { ...quote, slippage_bps: 500 },
    { ...quote, quote_id: null, unavailable_reason: "no_pool" as const },
  ]) {
    const result = await prepareCommitPayment(input, sui, read, () => STORY_NOW, altered);
    assert.ok("refusal" in result);
  }
  assert.equal(calls, 1, "a shown quote is validated without silently replacing it");
});

test("the guaranteed output enforces the minimum, remaining cap and allowlist", async () => {
  const read: CommitKit["quotePayment"] = async (request) => ({ status: "ok", httpStatus: 200, body: quoteFor(request) });
  for (const changed of [
    { ...input, sale: { ...TIDE, minCommitment: 100 } },
    { ...input, viewer: { ...input.viewer, committed: 19_950 } },
    { ...input, sale: { ...TIDE, allowlisted: true }, viewer: { ...input.viewer, allowlist: { on: true, cap: 50 } } },
    { ...input, sale: { ...TIDE, allowlisted: true }, viewer: { ...input.viewer, allowlist: { on: false, cap: null } } },
  ]) assert.ok("refusal" in await prepareCommitPayment(changed, sui, read, () => STORY_NOW));
  assert.deepEqual(await prepareCommitPayment(input, { ...sui, atoms: 49_000_000_000n }, read, () => STORY_NOW), { refusal: "Not enough to cover it" });
  const quote = quoteFor({ in_coin: FIXTURE_SUI, out_coin: FIXTURE_USDC, side: "sell", amount_in: "50000000000" });
  assert.equal(paymentPreview(input, sui, quote, STORY_NOW).typed, "99.123456");
});

test("a sale closing while the router answers refuses; a failed quote sends nothing", async () => {
  let now = STORY_NOW;
  const closed = await prepareCommitPayment(input, sui, async (request) => {
    now = TIDE.endMs;
    return { status: "ok", httpStatus: 200, body: { ...quoteFor(request), expires_at_ms: now + 20_000 } };
  }, () => now);
  assert.deepEqual(closed, { refusal: "Tidal isn't taking commitments" });
  const failed = await prepareCommitPayment(input, sui, async () => { throw new Error("offline"); }, () => STORY_NOW);
  assert.ok("refusal" in failed);
});

test("a hold's ladder is bounded by its one coin, never a combined balance", () => {
  assert.equal(quickAvailableUsd(facts, FIXTURE_SUI), 160);
  assert.equal(quickAvailableUsd({ ...facts, viewer: { ...facts.viewer, usdc: 100 } }, null), 100, "the sale's own coin");
});

test("a commit with no confirm screen refuses a swap that moves the price too much, or by an unknown amount", async () => {
  const quoted = (impact: number | null): CommitKit["quotePayment"] => async (request) => ({ status: "ok", httpStatus: 200, body: { ...quoteFor(request), price_impact_bps: impact } });
  assert.equal(QUICK_COMMIT_MAX_IMPACT_BPS, 300, "the hold's cap is 3%");
  assert.ok(!("refusal" in await prepareCommitPayment(input, sui, quoted(300), () => STORY_NOW, null, QUICK_COMMIT_MAX_IMPACT_BPS)));
  assert.deepEqual(await prepareCommitPayment(input, sui, quoted(301), () => STORY_NOW, null, QUICK_COMMIT_MAX_IMPACT_BPS), { refusal: "This swap moves the price more than 3%. Use the commit window to see the route." });
  assert.deepEqual(await prepareCommitPayment(input, sui, quoted(null), () => STORY_NOW, null, QUICK_COMMIT_MAX_IMPACT_BPS), { refusal: "This swap’s price impact is unknown. Use the commit window to see the route." });
  assert.ok(!("refusal" in await prepareCommitPayment(input, sui, quoted(900), () => STORY_NOW)), "the commit window shows the route and lets the person decide");
});
