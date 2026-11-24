import type { TradeDraft } from "#web/components/social/trade/trade-ticket.ts";
import assert from "node:assert/strict";
import test from "node:test";

import { HIDDEN_AMOUNT } from "@blast/core/lib/format.ts";
import { SOCIAL_TRADE_BASE_COINS, type SocialTradeQuote } from "@blast/core/modules/social/contracts/trades.ts";

import { exactDecimal as decimalOf } from "@blast/core/web/exact-amount.ts";
import { fixtureCoinType, fixtureTradeQuote, fixtureWallet } from "../../../../../../test/fixtures/social/trade/trade-fixtures.ts";
import {
  amountInAtoms,
  fieldValue,
  overBalance,
  presetDraft,
  tradeCta,
  tradeQuoteLine,
  tradeRequest,
  type TradeFacts,
  type TradeQuoteLine,
} from "./trade-model";

/**
 * R3-55, the coin panel's trade form: its rules, over the gate's sample
 * figures (Kai: $860 USDC and 600,000 KSTL; Kestrel at $0.0021) and sample
 * quotes shaped as R3-30 answers them (`trade-fixtures.ts`, whose impact is a
 * fixed ladder: `0.11%` at $100, `4%` at $500, `12%` at $860).
 */

const KSTL = fixtureCoinType("KSTL");
const NOW = 1_800_000_000_000;

const KAI: TradeFacts = {
  signedIn: true,
  symbol: "KSTL",
  coinType: KSTL,
  decimals: 9,
  price: decimalOf("0.0021"),
  usdc: 860_000_000n,
  usdcDecimals: 6,
  held: 600_000_000_000_000n,
  heldHint: true,
};
const VISITOR: TradeFacts = { ...KAI, signedIn: false, usdc: null, held: null, heldHint: false };

const EMPTY_DRAFT: TradeDraft = { side: "buy", typed: "", mode: "typed" };
/** What the field holds once `text` is typed (a preset's value is typed dollars, formatted as typed). */
const typed = (side: "buy" | "sell", text: string): TradeDraft => presetDraft(text, side, KAI);
/** The whole line as one string, as the live region reads it. */
const quoteLineText = (line: TradeQuoteLine) => `${line.lead}${line.impact === null ? "" : ` · impact ${line.impact.text}`}`;
const quoteOf = (draft: TradeDraft, facts: TradeFacts = KAI, fee: "blast" | "wallet" = "blast"): SocialTradeQuote =>
  fixtureTradeQuote(tradeRequest(draft, facts)!, { signedIn: facts.signedIn, fee, nowMs: NOW, wallet: facts.signedIn ? fixtureWallet() : null });
const line = (draft: TradeDraft, facts: TradeFacts = KAI, extra: Partial<Parameters<typeof tradeQuoteLine>[0]> = {}) =>
  quoteLineText(tradeQuoteLine({ draft, facts, quote: isEmpty(draft) ? null : quoteOf(draft, facts), failed: false, ...extra }));
const isEmpty = (draft: TradeDraft) => draft.mode === "typed" && (draft.typed === "" || Number(draft.typed.replace(/,/g, "")) === 0);

test("token sell drafts use exact amounts without a USD price; existing USD drafts keep their meaning", () => {
  const tokens: TradeDraft = { side: "sell", typed: "0.000000003", mode: "typed", unit: "token" };
  const facts = { ...KAI, price: null, held: 7n };
  assert.equal(tradeRequest(tokens, facts)?.amount_in, "3");
  assert.equal(overBalance({ ...tokens, typed: "0.000000008" }, facts), true);
  assert.equal(tradeRequest({ ...tokens, typed: "0.0000000001" }, facts), null);
  assert.equal(tradeRequest({ ...tokens, unit: undefined }, facts), null);
  assert.equal(amountInAtoms(typed("sell", "1.26"), KAI), 600_000_000_000n);
});

test("sell percentage presets floor integer atoms and refresh against the available balance", () => {
  for (const held of [0n, 1n, 7n, 90_071_992_547_409_931n]) {
    const facts = { ...KAI, held, price: null };
    for (const [share, divisor] of [[0.25, 4n], [0.5, 2n], [1, 1n]] as const) {
      const draft: TradeDraft = { side: "sell", typed: "", mode: share === 1 ? "all" : share === 0.5 ? "half" : "quarter", unit: "token" };
      assert.equal(amountInAtoms(draft, facts), held / divisor);
      assert.equal(amountInAtoms({ ...draft, typed: fieldValue(draft, facts), mode: "typed" }, facts), held / divisor);
      assert.equal(amountInAtoms(draft, { ...facts, held: held + 13n }), (held + 13n) / divisor);
    }
  }
});

