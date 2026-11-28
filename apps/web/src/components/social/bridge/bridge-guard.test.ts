import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { addresses, type Quote } from "@mayanfinance/swap-sdk";

import { assertSendTarget, checkQuote, guardQuote, pickRoute, quoteFacts, type BridgeRequest } from "./bridge-guard.ts";
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
  assert.equal(reason({ ...base, type: "SWIFT" }, BASE_USDC), "unsupported route");
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

test("a bound quote must protect the minimum shown and expire in the future", () => {
  const base = QUOTES.baseUsdcToSui;
  const smaller = withOrder(base, (params) => { params.minAmountOut = String(BigInt(base.minReceivedBaseUnits) - 1n); });
  assert.equal(reason(smaller, BASE_USDC), "wrong minimum output");
  assert.equal(reason({ ...base, minReceived: base.minReceived + 1 }, BASE_USDC), "wrong minimum output");
  assert.equal(reason({ ...base, minReceivedBaseUnits: "invalid" }, BASE_USDC), "wrong minimum output");
  const subAtom = withOrder({ ...QUOTES.solToSuiUsdc, minReceived: 0.0000001, minReceivedBaseUnits: "0" }, (params) => { params.minAmountOut = "0"; });
  assert.equal(reason(subAtom, SOLANA_SOL), "wrong minimum output");
  assert.equal(reason(withOrder(base, (_params, order) => { order.expiresAt = "unknown"; }), BASE_USDC), "unreadable Blink order");
  assert.equal(reason(base, BASE_USDC, BEFORE_EXPIRY + 24 * 60 * 60 * 1000), "expired");
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

/** Live Mayan answers captured 2026-11-28 with the same placeholders: Fast MCTP, then MCTP. */
const live = (pair: string) => JSON.parse(readFileSync(new URL(`../../../../test/fixtures/social/bridge/all-routes-${pair}.json`, import.meta.url), "utf8")) as [Quote, Quote];
const LIVE_NOW = Date.parse("2026-11-28T11:10:00Z");

test("Fast MCTP is picked first, then MCTP, then Blink, and each works alone", () => {
  const [fast, mctp] = live("base-usdc-sui");
  const blink = QUOTES.baseUsdcToSui;
  assert.equal(pickRoute([blink, mctp, fast], BASE_USDC, LIVE_NOW)?.type, "FAST_MCTP");
  assert.equal(pickRoute([blink, mctp], BASE_USDC, LIVE_NOW)?.type, "MCTP");
  assert.equal(pickRoute([blink], BASE_USDC, LIVE_NOW)?.type, "BLINK");
  assert.equal(pickRoute([{ ...fast, type: "SWIFT" }], BASE_USDC, LIVE_NOW), undefined);
  // A route that fails a check gives way to the next one.
  assert.equal(pickRoute([{ ...fast, effectiveAmountIn64: "1" }, mctp], BASE_USDC, LIVE_NOW)?.type, "MCTP");
});

test("the same checks pass two chains and two coins with no per-coin code", () => {
  const ethAsk: BridgeRequest = { ...BASE_USDC, token: CHAINS.base.tokens[0], amountIn64: "10000000000000000" };
  for (const [pair, ask] of [["base-eth-sui", ethAsk], ["solana-sol-usdc", SOLANA_SOL]] as const) {
    for (const quote of live(pair)) assert.equal(reason(quote, ask, LIVE_NOW), null, `${pair} ${quote.type}`);
  }
});

test("an MCTP quote is refused when it is not what was asked", () => {
  const [fast] = live("base-usdc-sui");
  const refusal = (change: Partial<Quote>, ask = BASE_USDC) => reason({ ...fast, ...change }, ask, LIVE_NOW);
  assert.equal(refusal({ toChain: "base" }), "wrong chains");
  assert.equal(refusal({}, { ...BASE_USDC, token: CHAINS.base.tokens[0] }), "wrong source token");
  assert.equal(refusal({}, { ...BASE_USDC, amountIn64: "20000001" }), "wrong amount");
  assert.equal(refusal({}, { ...BASE_USDC, to: DESTINATIONS[1]! }), "wrong destination coin");
  assert.equal(refusal({ referrerBps: 5 }), "unexpected referrer");
  assert.equal(refusal({ gasDrop: 1 }), "unexpected gas drop");
  assert.equal(refusal({ gasless: true }), "gasless order");
  assert.equal(refusal({ bridgeFee: 0.001 }), "unexpected bridge fee");
  assert.equal(refusal({ minReceived: 0 }), "wrong minimum output");
  assert.equal(refusal({ minReceived: fast.expectedAmountOut + 1 }), "wrong minimum output");
  assert.equal(refusal({ slippageBps: 501 }), "wrong slippage");
  assert.equal(refusal({ deadline64: String(LIVE_NOW / 1000) }), "expired");
  assert.equal(refusal({ deadline64: String(LIVE_NOW / 1000 + 60) }), "expired", "no time left to sign");
  assert.equal(refusal({ deadline64: String(LIVE_NOW / 1000 + 61) }), null);
  for (const blastAddress of ["", "0x0", "not an address"]) assert.equal(refusal({}, { ...BASE_USDC, blastAddress }), "wrong recipient", blastAddress);
  // The card prices a quote before there is a Blast address.
  assert.deepEqual(checkQuote(fast, BASE_USDC, LIVE_NOW), { ok: true });
});

test("an auction order must sign the chosen coin's own id", () => {
  const other = `0x${"22".repeat(32)}`;
  const [fast, mctp] = live("base-usdc-sui");
  for (const [quote, signed] of [[fast, "currencyId"], [mctp, "verifiedAddress"]] as const) {
    assert.equal(quote.hasAuction, true);
    for (const id of [other, undefined]) {
      assert.equal(reason({ ...quote, toToken: { ...quote.toToken, [signed]: id } } as Quote, BASE_USDC, LIVE_NOW), "wrong destination coin", `${quote.type} ${id}`);
    }
  }
});

test("the fee adds Mayan's three parts, and a missing part shows no figure", () => {
  const usdc = CHAINS.base.tokens[1];
  const [direct] = live("base-usdc-usdc");
  // A direct USDC bridge loses only the fee: what is sent less what is expected.
  assert.ok(Math.abs(quoteFacts(direct, usdc).fee! - (20 - direct.expectedAmountOut)) <= 0.000002);
  const [swap] = live("base-eth-sui");
  assert.ok(Math.abs(quoteFacts(swap, CHAINS.base.tokens[0]).fee! - 0.039379) < 0.000001);
  for (const missing of ["clientRelayerFeeSuccess", "protocolFeeUsd", "circleMaxFee64"]) {
    assert.equal(quoteFacts({ ...direct, [missing]: undefined } as Quote, usdc).fee, null, missing);
  }
  assert.equal(quoteRows(quoteFacts(direct, usdc), usdc, DESTINATIONS[1]!).fee, "$0.02");
});

test("what the SDK signs must cover the minimum the card shows", () => {
  const unsigned = "unsigned minimum output";
  // An auction order signs its own minimum.
  const [auction] = live("base-eth-sui");
  const ethAsk: BridgeRequest = { ...BASE_USDC, token: CHAINS.base.tokens[0], amountIn64: "10000000000000000" };
  assert.equal(reason({ ...auction, minAmountOut: auction.minReceived - 0.000001 }, ethAsk, LIVE_NOW), unsigned);
  // Without an auction, only USDC arrives: what is bridged less the signed fees.
  assert.equal(reason({ ...auction, hasAuction: false }, ethAsk, LIVE_NOW), unsigned);
  const [direct] = live("base-usdc-usdc");
  const ask: BridgeRequest = { ...BASE_USDC, to: DESTINATIONS[1]! };
  assert.equal(direct.hasAuction, false);
  assert.equal(reason(direct, ask, LIVE_NOW), null);
  for (const change of [{ redeemRelayerFee: 1 }, { redeemRelayerFee64: "1000000" }, { circleMaxFee64: "1000000" }]) {
    assert.equal(reason({ ...direct, ...change }, ask, LIVE_NOW), unsigned, Object.keys(change)[0]);
  }
  // A swap into the route's input coin counts only the swap's signed floor.
  const swapped = { ...direct, fastMctpInputContract: `0x${"22".repeat(20)}` };
  assert.equal(reason({ ...swapped, minMiddleAmount: undefined }, ask, LIVE_NOW), unsigned);
  assert.equal(reason({ ...swapped, minMiddleAmount: direct.minReceived }, ask, LIVE_NOW), unsigned);
  assert.equal(reason({ ...swapped, minMiddleAmount: 20 }, ask, LIVE_NOW), null);
});

test("an EVM send of an MCTP route goes only to Mayan's Forwarder", () => {
  const other = `0x${"22".repeat(20)}`;
  for (const quote of live("base-usdc-sui")) {
    assertSendTarget(quote, addresses.MAYAN_FORWARDER_CONTRACT);
    assert.throws(() => assertSendTarget(quote, other), /Unexpected (FAST_)?MCTP contract/);
    assert.throws(() => assertSendTarget(quote, null), /Unexpected (FAST_)?MCTP contract/);
  }
  assertSendTarget(QUOTES.baseUsdcToSui, other);
});
