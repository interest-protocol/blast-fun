import { tradedToast } from "../trade/trade-result.ts";
import { IDLE_TRADE_QUOTE, tradeRequestKey, type TradeQuoteSnapshot } from "#web/components/social/trade/trade-quotes.ts";
import { EMPTY_TRADE_AMOUNT, tokenAmountAtoms, sellPresetAmount, tradeSide, typedAmount } from "#web/components/social/trade/trade-ticket.ts";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { normalizeStructTag } from "@mysten/sui/utils";

import type { SocialTradeQuote } from "@blast/core/modules/social/contracts/trades.ts";

import { priceText, type WalletCoinView } from "./coin-model";

import { FIXTURE_COINS, FIXTURE_MORE_COINS } from "../../../../test/fixtures/social/coins/coins-fixture-model.ts";
import { canTrade, ECOSYSTEM_COIN_VIEWS, costSentence, decodeTradeAction, encodeTradeAction, FINDING_PRICE, flippedField, fullName, impactUnavailableText, noMatchText, pairFor, pickedPair, pickerFigures, pickerGroups, pxRatio, quoteWithUsd, ratioText, salePair, swapCta, swapPanels, swapPayoutWarning, swapQuoteRequest, tradableCoinView, tradeAction, tradeLabel, tradeOpening, tradeTitle, txRows, txSummary, usdText } from "./swap-model";
import { SUI_COIN_TYPE, USDC_COIN_TYPE } from "@blast/core/lib/sui/coin-types.ts";

/**
 * Social feed R3-33: the universal swap's words and rules (FEATURE-MAP-R3
 * §14.1), over the design's sample wallet and the values in its quotes.
 */

const [USDC, SUI, KSTL, LUMN] = FIXTURE_COINS as [WalletCoinView, WalletCoinView, WalletCoinView, WalletCoinView];
const HLCN = FIXTURE_MORE_COINS[0]!;
const NOW = 1_791_000_000_000;

/** A quote in R3-30's shape: 100 SUI → 341.99 USDC, offered, `Paid by Blast` (the gate's sample at that amount). */
function quoteOf(extra: Partial<SocialTradeQuote> = {}): SocialTradeQuote {
  return {
    quote_id: "q1.sample-quote-id-000000",
    expires_at_ms: NOW + 20_000,
    quoted_at_ms: NOW,
    side: "sell",
    in_coin: SUI_COIN_TYPE,
    out_coin: USDC_COIN_TYPE,
    amount_in: "100000000000",
    amount_out: "341997073",
    min_out: "340287087",
    slippage_bps: 50,
    price_impact_bps: 0,
    price_impact_unavailable: null,
    fee_bps: 25,
    fee_amount: "250000000",
    blast_fee_bps: 50,
    blast_fee_amount: "1718578",
    route: [],
    route_label: "SUI → USDC · Sui pools",
    price_per_out: "1",
    amount_in_usd: "342.00",
    amount_out_usd: "342.00",
    network_fee: { payer: "blast", label: "Paid by Blast", estimate_mist: "2565136" },
    dry_run: "passed",
    offer_refused: null,
    unavailable_reason: null,
    ...extra,
  };
}

const answered = (quote: SocialTradeQuote, extra: Partial<TradeQuoteSnapshot> = {}): TradeQuoteSnapshot => ({
  key: tradeRequestKey(swapQuoteRequest(SUI, USDC, BigInt(quote.amount_in ?? "0"))),
  quote,
  shown: quote,
  loading: false,
  error: null,
  ...extra,
});

const cta = (input: Partial<Parameters<typeof swapCta>[0]>) =>
  swapCta({ signedIn: true, inCoin: SUI, outCoin: USDC, atoms: 100_000_000_000n, snapshot: answered(quoteOf()), nowMs: NOW, busy: false, failed: false, ...input });

test("the payout warning uses quoted values without rounding away precision", () => {
  assert.match(swapPayoutWarning(quoteOf({ amount_in_usd: "0.019", amount_out_usd: "0.009" })) ?? "", /52% below/);
  assert.match(swapPayoutWarning(quoteOf({ amount_in_usd: "10.00", amount_out_usd: "9.00" })) ?? "", /10% below/);
  assert.equal(swapPayoutWarning(quoteOf({ amount_in_usd: "10.00", amount_out_usd: "9.01" })), null);
  assert.match(swapPayoutWarning(quoteOf({ amount_in_usd: null, price_impact_bps: 1_250 })) ?? "", /High price impact/);
});

test("filling dollar values keeps the quote's own and prices only the quote's own coins", () => {
  const sui = { coinType: SUI_COIN_TYPE, decimals: 9, usdPrice: "2" };
  const usdc = { coinType: USDC_COIN_TYPE, decimals: 6, usdPrice: "1" };
  const served = quoteWithUsd(quoteOf({ amount_in_usd: "342.00", amount_out_usd: null }), sui, usdc)!;
  assert.deepEqual([served.amount_in_usd, served.amount_out_usd], ["342.00", "342.00"], "100 SUI keeps the served $342, not $200; 341.997073 USDC rounds to $342.00");
  // The last pair's answer, still on screen after the pair changed: its coins are on neither side.
  const other = quoteWithUsd(quoteOf({ amount_in_usd: null, amount_out_usd: null }), usdc, sui)!;
  assert.deepEqual([other.amount_in_usd, other.amount_out_usd], [null, null]);
  const unpriced = quoteWithUsd(quoteOf({ amount_in_usd: null }), { ...sui, usdPrice: null }, usdc)!;
  assert.equal(unpriced.amount_in_usd, null);
  // A quote with no route has no amounts to value.
  const empty = quoteWithUsd(quoteOf({ amount_in: null, amount_out: null, amount_in_usd: null, amount_out_usd: null }), sui, usdc)!;
  assert.deepEqual([empty.amount_in_usd, empty.amount_out_usd], [null, null]);
});

