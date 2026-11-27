import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import type { Quote } from "@mayanfinance/swap-sdk";

import { guardQuote, quoteFacts, type BridgeRequest } from "./bridge-guard.ts";
import { CHAINS, DESTINATIONS, quoteRows } from "./bridge-model.ts";

// Live Mayan quotes captured 2026-11-26 with placeholder addresses.
const QUOTES = JSON.parse(readFileSync(new URL("../../../../test/fixtures/social/bridge/blink-quotes.json", import.meta.url), "utf8")) as Record<"baseUsdcToSui" | "solToSuiUsdc", Quote>;
const BLAST = `0x${"ab".repeat(32)}`;
const BEFORE_EXPIRY = Date.parse("2026-11-26T08:40:00Z");

const BASE_USDC: BridgeRequest = {
  chain: "base",
  token: CHAINS.base.tokens[1],
  to: DESTINATIONS[0]!,
  amountIn64: "20000000",
  blastAddress: BLAST,
  sourceAddress: `0x${"11".repeat(20)}`,
};
const SOLANA_SOL: BridgeRequest = {
  chain: "solana",
  token: CHAINS.solana.tokens[0],
  to: DESTINATIONS[1]!,
  amountIn64: "100000000",
  blastAddress: BLAST,
  sourceAddress: "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM",
};

function withOrder(quote: Quote, change: (order: Record<string, unknown>, crossChain: Record<string, unknown>) => void): Quote {
  const copy = structuredClone(quote) as Quote & { blinkQuote: { crossChain: Record<string, unknown> & { orderParams: Record<string, unknown> } } };
  change(copy.blinkQuote.crossChain.orderParams, copy.blinkQuote.crossChain);
  return copy;
}

function reason(quote: Quote, request: BridgeRequest, now = BEFORE_EXPIRY): string | null {
  const result = guardQuote(quote, request, now);
  return result.ok ? null : result.reason;
}

test("a matching Blink quote passes for an EVM token and for native SOL", () => {
  assert.equal(reason(QUOTES.baseUsdcToSui, BASE_USDC), null);
  assert.equal(reason(QUOTES.solToSuiUsdc, SOLANA_SOL), null);
  // Sui addresses compare in full form; EVM refund addresses ignore case.
  assert.equal(reason(QUOTES.baseUsdcToSui, { ...BASE_USDC, blastAddress: BLAST.toUpperCase().replace("0X", "0x"), sourceAddress: BASE_USDC.sourceAddress.toUpperCase().replace("0X", "0x") }), null);
});

test("the guard refuses every quote that is not exactly what was asked", () => {
  const base = QUOTES.baseUsdcToSui;
  assert.equal(reason({ ...base, type: "SWIFT" }, BASE_USDC), "not a Blink quote");
  assert.equal(reason({ ...base, blinkQuote: undefined }, BASE_USDC), "no Blink order");
  assert.equal(reason(withOrder(base, (_, crossChain) => delete crossChain.quoteHash), BASE_USDC), "no Blink order");
  assert.equal(reason({ ...base, gasless: true }, BASE_USDC), "gasless order");
  assert.equal(reason(base, { ...BASE_USDC, chain: "arbitrum" }), "wrong chains");
  assert.equal(reason(base, { ...BASE_USDC, token: CHAINS.base.tokens[0] }), "wrong source token");
  assert.equal(reason(base, { ...BASE_USDC, amountIn64: "20000001" }), "wrong amount");
  assert.equal(reason(base, { ...BASE_USDC, to: DESTINATIONS[1]! }), "wrong destination coin");
  assert.equal(reason(base, { ...BASE_USDC, blastAddress: `0x${"cd".repeat(32)}` }), "wrong recipient");
  assert.equal(reason(withOrder(base, (order) => (order.recipient = `0x${"cd".repeat(32)}`)), BASE_USDC), "wrong recipient");
  assert.equal(reason(base, { ...BASE_USDC, sourceAddress: `0x${"22".repeat(20)}` }), "wrong refund address");
  assert.equal(reason(withOrder(base, (order) => (order.referrers = [{ address: `0x${"33".repeat(20)}`, bps: 50 }])), BASE_USDC), "unexpected referrer");
  assert.equal(reason(base, BASE_USDC, Date.parse("2026-11-26T08:41:42.863Z")), "expired");
  // Solana addresses are case-sensitive base58.
  assert.equal(reason(QUOTES.solToSuiUsdc, { ...SOLANA_SOL, sourceAddress: SOLANA_SOL.sourceAddress.toLowerCase() }), "wrong refund address");
});

test("wallet approvals cannot use a different token or amount from the embedded order", () => {
  const base = QUOTES.baseUsdcToSui;
  assert.equal(reason({ ...base, fromToken: { ...base.fromToken, contract: `0x${"22".repeat(20)}` } }, BASE_USDC), "wrong source token");
  assert.equal(reason({ ...base, effectiveAmountIn64: "20000001" }, BASE_USDC), "wrong amount");
  assert.equal(reason(withOrder(base, (params) => { params.expectedAmountIn = "20000001"; }), BASE_USDC), "wrong amount");
  assert.equal(reason({ ...base, fromChain: "ethereum" }, BASE_USDC), "wrong chains");
});

test("quote facts feed the rows: amount out, floor, fee, time", () => {
  const usdc = CHAINS.base.tokens[1];
  assert.deepEqual(quoteRows(quoteFacts(QUOTES.baseUsdcToSui, usdc), usdc, DESTINATIONS[0]!), {
    amount: "29.8142",
    minimum: "29.3968\u00a0SUI",
    fee: "$0.03",
    eta: "About 10\u00a0s",
  });
});