test("workspace counterassets retain USD input, exact presets and real quote units", () => {
  const counter = { coinType: SOCIAL_TRADE_BASE_COINS.sui, symbol: "SUI", decimals: 9, balance: 12_345_678_901n, price: decimalOf("2.5") };
  const facts = { ...KAI, counter };
  assert.equal(tradeRequest(typed("buy", "10"), facts)?.amount_in, "4000000000");
  assert.equal(tradeRequest(typed("buy", "10"), facts)?.in_coin, counter.coinType);
  assert.equal(amountInAtoms({side:"buy",typed:"",mode:"all"}, facts), counter.balance);
  assert.equal(tradeRequest(typed("buy", "10"), {...facts,counter:{...counter,price:null}}), null);
  assert.equal(amountInAtoms({side:"buy",typed:"",mode:"half"}, {...facts,counter:{...counter,price:null}}), counter.balance/2n);
  assert.equal(tradeRequest(typed("sell", "10"),facts)?.out_coin,counter.coinType);
  const nonbase={...counter,coinType:fixtureCoinType("OTHER"),symbol:"OTHER",decimals:3};
  const sell=typed("sell","10");
  const request=tradeRequest(sell,{...facts,counter:nonbase})!;
  assert.equal(request.side,"buy","two nonbase assets use router pair classification");
  const quote={...quoteOf(sell),...request,amount_out:"12345",min_out:"12000"};
  assert.match(quoteLineText(tradeQuoteLine({draft:sell,facts:{...facts,counter:nonbase},quote,failed:false})),/12\.35 OTHER/);
  assert.equal(tradeRequest(typed("buy","10"),{...facts,counter:{...counter,coinType:KSTL}}),null);
});

/* ---------------- AC-1: the five quote-line forms ---------------- */

test("R3-55-AC-1: the quote line's five forms, verbatim, with the impact in the gate's format", () => {
  assert.equal(line(EMPTY_DRAFT), "You have $860", "empty, signed in, buy");
  assert.equal(line({ ...EMPTY_DRAFT, side: "sell" }), "You have 600,000 KSTL, $1,260", "empty, signed in, sell");
  assert.equal(line(EMPTY_DRAFT, VISITOR), "KSTL is $0.002100", "empty, signed out");
  assert.equal(line(typed("buy", "100")), "≈ 47,567 KSTL · impact 0.11%", "buy, with an amount");
  // $100 of KSTL is min(held, 100 / 0.0021) = 47,619.047… tokens; the route answers what they fetch.
  assert.equal(line(typed("sell", "100")), "≈ 47,619 KSTL → $99.90 · impact 0.1%", "sell, with an amount");
});

test("R3-55-AC-1: impact is `<0.01%` under a basis point, else two places with trailing zeros trimmed", () => {
  assert.match(line(typed("buy", "1")), /impact <0\.01%$/);
  assert.match(line(typed("buy", "250")), /impact 1%$/);
  assert.match(line(typed("buy", "500")), /impact 4%$/);
  assert.match(line(typed("buy", "860")), /impact 12%$/);
});

test("R3-55-AC-2: the impact's colour — red above 10%, amber above 3%, else plain", () => {
  const tone = (usd: string) => tradeQuoteLine({ draft: typed("buy", usd), facts: KAI, quote: quoteOf(typed("buy", usd)), failed: false }).impact?.tone;
  assert.equal(tone("200"), "plain", "0.8%");
  assert.equal(tone("250"), "plain", "1%");
  assert.equal(tone("500"), "warn", "4%");
  assert.equal(tone("860"), "down", "12%");
});

test("no impact without one (OA-29): a visitor's quote, an unaffordable one — never a guess", () => {
  assert.equal(line(typed("buy", "100"), VISITOR), "≈ 47,567 KSTL", "signed out: no dry run, no impact");
  assert.equal(line(typed("buy", "5000")), "≈ 1.81M KSTL", "over balance: no dry run, no impact");
  for (const why of ["no_dry_run", "too_small", "reference_failed"] as const) {
    const quote = { ...quoteOf(typed("buy", "100")), price_impact_bps: null, price_impact_unavailable: why };
    assert.equal(quoteLineText(tradeQuoteLine({ draft: typed("buy", "100"), facts: KAI, quote, failed: false })), "≈ 47,567 KSTL", why);
  }
});