test("the side follows the coins, as the quote route requires (a buy spends USDC or SUI on a coin, a sell the reverse)", () => {
  assert.equal(tradeSide(USDC.coinType, KSTL.coinType), "buy");
  assert.equal(tradeSide(SUI.coinType, KSTL.coinType), "buy");
  assert.equal(tradeSide(KSTL.coinType, USDC.coinType), "sell");
  assert.equal(tradeSide(KSTL.coinType, SUI.coinType), "sell");
  assert.equal(tradeSide(USDC.coinType, SUI.coinType), "buy");
  assert.equal(tradeSide(SUI.coinType, USDC.coinType), "sell");
  assert.equal(tradeSide(KSTL.coinType, LUMN.coinType), "buy");
  assert.deepEqual(swapQuoteRequest(USDC, KSTL, 100_000_000n), { in_coin: USDC_COIN_TYPE, out_coin: KSTL.coinType, side: "buy", amount_in: "100000000" });
  assert.equal(swapQuoteRequest(USDC, KSTL, null), null);
  assert.notEqual(tradeRequestKey({ ...swapQuoteRequest(USDC, KSTL, 1n)!, slippage_bps: 50 }), tradeRequestKey({ ...swapQuoteRequest(USDC, KSTL, 1n)!, slippage_bps: 100 }), "a slippage edit asks a different question");
  assert.equal(swapQuoteRequest(USDC, USDC, 1n), null, "a coin for itself is no trade");
});

test("USD text keeps cents, rounded down, and rejects anything that is not a plain decimal", () => {
  assert.equal(usdText("342.00"), "$342.00");
  assert.equal(usdText("1410.3"), "$1,410.30");
  assert.equal(usdText("7"), "$7.00");
  assert.equal(usdText(null), "—");
  assert.equal(usdText("1e9"), "—");
});

test("R3-33-AC-4 (defect 8): Max is an explicit whole-balance mode with the exact atoms; a keystroke visibly leaves it", () => {
  const max = sellPresetAmount("max", SUI);
  assert.deepEqual(max, { typed: "412.38", mode: "all", unit: "token" });
  assert.equal(tokenAmountAtoms(max, SUI), SUI.atoms, "the whole balance's exact atoms");
  // A balance with more places than the field shows: the field shows six, the trade sells every atom, no dust.
  const dusty = { ...SUI, atoms: 412_380_000_123n };
  assert.equal(sellPresetAmount("max", dusty).typed, "412.38");
  assert.equal(tokenAmountAtoms(sellPresetAmount("max", dusty), dusty), 412_380_000_123n);
  // Typing replaces the mode: the field is what was typed, nothing is re-read from the balance.
  const typed = typedAmount("412.385", SUI.decimals);
  assert.deepEqual(typed, { typed: "412.385", mode: "typed", unit: "token" });
  assert.equal(tokenAmountAtoms(typed, SUI), 412_385_000_000n);
  // Both trade surfaces preserve the selected percentage down to integer atoms.
  assert.deepEqual(sellPresetAmount("25", SUI), { typed: "103.095", mode: "typed", unit: "token" });
  assert.deepEqual(sellPresetAmount("50", USDC), { typed: "430", mode: "typed", unit: "token" });
  assert.equal(tokenAmountAtoms(EMPTY_TRADE_AMOUNT, SUI), null);
  assert.equal(tokenAmountAtoms(typedAmount("0", SUI.decimals), SUI), 0n);
});

test("R3-33-AC-2: the flip swaps the pair and sells what the quote gave, rounded so flipping back does not drift", () => {
  assert.deepEqual(flippedField(341_997_073n, 6), { typed: "342", mode: "typed", unit: "token" });
  assert.deepEqual(flippedField(99_999_146_198n, 9), { typed: "100", mode: "typed", unit: "token" });
  assert.deepEqual(flippedField(2_099_993n, 6), { typed: "2.1", mode: "typed", unit: "token" });
  assert.deepEqual(flippedField(null, 9), EMPTY_TRADE_AMOUNT);
  assert.deepEqual(pairFor("sui"), { in: "sui", out: "usdc" });
  assert.deepEqual(pairFor("usdc"), { in: "usdc", out: "sui" });
  assert.deepEqual(pairFor("kstl"), { in: "kstl", out: "usdc" });
  // Picking the other side's coin swaps the two (the gate's pickCoin); a new coin to sell empties the amount.
  assert.deepEqual(pickedPair({ in: "sui", out: "usdc" }, "in", "usdc"), { pair: { in: "usdc", out: "sui" }, clear: true });
  assert.deepEqual(pickedPair({ in: "sui", out: "usdc" }, "in", "sui"), { pair: { in: "sui", out: "usdc" }, clear: false });
  assert.deepEqual(pickedPair({ in: "sui", out: "usdc" }, "out", "kstl"), { pair: { in: "sui", out: "kstl" }, clear: false });
  assert.deepEqual(pickedPair({ in: "sui", out: "usdc" }, "out", "sui"), { pair: { in: "usdc", out: "sui" }, clear: true });
});

test("R3-33-AC-1: the panels and the detail are the quote's figures, formatted; nothing before a quote", () => {
  const panels = swapPanels({ inCoin: SUI, outCoin: USDC, snapshot: answered(quoteOf()), hidden: false });
  assert.deepEqual(panels, {
    inUsd: "≈ $342.00",
    out: { text: "341.99", muted: false, pending: false },
    outUsd: null,
    inBalance: "Balance 412.38\u00a0SUI",
    outBalance: "Balance 860\u00a0USDC",
  });
  const idle = swapPanels({ inCoin: SUI, outCoin: USDC, snapshot: IDLE_TRADE_QUOTE, hidden: false });
  assert.deepEqual(idle.out, { text: "—", muted: true, pending: false }, "no amount: the muted dash, never a 0 (DS rule 21)");
  assert.equal(idle.inUsd, "—", "an unknown dollar value is the bare dash, never `≈ —`");
  assert.equal(idle.outUsd, null, "no dollar line under a dollar coin");
  assert.equal(swapPanels({ inCoin: USDC, outCoin: SUI, snapshot: IDLE_TRADE_QUOTE, hidden: false }).outUsd, "—");
  const unpriced = swapPanels({ inCoin: SUI, outCoin: USDC, snapshot: answered(quoteOf({ amount_in_usd: null, amount_out_usd: null })), hidden: false });
  assert.equal(unpriced.inUsd, "—");
  assert.equal(swapPanels({ inCoin: USDC, outCoin: SUI, snapshot: answered(quoteOf({ in_coin: USDC.coinType, out_coin: SUI.coinType, amount_out_usd: null })), hidden: false }).outUsd, "—");
  assert.deepEqual(swapPanels({ inCoin: SUI, outCoin: USDC, snapshot: IDLE_TRADE_QUOTE, hidden: true }).inBalance, "Balance ••••");
  // WS-8: the worst-case balance rounds up to the next unit, never `1000M`.
  assert.equal(swapPanels({ inCoin: { ...SUI, atoms: 999_999_999_990_000_000n }, outCoin: USDC, snapshot: IDLE_TRADE_QUOTE, hidden: false }).inBalance, "Balance 1B\u00a0SUI");
  // While a new amount is asked, the last answer stays — faint.
  const asking = { ...answered(quoteOf()), key: "another question", quote: null, loading: true };
  assert.equal(asking.quote, null);
  assert.equal(asking.loading, true);
  assert.deepEqual(swapPanels({ inCoin: SUI, outCoin: USDC, snapshot: asking, hidden: false }).out, { text: "341.99", muted: false, pending: true });
  // The first answer for an amount, or a failed one, reads the muted dash, never a `0` that looks like the answer.
  const first = { ...IDLE_TRADE_QUOTE, key: "k", loading: true };
  assert.deepEqual(swapPanels({ inCoin: SUI, outCoin: USDC, snapshot: first, hidden: false }).out, { text: "—", muted: true, pending: false });
  const failed = { ...IDLE_TRADE_QUOTE, key: "k", error: { code: "service_unavailable" } };
  assert.deepEqual(swapPanels({ inCoin: SUI, outCoin: USDC, snapshot: failed, hidden: false }).out, { text: "—", muted: true, pending: false });

  // Owner (2026-10-06): the gate's line, the quote's own exact rate — 341.997073 USDC for 100 SUI is `1 SUI = $3.42`.
  assert.deepEqual(txSummary({ inCoin: SUI, outCoin: USDC, quote: quoteOf(), walletFee: "sponsored" }), { price: "1\u00a0SUI = $3.42", gas: "Free" });
  assert.deepEqual(txRows({ outCoin: USDC, quote: quoteOf(), walletFee: "sponsored" }).map((row) => [row.label, row.value]), [
    ["Price impact", "<0.01%"],
    ["Max slippage", "Auto · 0.5%"],
    ["Network fee", "Paid by Blast"],
    ["Route", "SUI → USDC · Sui pools"],
  ]);
  // Before any quote: the gate's dashes and helper copy, never a number.
  assert.deepEqual(txRows({ outCoin: USDC, quote: null, walletFee: "sponsored" }).map((row) => row.value), ["—", "Auto · 0.5%", "Paid by Blast", "—"]);
});

test("the cost sentence beside the button is the live quote's amount, minimum and Blast fee, in plain words", () => {
  assert.equal(costSentence({ inCoin: SUI, outCoin: USDC, quote: quoteOf(), focus: null, atoms: null }), "Sell 100\u00a0SUI for at least 340.28\u00a0USDC. Blast fee 0.5%.");
  const buy = quoteOf({ in_coin: USDC_COIN_TYPE, out_coin: KSTL.coinType, amount_in: "100000000", amount_out: "47604447534729", min_out: "47366425297055" });
  assert.equal(costSentence({ inCoin: USDC, outCoin: KSTL, quote: buy, focus: KSTL.key, atoms: null }), "Pay 100\u00a0USDC for at least 47,366\u00a0KSTL. Blast fee 0.5%.");
  // No sentence without a live answer for this pair: before a quote, an unavailable one, or another pair's.
  assert.equal(costSentence({ inCoin: SUI, outCoin: USDC, quote: null, focus: null, atoms: null }), null);
  assert.equal(costSentence({ inCoin: SUI, outCoin: USDC, quote: quoteOf({ unavailable_reason: "no_pool" }), focus: null, atoms: null }), null);
  assert.equal(costSentence({ inCoin: USDC, outCoin: SUI, quote: quoteOf(), focus: null, atoms: null }), null);
  // A short wallet: the field shows the balance and the button says "Not enough SUI", so the line stays empty.
  assert.equal(costSentence({ inCoin: SUI, outCoin: USDC, quote: quoteOf(), focus: null, atoms: SUI.atoms + 1n }), null);
  const short = (reason: "input" | "gas") => quoteOf({ offer_refused: "insufficient_balance", balance_failure: { reason, coin_type: SUI.coinType, required_atoms: "1000000000000", available_atoms: "412380000000" } });
  assert.equal(costSentence({ inCoin: SUI, outCoin: USDC, quote: short("input"), focus: null, atoms: null }), null);
  // The network fee's need shows nowhere else, so the line keeps it.
  assert.equal(costSentence({ inCoin: SUI, outCoin: USDC, quote: short("gas"), focus: null, atoms: null }), "The network fee needs 1,000\u00a0SUI. You have 412.38\u00a0SUI.");
});