test("before the answer the line keeps its shape; a route-less or failed quote says why", () => {
  const waiting = (draft: TradeDraft) => quoteLineText(tradeQuoteLine({ draft, facts: KAI, quote: null, failed: false }));
  assert.equal(waiting(typed("buy", "100")), "≈ – KSTL");
  assert.equal(waiting(typed("sell", "100")), "≈ 47,619 KSTL → –", "the tokens asked for are known; what they fetch is the route's");
  const noRoute = { ...quoteOf(typed("buy", "100")), unavailable_reason: "no_pool" as const };
  assert.equal(quoteLineText(tradeQuoteLine({ draft: typed("buy", "100"), facts: KAI, quote: noRoute, failed: false })), "No market for this trade yet");
  assert.equal(quoteLineText(tradeQuoteLine({ draft: typed("buy", "100"), facts: KAI, quote: null, failed: true })), "Couldn’t get a price. Try again");
  assert.equal(
    quoteLineText(tradeQuoteLine({ draft: typed("buy", "100"), facts: KAI, quote: quoteOf(typed("buy", "100")), failed: false, feeMist: "3120000" })),
    "Network fee ≈ 0.00312 SUI, paid from your SUI",
    "Blast not paying this fee today says what it is",
  );
});

test("hidden amounts: every dollar figure and coin amount on the line is dots, as the gate's mask; percentages stay", () => {
  assert.equal(line(EMPTY_DRAFT, KAI, { hidden: true }), `You have ${HIDDEN_AMOUNT}`);
  assert.equal(line({ ...EMPTY_DRAFT, side: "sell" }, KAI, { hidden: true }), `You have ${HIDDEN_AMOUNT}, ${HIDDEN_AMOUNT}`);
  assert.equal(line(typed("sell", "100"), KAI, { hidden: true }), `≈ ${HIDDEN_AMOUNT} → ${HIDDEN_AMOUNT} · impact 0.1%`);
});

/* ---------------- AC-6, AC-7: what is asked for ---------------- */

test("R3-55-AC-6: a sell asks the route for the coin's atoms, not the dollars typed", () => {
  const request = tradeRequest(typed("sell", "100"), KAI);
  assert.deepEqual(request, { in_coin: KSTL, out_coin: SOCIAL_TRADE_BASE_COINS.usdc, side: "sell", amount_in: "47619047619047" });
  assert.deepEqual(tradeRequest(typed("buy", "100.5"), KAI), { in_coin: SOCIAL_TRADE_BASE_COINS.usdc, out_coin: KSTL, side: "buy", amount_in: "100500000" });
  assert.equal(tradeRequest(typed("sell", "5000"), KAI)?.amount_in, "600000000000000", "min(held, dollars / price)");
  assert.equal(tradeRequest(EMPTY_DRAFT, KAI), null);
  assert.equal(tradeRequest(typed("buy", "100"), { ...KAI, coinType: null }), null, "no sale read yet, nothing to ask");
});

test("R3-55-AC-7: Max buys with the whole USDC balance and sells everything held, exactly", () => {
  const buyMax = presetDraft("max", "buy", { ...KAI, usdc: 860_123_456n });
  assert.deepEqual(buyMax, { side: "buy", typed: "860.12", mode: "all" });
  assert.equal(amountInAtoms(buyMax, { ...KAI, usdc: 860_123_456n }), 860_123_456n, "every atom, not the cents shown");
  const sellMax = presetDraft("max", "sell", KAI);
  assert.deepEqual(sellMax, { side: "sell", typed: "1,260", mode: "all" });
  assert.equal(amountInAtoms(sellMax, KAI), 600_000_000_000_000n);
  assert.deepEqual(presetDraft("100", "sell", KAI), { side: "sell", typed: "100", mode: "typed" });
});

/* ---------------- AC-5: the whole/half mode (defect 8) ---------------- */

test("R3-55-AC-5: Sell all / Sell 50% are exactly everything or half held; typing leaves them, as in the gate", () => {
  const all: TradeDraft = { side: "sell", typed: "", mode: "all" };
  assert.equal(fieldValue(all, KAI), "1,260");
  assert.equal(amountInAtoms(all, KAI), 600_000_000_000_000n);
  const half: TradeDraft = { side: "sell", typed: "", mode: "half" };
  assert.equal(fieldValue(half, KAI), "630");
  assert.equal(amountInAtoms(half, KAI), 300_000_000_000_000n, "exactly half, whatever the price does");
  assert.equal(amountInAtoms(half, { ...KAI, price: decimalOf("0.0042") }), 300_000_000_000_000n);
  assert.equal(overBalance({ ...all, typed: "999,999" }, KAI), false, "a mode is never over balance (the gate's `!T.max && !T.frac`)");
  // One keystroke: the field holds what was typed and the dollars mean min(held, dollars / price) again (the gate's input handler).
  const keystroke = typed("sell", `${fieldValue(all, KAI)}9`);
  assert.equal(keystroke.typed, "12,609");
  assert.equal(amountInAtoms(keystroke, KAI), 600_000_000_000_000n, "min(held, …)");
  assert.equal(overBalance(keystroke, KAI), true, "and the over-balance guard is back, on the button");
});