test("owner (2026-10-06): the collapsed line is the gate's `1 <sell> = <rate> <get>`, the quote's exact rate rounded as the gate rounds", () => {
  const line = (inCoin: WalletCoinView, outCoin: WalletCoinView, amountIn: string, amountOut: string) =>
    txSummary({ inCoin, outCoin, quote: quoteOf({ in_coin: inCoin.coinType, out_coin: outCoin.coinType, amount_in: amountIn, amount_out: amountOut }), walletFee: "sponsored" }).price;
  // The flip of the gate's sample: 342 USDC → 99.999146198 SUI.
  assert.equal(line(USDC, SUI, "342000000", "99999146198"), "1\u00a0USDC = 0.292\u00a0SUI");
  // 100 USDC → 47,604.447534729 KSTL: two places, rounded down (the gate's amtFmt), never the price feed's 476.19.
  assert.equal(line(USDC, KSTL, "100000000", "47604447534729"), "1\u00a0USDC = 476.04\u00a0KSTL");
  // You get USDC: the rate in dollars as the gate's px writes it — 2.099993 USDC for 1,000 KSTL.
  assert.equal(line(KSTL, USDC, "1000000000000", "2099993"), "1\u00a0KSTL = $0.0021");
  assert.equal(line(SUI, USDC, "1000000000", "3419970"), "1\u00a0SUI = $3.42");
  assert.equal(line(SUI, USDC, "1000000000", "210935"), "1\u00a0SUI = $0.2109", "four places from a cent");
  assert.equal(line(KSTL, USDC, "1000000000000000000", "60000"), "1\u00a0KSTL = $0.0₁₀6", "below a millionth, in the site's subscript form, never exponent notation");
  // From 10,000 whole units only; between two sale coins too.
  assert.equal(line(SUI, KSTL, "100000000", "332001975262684891"), "1\u00a0SUI = 3,320,019,752\u00a0KSTL");
  assert.equal(line(KSTL, LUMN, "1000000000000", "1615384615384"), "1\u00a0KSTL = 1.61\u00a0LUMN");
  // Before any answer for the pair: no rate, except a coin sold for USDC shows its price (the gate's empty screen).
  const empty = (inCoin: WalletCoinView, outCoin: WalletCoinView) => txSummary({ inCoin, outCoin, quote: null, walletFee: "sponsored" }).price;
  assert.equal(empty(SUI, USDC), "1\u00a0SUI = $3.42");
  assert.equal(empty(USDC, SUI), "1\u00a0USDC = —\u00a0SUI");
  assert.equal(empty({ ...KSTL, price: null }, USDC), "1\u00a0KSTL = —");
  // While a new amount is asked, the last answer's rate for the same pair stays; another pair's never does.
  const last = quoteOf();
  assert.equal(txSummary({ inCoin: SUI, outCoin: USDC, quote: null, shown: last, walletFee: "sponsored" }).price, "1\u00a0SUI = $3.42");
  assert.equal(txSummary({ inCoin: USDC, outCoin: SUI, quote: null, shown: last, walletFee: "sponsored" }).price, "1\u00a0USDC = —\u00a0SUI");
  // An answer with no route has no rate.
  assert.equal(txSummary({ inCoin: USDC, outCoin: SUI, quote: quoteOf({ in_coin: USDC_COIN_TYPE, out_coin: SUI_COIN_TYPE, unavailable_reason: "no_pool" }), walletFee: "sponsored" }).price, "1\u00a0USDC = —\u00a0SUI");
  assert.equal(ratioText(0n, 1n), "0");
  assert.equal(pxRatio(5n, 1n), "$5.00");
});

test("dollar rates and prices never print in exponent form: tiny ones take the subscript form", () => {
  assert.equal(pxRatio(6n, 100_000_000_000n), "$0.0₁₀6");
  assert.equal(pxRatio(123n, 100_000_000_000n), "$0.0₈123");
  assert.equal(pxRatio(21n, 10_000n), "$0.0021");
  assert.equal(pxRatio(2109n, 10_000n), "$0.2109");
  assert.equal(priceText(0.000000123), "$0.0₆123");
  assert.equal(priceText(0.000556), "$0.000556");
  assert.equal(priceText(3.42), "$3.42");
  for (const text of [pxRatio(1n, 10n ** 30n), priceText(1e-30)]) assert.doesNotMatch(text, /e-/);
});

test("price impact: the quote's, with the gate's amber above 3% and red above 10%; OA-29's unavailable reasons say why, never a figure", () => {
  const impact = (extra: Partial<SocialTradeQuote>) => txRows({ outCoin: USDC, quote: quoteOf(extra), walletFee: "sponsored" })[0]!;
  assert.deepEqual(impact({ price_impact_bps: 11 }), { label: "Price impact", value: "0.11%", tone: null, numeric: true });
  assert.equal(impact({ price_impact_bps: 301 }).tone, "warn");
  assert.equal(impact({ price_impact_bps: 8_233 }).tone, "down");
  assert.equal(impact({ price_impact_bps: 8_233 }).value, "82.33%");
  assert.equal(impact({ price_impact_bps: null, price_impact_unavailable: "too_small" }).value, "Too small to measure");
  assert.equal(impact({ price_impact_bps: null, price_impact_unavailable: "reference_failed" }).value, "Not available right now");
  assert.equal(impact({ price_impact_bps: null, price_impact_unavailable: "no_dry_run" }).value, "—");
  assert.equal(impactUnavailableText(null), "—");
});