test("a mode set before the wallet answered shows its dollars once it has; a typed field shows what was typed", () => {
  const early: TradeDraft = { side: "sell", typed: "", mode: "all" };
  assert.equal(fieldValue(early, { ...KAI, held: null, heldHint: true }), "");
  assert.equal(amountInAtoms(early, { ...KAI, held: null, heldHint: true }), null, "a balance preset cannot spend before the wallet answers");
  assert.equal(fieldValue(early, KAI), "1,260");
  assert.equal(fieldValue({ ...early, mode: "half" }, KAI), "630");
  assert.equal(fieldValue(typed("buy", "12"), KAI), "12");
});

/* ---------------- AC-8, AC-10: the button ---------------- */

test("R3-55-AC-8: over balance is `Not enough USDC` / `Not enough KSTL`, disabled", () => {
  const cta = (draft: TradeDraft) => tradeCta({ draft, facts: KAI, quote: quoteOf(draft), nowMs: NOW });
  assert.deepEqual(cta(typed("buy", "861")), { label: "Not enough USDC", disabled: true, action: "none", note: null });
  assert.deepEqual(cta(typed("sell", "1,261")), { label: "Not enough KSTL", disabled: true, action: "none", note: null });
  assert.deepEqual(cta(typed("buy", "860")), { label: "Buy KSTL", disabled: false, action: "trade", note: null });
  assert.deepEqual(cta(typed("sell", "1,260")), { label: "Sell KSTL", disabled: false, action: "trade", note: null });
  // The route's own balance check stands too (a wallet that moved since it was read).
  const refused = { ...quoteOf(typed("buy", "100")), quote_id: null, offer_refused: "insufficient_balance" as const };
  assert.equal(tradeCta({ draft: typed("buy", "100"), facts: KAI, quote: refused, nowMs: NOW }).label, "Not enough USDC");
});

test("R3-55-AC-10: signed out the button is `Sign in to trade`, and it opens the sign-in sheet", () => {
  assert.deepEqual(tradeCta({ draft: EMPTY_DRAFT, facts: VISITOR, quote: null, nowMs: NOW }), { label: "Sign in to trade", disabled: false, action: "sign-in", note: null });
  assert.equal(tradeCta({ draft: typed("buy", "100"), facts: VISITOR, quote: quoteOf(typed("buy", "100"), VISITOR), nowMs: NOW }).action, "sign-in");
});

test("the button waits for a quote it can execute: none yet, none for this amount, expired, or no route", () => {
  const draft = typed("buy", "100");
  const quote = quoteOf(draft);
  const cta = (q: SocialTradeQuote | null, nowMs = NOW) => tradeCta({ draft, facts: KAI, quote: q, nowMs });
  assert.equal(cta(null).disabled, true);
  assert.equal(cta(quote).disabled, false);
  assert.equal(cta(quote, NOW + 20_000).disabled, true, "expired");
  assert.equal(cta({ ...quote, unavailable_reason: "no_pool" }).disabled, true);
  assert.equal(tradeCta({ draft: EMPTY_DRAFT, facts: KAI, quote: null, nowMs: NOW }).label, "Buy KSTL", "empty: the verb, off");
  const missing = cta({ ...quote, quote_id: null, offer_refused: "blast_wallet_missing" });
  assert.equal(missing.disabled, true);
  assert.equal(missing.note, "Your Blast wallet is not ready. Reload and try again.");
});

test("a typed preset formats as the field does (the gate's `fmtLive`): grouped, one point, six places", () => {
  const field = (text: string) => presetDraft(text, "buy", KAI).typed;
  assert.equal(field("100000"), "100,000");
  assert.equal(field("$1,2a34.5"), "1,234.5");
  assert.equal(field(".5"), "0.5");
  assert.equal(field("007"), "7");
  assert.equal(field("1.1234567"), "1.123456");
  assert.equal(field("1.2.3"), "1.2");
  assert.equal(field(""), "");
});


test("preset USD display follows the current spend asset and fresh facts without changing exact atoms", () => {
  const initial={...KAI,counter:{coinType:SOCIAL_TRADE_BASE_COINS.usdc,symbol:"USDC",decimals:6,balance:860_000000n,price:decimalOf("1")}};
  const max=presetDraft("max","buy",initial);
  const sui={...initial,counter:{coinType:SOCIAL_TRADE_BASE_COINS.sui,symbol:"SUI",decimals:9,balance:2_000000000n,price:decimalOf("2.5")}};
  assert.equal(fieldValue(max,sui),"5");
  assert.equal(amountInAtoms(max,sui),2_000000000n);
  assert.equal(fieldValue(max,{...sui,counter:{...sui.counter,price:null}}),"");
  assert.equal(amountInAtoms(max,{...sui,counter:{...sui.counter,price:null}}),2_000000000n);
  assert.equal(fieldValue({...max,mode:"half"},sui),"2.5");
  assert.equal(fieldValue({...max,mode:"typed",typed:"860"},sui),"860");
});