test("R3-33-AC-7: the network fee tells the truth — Paid by Blast while sponsored; a wallet the server answers wallet-pays pays from its SUI", () => {
  const session = quoteOf({ network_fee: { payer: "wallet", label: "Paid from your SUI", estimate_mist: "2565136" } });
  assert.equal(txRows({ outCoin: USDC, quote: session, walletFee: "wallet" })[2]!.value, "Paid from your SUI");
  assert.equal(txSummary({ inCoin: SUI, outCoin: USDC, quote: session, walletFee: "wallet" }).gas, "≈ 0.00257\u00a0SUI", "never `Free`");
  // Before a quote, the wallet read says who pays.
  assert.equal(txRows({ outCoin: USDC, quote: null, walletFee: "wallet" })[2]!.value, "Paid from your SUI");
  assert.equal(txSummary({ inCoin: SUI, outCoin: USDC, quote: null, walletFee: "wallet" }).gas, "Paid from your SUI");
  assert.equal(txRows({ outCoin: USDC, quote: null, walletFee: "sponsored" })[2]!.value, "Paid by Blast");
  assert.equal(txSummary({ inCoin: SUI, outCoin: USDC, quote: null, walletFee: "sponsored" }).gas, "Free");
});

test("the button: every state the screen can be in (R3-33-AC-5, AC-6, AC-9)", () => {
  assert.deepEqual(cta({}), { label: "Swap", enabled: true, action: "trade", busy: false });
  // KA-6: every off state keeps the verb; the reason goes on the line above it (DS rule 18).
  assert.deepEqual(cta({ atoms: null, snapshot: IDLE_TRADE_QUOTE }), { label: "Swap", enabled: false, action: null, busy: false, reason: "Enter an amount." });
  // AC-5: over the balance, and a pair with no route.
  // Over the balance the button keeps its verb, off, and its reason goes on the line above it (DS rule 18, KA-6).
  assert.deepEqual(cta({ atoms: 500_000_000_000n }), { label: "Swap", enabled: false, action: null, busy: false, reason: "Not enough SUI for this amount." });
  assert.deepEqual(cta({ snapshot: answered(quoteOf({ unavailable_reason: "no_pool", amount_out: null })) }), { label: "Swap", enabled: false, action: null, busy: false, reason: "No market for this trade yet. Choose a different token." });
  assert.equal(cta({ snapshot: answered(quoteOf({ unavailable_reason: "not_tradable" })) }).reason, "This coin isn’t trading yet.");
  // A failed quote keeps the action's name, off; the error line above says what failed.
  assert.deepEqual(cta({ snapshot: { ...IDLE_TRADE_QUOTE, key: "k", error: { code: "service_unavailable" } } }), { label: "Swap", enabled: false, action: null, busy: false });
  // AC-6: in flight (the first answer, or a refresh) and stale are off.
  // The first answer keeps the action's name; the indicator (named FINDING_PRICE) appears after 300 ms.
  assert.deepEqual(cta({ snapshot: { ...IDLE_TRADE_QUOTE, key: "k", loading: true } }), { label: "Swap", enabled: false, action: null, busy: false, quoting: true });
  assert.notEqual(cta({ snapshot: { ...IDLE_TRADE_QUOTE, key: "k", loading: true } }).label, FINDING_PRICE, "the waiting words are the indicator's name, not the button's");
  assert.deepEqual(cta({ snapshot: answered(quoteOf(), { loading: true }) }), { label: "Swap", enabled: false, action: null, busy: false });
  // The browser's estimate stays on while the same amount refreshes (the press seals); a new amount still waits.
  const estimate = answered(quoteOf({ quote_id: null, expires_at_ms: null }), { loading: true });
  assert.deepEqual([cta({ snapshot: estimate, estimate: true }).enabled, cta({ snapshot: estimate, estimate: true }).action], [true, "trade"]);
  assert.equal(cta({ snapshot: { ...estimate, quote: null }, estimate: true }).quoting, true, "a new amount has no answer yet: it waits");
  assert.equal(cta({ nowMs: NOW + 20_000 }).enabled, false, "expired at its expires_at_ms");
  assert.equal(cta({ snapshot: answered(quoteOf({ quote_id: null, expires_at_ms: null })) }).enabled, false, "shown but not offered");
  // The quote route's own refusals.
  assert.deepEqual(cta({ snapshot: answered(quoteOf({ offer_refused: "insufficient_balance", quote_id: null })) }), { label: "Swap", enabled: false, action: null, busy: false, reason: "Not enough SUI for this amount." });
  // The network fee's need is the money sentence's own words; the button is the verb, off.
  assert.deepEqual(cta({ snapshot: answered(quoteOf({ offer_refused: "insufficient_balance", quote_id: null, balance_failure: { reason: "gas", coin_type: SUI_COIN_TYPE, required_atoms: "2820419", available_atoms: "0" } })) }), { label: "Swap", enabled: false, action: null, busy: false });
  assert.deepEqual(cta({ snapshot: answered(quoteOf({ offer_refused: "blast_wallet_missing", quote_id: null })) }), { label: "Swap", enabled: false, action: null, busy: false, reason: "Your Blast wallet isn’t ready yet." });
  assert.deepEqual(cta({ balanceKnown: false }), { label: "Swap", enabled: false, action: null, busy: false, reason: "Your wallet could not load." });
  // AC-9: a visitor's button signs in.
  assert.deepEqual(cta({ signedIn: false }), { label: "Sign in", enabled: true, action: "sign-in", busy: false, reason: "Sign in to swap." });
  assert.deepEqual(cta({ snapshot: answered(quoteOf({ offer_refused: "sign_in", quote_id: null })) }), { label: "Sign in", enabled: true, action: "sign-in", busy: false, reason: "Sign in to swap." });
  // AC-8 and the gate's errors: `Swapping`, then the verb, off, for a moment while the line above says what failed.
  assert.deepEqual(cta({ busy: true }), { label: "Swapping", enabled: false, action: null, busy: true });
  assert.deepEqual(cta({ failed: true }), { label: "Swap", enabled: false, action: null, busy: false });
});

test("R3-33-AC-8: the toast is `Traded 100 USDC for 250 SUI` with the route under it, from what filled", () => {
  const trade = {
    trade_id: "t", status: "confirmed", side: "buy", in_coin: USDC_COIN_TYPE, out_coin: SUI_COIN_TYPE, amount_in: "100000000", amount_out: "250100000000",
    min_out: "248849500000", amount_out_filled: "250000000000", route_label: "USDC → SUI · Sui pools", network_fee: null, reservation_id: null,
    transaction_bytes: null, digest: "d", expires_at_ms: null, failure_code: null, created_at_ms: 0, settled_at_ms: 1,
  } as const;
  const toast = tradedToast(trade, { in: USDC, out: SUI });
  assert.equal(toast.title, "Traded 100 USDC for 250 SUI");
  assert.equal(toast.sub, "USDC → SUI · Sui pools");
  assert.equal(toast.first.amount, "100");
  assert.equal(toast.first.coinType, trade.in_coin);
  assert.equal(toast.second.amount, "250");
  assert.equal(toast.second.coinType, trade.out_coin);
  assert.equal(tradedToast({ ...trade, amount_out_filled: null }, { in: USDC, out: SUI }).title, "Traded 100 USDC for 250.1 SUI", "the quote's when the fill is not read yet");
});

test("the picker searches short and padded coin types as well as names", () => {
  for (const query of ["Sui", "0x", "0x000", "0x2", "0x2::sui::SUI", "0x2::sui::su", "0x0002::SUI::sui", SUI_COIN_TYPE, "  0x0002::sui::SUI  "]) {
    const coins = pickerGroups({ wallet: FIXTURE_COINS, more: [], pins: [], query }).flatMap((group) => group.coins);
    assert.ok(coins.some((coin) => coin.coinType === SUI_COIN_TYPE), `${query} finds SUI`);
  }
  const coins = pickerGroups({ wallet: [], more: FIXTURE_MORE_COINS, pins: [], query: HLCN.coinType }).flatMap((group) => group.coins);
  assert.deepEqual(coins.map((coin) => coin.symbol), ["HLCN"]);
});

test("with no Blast coin trading, the picker still lists the Sui ecosystem coins, each tradable with its mainnet decimals", () => {
  const listed = pickerGroups({ wallet: [], more: ECOSYSTEM_COIN_VIEWS, pins: [], query: "" }).flatMap((group) => group.coins);
  assert.deepEqual(listed.slice(0, 3).map((coin) => coin.symbol), ["SUI", "USDC", "USDsui"]);
  assert.ok(listed.every((coin) => canTrade(coin) && coin.presale === null));
  const decimals = Object.fromEntries(listed.map((coin) => [coin.symbol, coin.decimals]));
  assert.deepEqual([decimals.WAL, decimals.DEEP, decimals.NS, decimals.WBTC, decimals.BLUB], [9, 6, 6, 8, 2], "read from mainnet coin metadata");
  assert.deepEqual(pickerGroups({ wallet: [], more: ECOSYSTEM_COIN_VIEWS, pins: [], query: "wal" })[0]?.coins.map((coin) => coin.symbol), ["WAL"]);
  // A Blast coin the server returns comes right after SUI, USDC and USDsui, before the rest of the catalog.
  const withBlast = pickerGroups({ wallet: [], more: [HLCN, ...ECOSYSTEM_COIN_VIEWS], pins: [], query: "" }).flatMap((group) => group.coins);
  assert.deepEqual(withBlast.slice(0, 5).map((coin) => coin.symbol), ["SUI", "USDC", "USDsui", "HLCN", "hashiBTC"]);
});

test("the picker matches generic struct tags using SDK normalization", () => {
  const type = "0x2::coin::Wrapper<0xa::token::TOKEN>";
  const coin = { ...SUI, coinType: normalizeStructTag(type), symbol: "WRAP", name: "Wrapped token" };
  const query = "0x0002::coin::Wrapper< 0x000a::token::TOKEN >";
  assert.deepEqual(pickerGroups({ wallet: [coin], more: [], pins: [], query })[0]?.coins, [coin]);
});

test("ticker searches do not match hex characters in unrelated coin types", () => {
  const coin = { ...SUI, coinType: "0xbee::coin::TOKEN", symbol: "WRAP", name: "Wrapped token" };
  assert.deepEqual(pickerGroups({ wallet: [coin], more: [], pins: [], query: "be" }), []);
});

test("R3-33-AC-3: the picker — your coins by USD value, then the rest; name and ticker search; the curly no-match line", () => {
  const groups = (query: string, pins: readonly string[] = [], more = FIXTURE_MORE_COINS) =>
    pickerGroups({ wallet: FIXTURE_COINS, more, pins, query }).map((group) => [group.label, group.coins.map((coin) => coin.symbol)]);
  // The gate's order: what you hold by value (SUI $1,410, KSTL $1,260, USDC $860, LUMN $130), then everything else you can trade.
  assert.deepEqual(groups(""), [["Your coins", ["SUI", "KSTL", "USDC", "LUMN"]], ["More coins", ["HLCN"]]]);
  // Favourites are shortcuts; the holdings list follows USD value.
  assert.deepEqual(groups("", ["lumn", "usdc"]), [["Your coins", ["SUI", "KSTL", "USDC", "LUMN"]], ["More coins", ["HLCN"]]]);
  // Search: name (USD Coin, Sui), ticker, case, a leading $.
  assert.deepEqual(groups("usd coin"), [["Your coins", ["USDC"]]]);
  assert.deepEqual(groups("$kst"), [["Your coins", ["KSTL"]]]);
  assert.deepEqual(groups("HAL"), [["Coins", ["HLCN"]]], "`Coins` when none of yours matches");
  assert.deepEqual(groups("xyz"), []);
  assert.equal(noMatchText(" xyz "), "No coins match “xyz”.");
  // A coin you do not hold of USDC or SUI is offered under the rest; a sale coin whose sale does not trade is not offered.
  const poor = FIXTURE_COINS.map((coin) => (coin.key === "sui" ? { ...coin, atoms: 0n, amount: 0, value: 0 } : coin.key === "lumn" ? { ...coin, presale: { ...coin.presale!, trading: false } } : coin));
  assert.deepEqual(
    pickerGroups({ wallet: poor, more: [], pins: [], query: "" }).map((group) => [group.label, group.coins.map((coin) => coin.symbol)]),
    [["Your coins", ["KSTL", "USDC", "LUMN"]], ["More coins", ["SUI"]]],
  );
  // The route's coins never repeat one you hold.
  assert.deepEqual(groups("", [], [tradableCoinView({ coin_type: KSTL.coinType, symbol: "KSTL", name: "Kestrel", decimals: 9, icon_url: null, usd_price: null, presale_id: "kstl" })]), [["Your coins", ["SUI", "KSTL", "USDC", "LUMN"]]]);
  assert.equal(fullName(USDC), "USD Coin");
  assert.equal(fullName(SUI), "Sui");
  assert.equal(fullName(KSTL), "Kestrel");
  assert.deepEqual(pickerFigures(SUI, false), { value: "$1,410", amount: "412.38" });
  assert.deepEqual(pickerFigures(SUI, true), { value: "••••", amount: "••••" });
  assert.deepEqual(pickerFigures(HLCN, false), { value: "$0.0042", amount: null });
  assert.deepEqual(pickerFigures({ ...USDC, atoms: 0n }, false), { value: "$1.00", amount: null });
});

test("R3-34: a sale page's Buy and Sell name its coin and side; anything else is no trade", () => {
  const coin = { coin_type: KSTL.coinType, symbol: "KSTL", name: "Kestrel", decimals: 9, icon_url: null, usd_price: "0.0021", presale_id: "0xabc" };
  const text = encodeTradeAction({ side: "sell", coin });
  assert.deepEqual(decodeTradeAction(text), { side: "sell", coin });
  assert.deepEqual(salePair({ side: "sell", coin }), { in: "0xabc", out: "usdc" });
  assert.deepEqual(salePair({ side: "buy", coin }), { in: "usdc", out: "0xabc" });
  for (const bad of [undefined, "", "{", JSON.stringify({ side: "hold", coin }), JSON.stringify({ side: "buy", coin: { ...coin, decimals: 1.5 } })]) {
    assert.equal(decodeTradeAction(bad), null);
  }
  const view = tradableCoinView(coin);
  assert.equal(view.atoms, 0n);
  assert.equal(view.key, "0xabc");
  assert.equal(view.price, 0.0021);
});

test("the dock's Swap: `openTrade` with no argument is the plain swap, USDC for SUI (the gate's `bxDrawerCoin('trade')`); a sale's action its pair; anything else nothing", () => {
  assert.deepEqual(tradeOpening(undefined), { pair: { in: "usdc", out: "sui" }, action: null, screen: { kind: "trade", key: "usdc", out: "sui" } });
  const coin = { coin_type: KSTL.coinType, symbol: "KSTL", name: "Kestrel", decimals: 9, icon_url: null, usd_price: "0.0021", presale_id: "0xabc" };
  assert.deepEqual(tradeOpening(encodeTradeAction({ side: "buy", coin })), {
    pair: { in: "usdc", out: "0xabc" },
    action: { side: "buy", coin },
    screen: { kind: "trade", key: "usdc", out: "0xabc", focus: "0xabc" },
  });
  for (const bad of ["", "{", JSON.stringify({ side: "hold", coin })]) assert.equal(tradeOpening(bad), null, bad);
});

test("OA-48: a sale's Buy and Sell open the trade screen with the sale's coin in focus; the plain swap has none", () => {
  const coin = { coin_type: KSTL.coinType, symbol: "KSTL", name: "Kestrel", decimals: 9, icon_url: null, usd_price: "0.0021", presale_id: "kstl" };
  assert.deepEqual(tradeOpening(encodeTradeAction({ side: "sell", coin }))!.screen, { kind: "trade", key: "kstl", out: "usdc", focus: "kstl" });
  assert.deepEqual(tradeOpening(encodeTradeAction({ side: "buy", coin }))!.screen, { kind: "trade", key: "usdc", out: "kstl", focus: "kstl" });
  assert.equal("focus" in tradeOpening(undefined)!.screen, false);
});

test("the SUI page's Buy opens USDC to SUI with SUI in focus, so it reads Buy SUI", () => {
  const coin = { coin_type: SUI_COIN_TYPE, symbol: "SUI", name: "Sui", decimals: 9, icon_url: null, usd_price: "3.1", presale_id: null };
  const screen = tradeOpening(encodeTradeAction({ side: "buy", coin }))!.screen;
  assert.deepEqual(screen, { kind: "trade", key: "usdc", out: "sui", focus: "sui" });
  assert.equal(tradeTitle(USDC, SUI, "sui"), "Buy SUI");
});

test("OA-48 (the gate's `tradeTitle`): Buy {SYM} for USDC → the focus coin, Sell {SYM} for the reverse, the Swap board's Swap for no focus or any other pair", () => {
  assert.equal(tradeTitle(USDC, KSTL, "kstl"), "Buy KSTL");
  assert.equal(tradeTitle(KSTL, USDC, "kstl"), "Sell KSTL");
  assert.equal(tradeAction(USDC, KSTL, "kstl"), "buy");
  assert.equal(tradeAction(KSTL, USDC, "kstl"), "sell");
  // The plain swap and a coin's own Trade have no coin in focus.
  assert.equal(tradeTitle(USDC, KSTL, null), "Swap");
  assert.equal(tradeTitle(USDC, SUI, null), "Swap");
  // The focused coin keeps Buy/Sell semantics with any payment coin.
  assert.equal(tradeTitle(SUI, KSTL, "kstl"), "Buy KSTL");
  assert.equal(tradeTitle(KSTL, SUI, "kstl"), "Sell KSTL");
  assert.equal(tradeTitle(USDC, LUMN, "kstl"), "Swap");
  assert.equal(tradeTitle(LUMN, USDC, "kstl"), "Swap");
  assert.equal(tradeTitle(USDC, SUI, "usdc"), "Swap", "USDC itself is never the coin in focus");
});

test("trade actions name the focused coin and omit the payment already shown in the panels", () => {
  const buy = quoteOf({ side: "buy", in_coin: USDC_COIN_TYPE, out_coin: KSTL.coinType, amount_in: "100000000", amount_out: "47604447534729", route_label: null });
  const sell = quoteOf({ side: "sell", in_coin: KSTL.coinType, out_coin: USDC_COIN_TYPE, amount_in: "47604447534729", amount_out: "99890000", route_label: null });
  const at = (quote: SocialTradeQuote, inCoin: WalletCoinView, outCoin: WalletCoinView) => ({
    inCoin,
    outCoin,
    atoms: BigInt(quote.amount_in!),
    snapshot: { ...answered(quote), key: tradeRequestKey(swapQuoteRequest(inCoin, outCoin, BigInt(quote.amount_in!))) },
  });
  assert.equal(cta({ ...at(buy, USDC, KSTL), focus: "kstl" }).label, "Buy 47,604\u00a0KSTL");
  assert.equal(cta({ ...at(sell, KSTL, USDC), focus: "kstl" }).label, "Sell 47,604\u00a0KSTL");
  assert.equal(cta({ ...at(buy, USDC, KSTL), focus: null }).label, "Swap", "no coin in focus: unchanged");
  assert.equal(cta({ ...at(buy, USDC, KSTL) }).label, "Swap");
  assert.equal(cta({ focus: "kstl" }).label, "Swap", "another pair: unchanged");
  // With no amount or over the balance the action's name stays, off, with its reason.
  assert.deepEqual(cta({ ...at(sell, KSTL, USDC), atoms: null, focus: "kstl" }), { label: "Sell KSTL", enabled: false, action: null, busy: false, reason: "Enter an amount." });
  assert.deepEqual(cta({ ...at(sell, KSTL, USDC), atoms: KSTL.atoms + 1n, focus: "kstl" }), { label: "Sell KSTL", enabled: false, action: null, busy: false, reason: "Not enough KSTL for this amount." });
  assert.equal(cta({ ...at(sell, KSTL, USDC), busy: true, focus: "kstl" }).label, "Selling");
  assert.equal(tradeLabel(sell, KSTL, USDC, "kstl"), "Sell 47,604\u00a0KSTL");
});

test("quote figures stay authoritative when wallet prices disagree and amounts exceed floating-point precision", () => {
  const quote = quoteOf({ amount_in: "9007199254740993", amount_out: "123456789", min_out: "120000001", price_impact_bps: 123 });
  const input = { inCoin: { ...SUI, price: 999 }, outCoin: { ...USDC, price: 888 }, snapshot: answered(quote), hidden: false };
  const before = swapPanels(input);
  const after = swapPanels({ ...input, inCoin: { ...input.inCoin, price: 0.001 }, outCoin: { ...input.outCoin, price: 0.002 } });
  assert.equal(before.out.text, after.out.text);
  assert.equal(before.out.text, "123.45");
  assert.equal(typedAmount("9,007,199,254,740,993", 0).typed, "9,007,199,254,740,993");
  assert.equal(tokenAmountAtoms(typedAmount("9007199254740993", 0), { atoms: 0n, decimals: 0 }), 9007199254740993n);
});

test("the swap picker lists held WAL and DEEP even though neither came from Blast", () => {
  const wallet = [
    { ...USDC, key: "wal", coinType: `0x${"8".repeat(64)}::wal::WAL`, symbol: "WAL", name: "Walrus", presale: null },
    { ...SUI, key: "deep", coinType: `0x${"9".repeat(64)}::deep::DEEP`, symbol: "DEEP", name: "DeepBook", presale: null, price: null, value: null },
  ];
  const groups = pickerGroups({ wallet, more: [], pins: [], query: "" });
  assert.deepEqual(groups.map((group) => [group.label, group.coins.map((coin) => coin.symbol)]), [["Your coins", ["WAL", "DEEP"]]]);
  assert.deepEqual(pickerGroups({ wallet, more: [], pins: [], query: "deep" })[0]?.coins.map((coin) => coin.symbol), ["DEEP"]);
});


test("Standalone coin Buy and Sell use the existing swap with coin identity and no presale", () => {
  const coin = { coin_type: KSTL.coinType, symbol: "KSTL", name: "Kestrel", decimals: 9, icon_url: null, usd_price: "0.0021", presale_id: null };
  const view = tradableCoinView(coin);
  assert.equal(view.key, coin.coin_type);
  assert.equal(view.presale, null);
  assert.equal(canTrade(view), true);
  for (const side of ["buy", "sell"] as const) {
    const opening = tradeOpening(encodeTradeAction({side,coin}))!;
    assert.deepEqual(opening.action, {side,coin});
    assert.equal(opening.screen.kind, "trade");
    assert.ok("focus" in opening.screen);
    assert.equal(opening.screen.focus, coin.coin_type);
    assert.deepEqual(opening.pair, side === "buy" ? {in:"usdc",out:coin.coin_type} : {in:coin.coin_type,out:"usdc"});
  }
});

test("amounts stay on one line while coin tickers can wrap", () => {
  const css = readFileSync(new URL("./coins.module.css", import.meta.url), "utf8");
  assert.match(css.match(/^\.amtVal \{[^}]*\}/m)![0], /white-space: nowrap/);
  assert.doesNotMatch(css.match(/^\.tokSymbol \{[^}]*\}/m)![0], /ellipsis|nowrap|overflow: hidden/, "a chip's ticker wraps, never cut");
  // The rate stays readable while it is asked again.
  assert.match(css, /\.txSum \.pending \{ color: var\(--muted\); \}/);
});
