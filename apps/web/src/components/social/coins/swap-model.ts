import { diagnosticMessage, publicErrorCopy } from "#web/lib/errors.ts";
import type { TradeQuoteSnapshot } from "../trade/trade-quotes.ts";
import { EMPTY_TRADE_AMOUNT, tradeSide, tradeTicketCta, type TradeTicketCta, type TradeAmount } from "../trade/trade-ticket.ts";
import { atomsToField } from "#web/components/social/trade/trade-ticket.ts";
import { isRecord } from "../social-api.ts";
import { CORE_COINS, blastV1Coin, coinPriority, coreCoin, PREFERRED_COINS } from "@blast/core/modules/social/portfolio/core-coins.ts";
import { amtExact, divideExact, exactDecimal, fixedExact, groupDigits, pxNumExact, unitsAt, type Exact } from "@blast/core/web/exact-amount.ts";
import { atomsValue, HIDDEN_AMOUNT, NO_VALUE } from "@blast/core/web/format.ts";
import { bpsPercent } from "@blast/core/lib/bps.ts";
import type { SocialTransferFee } from "@blast/core/web/contracts/coins.ts";
import { SUI_COIN_TYPE } from "@blast/core/lib/sui/coin-types.ts";
import { TEST_SUI_COIN_TYPES } from "@blast/core/web/contracts/create.ts";
import { normalizeTradeCoinQuery, SOCIAL_TRADE_DEFAULT_SLIPPAGE_BPS, type SocialTradeCoin, type SocialTradeQuote, type SocialTradeQuoteRequest } from "@blast/core/web/contracts/trades.ts";

import { impactText, impactTone, unavailableText } from "../trades/trade-quote-view";
import { amountWith, coinQuantity, compareHoldings, priceText, type CoinScreen, type WalletCoinView } from "./coin-model";

/**
 * The coins sheet's universal swap (social feed R3-33; FEATURE-MAP-R3 §14.1):
 * any coin for any coin the Cetus aggregator can route — USDC, SUI and every
 * trading Blast sale's coin — as two panels, `You sell` and `You get`, a
 * flip, a token picker and a transaction detail. Pure functions from the
 * wallet read, the picker's coin list and R3-30's quote to the strings the
 * screen renders, so every rule is tested once.
 *
 * **Trade amounts come from the quote** (R3-30): `amount_out`, `min_out`,
 * `price_impact_bps`, `slippage_bps`, the fee, `route_label` and
 * `price_per_out`. The client formats them and compares the quoted dollar
 * values for the payout warning. Amounts stay exact atoms (`bigint`) until
 * they are written as text.
 */

// ---------- coins ----------

/** The picker's full names (the gate's `FULL_NAME`); every other coin reads its own name. */
export const FULL_NAME: Readonly<Record<string, string>> = { usdc: "USD Coin", sui: "Sui" };

export function fullName(coin: Pick<WalletCoinView, "key" | "name">): string {
  return FULL_NAME[coin.key] ?? coin.name;
}

/** A coin a trade can name that the Blast wallet does not hold (the picker's list, a sale page's coin): no atoms, no value. */
export function tradableCoinView(coin: SocialTradeCoin): WalletCoinView {
  const legacy = blastV1Coin(coin.coin_type);
  return {
    key: coin.presale_id ?? coin.coin_type,
    coinType: coin.coin_type,
    symbol: legacy?.symbol ?? coin.symbol,
    name: legacy?.name ?? coin.name,
    decimals: coin.decimals,
    atoms: 0n,
    amount: 0,
    price: coin.usd_price === null ? null : Number(coin.usd_price),
    value: 0,
    iconUrl: legacy?.logoUrl ?? coin.icon_url,
    round: false,
    presale: coin.presale_id === null ? null : { presaleId: coin.presale_id, venue: "", trading: coin.in_presale !== true,
      ...(coin.in_presale ? { inPresale: true, quoteSymbol: coin.quote_symbol, quoteType: coin.quote_type } : {}), multiple: null },
  };
}

/** The curated Sui ecosystem coins as picker rows: each routes through the aggregator, so each can be quoted. */
export const ECOSYSTEM_COIN_VIEWS: readonly WalletCoinView[] = CORE_COINS.map((coin) =>
  tradableCoinView({ coin_type: coin.coinType, symbol: coin.symbol, name: coin.name, decimals: coin.decimals, icon_url: coin.logoUrl, usd_price: null, presale_id: null }),
);

/** Known decimals allow a router quote; sale coins retain their trading gate. */
export function canTrade(coin: Pick<WalletCoinView, "presale" | "metadataAvailable">): boolean {
  return coin.metadataAvailable !== false && (coin.presale === null || coin.presale.trading);
}

// ---------- exact ratios as text ----------

/** `num / den` exactly, or null when either side is not positive. */
function ratio(num: bigint, den: bigint): Exact | null {
  return num <= 0n || den <= 0n ? null : divideExact({ n: num, scale: 0 }, { n: den, scale: 0 });
}

/** An exact ratio as the gate's `amtFmt` writes a number (`amtExact`): `47,604`, `476.04`, `0.292`, `0`. */
export function ratioText(num: bigint, den: bigint): string {
  const value = ratio(num, den);
  return value === null ? "0" : amtExact(value);
}

/** An exact ratio in dollars as the gate's `px` writes a price (`pxNumExact`): `$3.42`, `$0.2109`, `$0.0₁₀6`. */
export function pxRatio(num: bigint, den: bigint): string {
  const value = ratio(num, den);
  return value === null ? "$0" : `$${pxNumExact(value)}`;
}

/** A USD decimal string as the gate writes it, cents rounded down: `$342.00`, `$1,410.34`; anything else reads `—`. */
export function usdText(value: string | null): string {
  const usd = exactDecimal(value);
  return usd === null ? NO_VALUE : `$${groupDigits(fixedExact(usd, 2, "floor"))}`;
}

/** Atoms as a traded amount (`amtExact`): `47,619`, `341.99`, `0.292`, `0`. */
const amountText = (atoms: bigint, decimals: number) => amtExact({ n: atoms, scale: decimals });

// ---------- the amount field ----------

/**
 * The field after a flip (the gate's): what the last quote gave becomes what
 * you sell, rounded — whole from 100, cents below — so flipping back and
 * forth does not drift. Without a quote for this amount the field empties.
 */
export function flippedField(amountOut: bigint | null, decimals: number): TradeAmount {
  if (amountOut === null || amountOut <= 0n) return EMPTY_TRADE_AMOUNT;
  const scale = 10n ** BigInt(decimals);
  const unit = amountOut >= 100n * scale ? scale : decimals >= 2 ? scale / 100n : 1n;
  const rounded = ((amountOut + unit / 2n) / unit) * unit;
  return { typed: atomsToField(rounded > 0n ? rounded : amountOut, decimals), mode: "typed", unit: "token" };
}

// ---------- the pair ----------

export type SwapPair = Readonly<{ in: string; out: string }>;

/** The pair the coin detail's Trade opens: the coin you tapped is the one you sell (the gate), for USDC, or SUI when you tapped USDC. */
export function pairFor(key: string): SwapPair {
  return { in: key, out: key === "usdc" ? "sui" : "usdc" };
}

/**
 * Picking a coin for one side (the gate's `pickCoin`): picking the other
 * side's coin swaps the two. Changing what you sell empties the amount (it
 * was in the old coin's units).
 */
export function pickedPair(pair: SwapPair, side: "in" | "out", key: string): Readonly<{ pair: SwapPair; clear: boolean }> {
  if (side === "in") {
    return { pair: { in: key, out: key === pair.out ? pair.in : pair.out }, clear: key !== pair.in };
  }
  return key === pair.in ? { pair: { in: pair.out, out: key }, clear: true } : { pair: { in: pair.in, out: key }, clear: false };
}

/** The quote request for the pair and amount, or null without one (R3-30's closed body; slippage left to its default). */
export function swapQuoteRequest(inCoin: WalletCoinView, outCoin: WalletCoinView, atoms: bigint | null): SocialTradeQuoteRequest | null {
  if (atoms === null || atoms <= 0n || inCoin.coinType === outCoin.coinType) return null;
  return { in_coin: inCoin.coinType, out_coin: outCoin.coinType, side: tradeSide(inCoin.coinType, outCoin.coinType), amount_in: atoms.toString() };
}

// ---------- the panels ----------

export type SwapPanels = Readonly<{
  /** `≈ $342.00` under what you sell. */
  inUsd: string;
  /**
   * What you get: the quote's amount, else the muted `—` (no amount, the first
   * answer asked, or a failed one: never a `0` that reads as an answer, DS rule 21).
   * `pending` for the last answer kept, faint.
   */
  out: Readonly<{ text: string; muted: boolean; pending: boolean }>;
  /** `≈ $342.00` under what you get; null when you get a dollar coin, whose amount already is its dollar value. */
  outUsd: string | null;
  inBalance: string;
  outBalance: string;
}>;

function balanceText(coin: WalletCoinView, hidden: boolean): string {
  return `Balance ${hidden ? HIDDEN_AMOUNT : amountWith(coinQuantity(atomsValue(coin.atoms, coin.decimals) ?? 0), coin.symbol)}`;
}

/** A dollar stablecoin (USDC, USDsui, suiUSDT…): the curated list's `Stablecoin` category. */
export function dollarCoin(coinType: string): boolean {
  return coreCoin(coinType)?.category === "Stablecoin";
}

/** `≈ $342.00`, or the bare `—` when the dollar value is unknown. */
const approx = (usd: string) => (usd === NO_VALUE ? NO_VALUE : `≈ ${usd}`);

/** A panel's balance line; `Balance —` until the wallet read answers. */
const panelBalance = (coin: WalletCoinView, hidden: boolean, known?: boolean) => (known === false ? `Balance ${NO_VALUE}` : balanceText(coin, hidden));

/**
 * The two panels: the quote's own amounts and dollar values. While the
 * current amount is being asked, the last answer stays, faint; with no
 * answer what you get reads `—`, as does any unknown figure. `hidden` masks the balances,
 * which are holdings; a quote is not.
 */
export function swapPanels(input: Readonly<{ inCoin: WalletCoinView; outCoin: WalletCoinView; snapshot: TradeQuoteSnapshot; hidden: boolean; balanceKnown?: boolean; outBalanceKnown?: boolean }>): SwapPanels {
  const { inCoin, outCoin, snapshot, hidden } = input;
  const live = snapshot.quote !== null && snapshot.quote.unavailable_reason === null ? snapshot.quote : null;
  const faint = live === null && snapshot.key !== null && snapshot.loading && snapshot.shown?.unavailable_reason === null ? snapshot.shown : null;
  const quote = live ?? faint;
  const sameOut = quote !== null && quote.out_coin === outCoin.coinType;
  const amount = quote !== null && sameOut && quote.amount_out !== null ? amountText(BigInt(quote.amount_out), outCoin.decimals) : null;
  // No figure answers the amount (none typed, asked, or failed): the dash, not a `0` that reads as the answer.
  const out = amount ?? NO_VALUE;
  return {
    inUsd: approx(quote !== null && quote.in_coin === inCoin.coinType ? usdText(quote.amount_in_usd) : NO_VALUE),
    out: { text: out, muted: amount === null, pending: faint !== null },
    outUsd: dollarCoin(outCoin.coinType) ? null : approx(quote !== null && sameOut ? usdText(quote.amount_out_usd) : NO_VALUE),
    inBalance: panelBalance(inCoin, hidden, input.balanceKnown),
    outBalance: panelBalance(outCoin, hidden, input.outBalanceKnown ?? input.balanceKnown),
  };
}

// ---------- the transaction detail ----------

/** The collapsed row: the price line and the fee chip (`Free` only when Blast pays, OA-17). */
export type TxSummary = Readonly<{ price: string; gas: string }>;

/** SUI from MIST, as the gate writes an amount: `0.00257`. */
export function suiText(mist: string): string {
  return amtExact({ n: BigInt(mist), scale: 9 });
}

/**
 * The collapsed row (owner, 2026-10-06: the gate's line, replacing R3-33-AC-1's
 * `1 MRDN = $0.10`): `1 <coin you sell> = <rate> <coin you get>` — `1 USDC =
 * 0.292 SUI`, `1 USDC = 476.04 KSTL` — or, when you get USDC, the rate in
 * dollars as the gate's `px` writes it (`1 SUI = $3.42`). The rate is the
 * quote's own: its exact `amount_out ÷ amount_in` in whole coins, divided
 * exactly and rounded as the gate rounds, never a price from elsewhere.
 * Before any answer for the pair the line has no rate (`1 USDC = — SUI`),
 * except that a coin sold for USDC shows its USD price from the wallet read
 * (the gate's `1 SUI = $3.42` before an amount). The chip says who pays the
 * network fee: `Free` only when Blast does; a wallet that pays reads the dry
 * run's estimate in SUI, or `Paid from your SUI`.
 */
export function txSummary(input: Readonly<{
  inCoin: WalletCoinView;
  outCoin: WalletCoinView;
  quote: SocialTradeQuote | null;
  /** The last answer for any amount, whose rate the line keeps while a new amount is asked. */
  shown?: SocialTradeQuote | null;
  walletFee: SocialTransferFee;
}>): TxSummary {
  const { inCoin, outCoin, quote } = input;
  const usdc = outCoin.key === "usdc";
  const rated = [quote, input.shown ?? null].find(
    (candidate): candidate is SocialTradeQuote =>
      candidate != null && candidate.unavailable_reason === null && candidate.in_coin === inCoin.coinType &&
      candidate.out_coin === outCoin.coinType && candidate.amount_in !== null && candidate.amount_out !== null && BigInt(candidate.amount_in) > 0n,
  );
  let rate: string;
  if (rated) {
    const num = BigInt(rated.amount_out!) * 10n ** BigInt(inCoin.decimals);
    const den = BigInt(rated.amount_in!) * 10n ** BigInt(outCoin.decimals);
    rate = usdc ? pxRatio(num, den) : amountWith(ratioText(num, den), outCoin.symbol);
  } else {
    rate = usdc ? (inCoin.price === null ? NO_VALUE : priceText(inCoin.price)) : amountWith(NO_VALUE, outCoin.symbol);
  }
  const payer = quote?.network_fee?.payer ?? (input.walletFee === "sponsored" ? "blast" : "wallet");
  const estimate = quote?.network_fee?.estimate_mist ?? null;
  const gas = payer === "blast" ? "Free" : estimate !== null ? `≈ ${amountWith(suiText(estimate), "SUI")}` : "Paid from your SUI";
  return { price: `${amountWith("1", inCoin.symbol)} = ${rate}`, gas };
}

export type TxRow = Readonly<{ label: string; value: string; tone: "warn" | "down" | null; numeric: boolean }>;

/** Why a quote shows no price impact (OA-29), in the screen's words; nothing stands in for the figure. */
export function impactUnavailableText(reason: SocialTradeQuote["price_impact_unavailable"]): string {
  switch (reason) {
    case "too_small":
      return "Too small to measure";
    case "reference_failed":
      return "Not available right now";
    default:
      return NO_VALUE;
  }
}

export function swapPayoutWarning(quote: SocialTradeQuote | null): string | null {
  if (quote?.amount_out == null || quote.unavailable_reason !== null) return null;

  const sellValue = exactDecimal(quote.amount_in_usd);
  const payoutValue = exactDecimal(quote.amount_out_usd);
  if (sellValue !== null && payoutValue !== null) {
    const scale = Math.max(sellValue.scale, payoutValue.scale);
    const sold = unitsAt(sellValue, scale, "floor");
    const received = unitsAt(payoutValue, scale, "floor");
    if (sold > received) {
      const lossPercent = ((sold - received) * 100n) / sold;
      if (lossPercent >= 10n) return `Low payout. About ${lossPercent}% below the displayed sell value.`;
    }
  }

  return quote.price_impact_bps !== null && impactTone(quote.price_impact_bps) === "down"
    ? "High price impact. Check how much you’ll receive."
    : null;
}

/**
 * The expanded detail's four rows (§14.1): `Price impact` (the quote's, its
 * tone above 3% and 10%, or why there is none), `Max slippage` /
 * `Auto · 0.5%`, `Network fee` (the quote's words, or before a quote the
 * wallet's: `Paid by Blast` when the wallet read says Blast pays) and `Route` (the
 * quote's string, or the gate's helper copy before one). The minimum
 * received and the Blast fee are in `costSentence`, beside the button.
 */
export function txRows(input: Readonly<{ outCoin: WalletCoinView; quote: SocialTradeQuote | null; walletFee: SocialTransferFee }>): readonly TxRow[] {
  const quote = input.quote !== null && input.quote.unavailable_reason === null && input.quote.out_coin === input.outCoin.coinType ? input.quote : null;
  const impact: TxRow = quote?.price_impact_bps != null
    ? { label: "Price impact", value: impactText(quote.price_impact_bps), tone: ((tone) => (tone === "plain" ? null : tone))(impactTone(quote.price_impact_bps)), numeric: true }
    : { label: "Price impact", value: quote ? impactUnavailableText(quote.price_impact_unavailable) : NO_VALUE, tone: null, numeric: true };
  return [
    impact,
    { label: "Max slippage", value: `Auto · ${bpsPercent(quote?.slippage_bps ?? SOCIAL_TRADE_DEFAULT_SLIPPAGE_BPS)}`, tone: null, numeric: false },
    { label: "Network fee", value: quote?.network_fee?.label ?? (input.walletFee === "sponsored" ? "Paid by Blast" : "Paid from your SUI"), tone: null, numeric: false },
    { label: "Route", value: quote?.route_label ?? NO_VALUE, tone: null, numeric: false },
  ];
}

/**
 * The trade in one sentence beside the button, from the live quote:
 * `Sell 1 USDC for at least 1.24 SUI. Blast fee 0.3%.` (`Pay` when the
 * trade buys the coin it was opened for). `min_out` is already net of the
 * Blast fee. When the wallet is short of the coin it sells, the field
 * already shows the balance and the button says `Not enough SUI`, so there
 * is no line; when it is short of SUI for the network fee, the line says
 * what the fee needs and what the wallet holds, which nothing else shows.
 * When the wallet pays the network fee and the dry run priced it, the line
 * ends with it (`Network fee ≈ 0.00257 SUI.`): the whole sentence stays
 * within 20 words. Null until a quote answers this pair with an amount.
 */
export function costSentence(input: Readonly<{ inCoin: WalletCoinView; outCoin: WalletCoinView; quote: SocialTradeQuote | null; focus: string | null; atoms: bigint | null }>): string | null {
  const { inCoin, outCoin, quote } = input;
  // A short wallet: the button is off and the line says `Not enough SUI for this amount.` (the button's reason) instead.
  if (input.atoms !== null && input.atoms > inCoin.atoms) return null;
  if (quote === null || quote.unavailable_reason !== null || quote.in_coin !== inCoin.coinType || quote.out_coin !== outCoin.coinType) return null;
  const short = quote.offer_refused === "insufficient_balance" ? quote.balance_failure : null;
  // Only the network fee's need is said here: no other place on the screen shows it.
  if (short?.reason === "gas") return `The network fee needs ${amountWith(amountText(BigInt(short.required_atoms), 9), "SUI")}. You have ${amountWith(amountText(BigInt(short.available_atoms), 9), "SUI")}.`;
  if (short) return null;
  if (quote.amount_in === null || quote.min_out === null) return null;
  const verb = tradeAction(inCoin, outCoin, input.focus) === "buy" ? "Pay" : "Sell";
  const fee = quote.blast_fee_bps === null ? "" : ` Blast fee ${bpsPercent(quote.blast_fee_bps)}.`;
  const estimate = quote.network_fee?.payer === "wallet" ? quote.network_fee.estimate_mist : null;
  const gas = estimate === null ? "" : ` Network fee ≈ ${amountWith(suiText(estimate), "SUI")}.`;
  return `${verb} ${amountWith(amountText(BigInt(quote.amount_in), inCoin.decimals), inCoin.symbol)} for at least ${amountWith(amountText(BigInt(quote.min_out), outCoin.decimals), outCoin.symbol)}.${fee}${gas}`;
}

// ---------- the button ----------

/**
 * OA-48 (the gate's `tradeTitle`): a trade opened from one coin's Buy or Sell
 * keeps that coin in focus: receiving it buys, spending it sells, with any
 * payment coin. Without the focused coin in the pair, it is a plain swap.
 */
export function tradeAction(inCoin: Pick<WalletCoinView, "key">, outCoin: Pick<WalletCoinView, "key">, focus: string | null): "buy" | "sell" | "trade" {
  if (focus === null || focus === "usdc") return "trade";
  if (outCoin.key === focus) return "buy";
  if (inCoin.key === focus) return "sell";
  return "trade";
}

/** The trade screen's title (OA-48): `Buy KSTL`, `Sell KSTL`, or the Swap board's `Swap`. */
export function tradeTitle(inCoin: Pick<WalletCoinView, "key" | "symbol">, outCoin: Pick<WalletCoinView, "key" | "symbol">, focus: string | null): string {
  const action = tradeAction(inCoin, outCoin, focus);
  return action === "buy" ? `Buy ${outCoin.symbol}` : action === "sell" ? `Sell ${inCoin.symbol}` : "Swap";
}

/**
 * The button, from the quote's own amounts (OA-48, the gate's `tradeCta`):
 * `Buy 47,619 KSTL`, `Sell 47,619 KSTL`, or `Swap`. The amount panels
 * already show both sides, so the action does not repeat the payment.
 */
export function tradeLabel(quote: SocialTradeQuote, inCoin: WalletCoinView, outCoin: WalletCoinView, focus: string | null = null): string {
  const given = amountWith(amountText(BigInt(quote.amount_in ?? "0"), inCoin.decimals), inCoin.symbol);
  const got = amountWith(amountText(BigInt(quote.amount_out ?? "0"), outCoin.decimals), outCoin.symbol);
  switch (tradeAction(inCoin, outCoin, focus)) {
    case "buy":
      return `Buy ${got}`;
    case "sell":
      return `Sell ${given}`;
    default:
      return "Swap";
  }
}

/** While the first answer for an amount is asked: the indicator's accessible name, never the button's visible words. */
export const FINDING_PRICE = "Finding the best price";

/**
 * The button (§14.1), a short verb (KA-6): `Sign in` for a visitor (the line
 * above says `Sign in to swap.`); in every
 * off state the action's name (`Swap`, `Buy …`, `Sell …`), off, with why on
 * the line above as its `reason` (DS rule 18): `Enter an amount.`, `Not enough
 * ${symbol} for this amount.`, no route, a wallet that did not load or is not
 * ready. After a failure the button is the verb, off, for a moment while the
 * line above says what failed, with its code. `Swapping` (`Buying`,
 * `Selling`) while the trade runs, and the verb on only for a quote that was
 * offered (dry-run from this wallet) and has not expired. When the wallet pays
 * the network fee, the button still says `Swap` and the money sentence names
 * the fee. While a quote is in flight or stale the button is off (R3-33-AC-6).
 */
export function swapCta(input: Readonly<{
  signedIn: boolean;
  sessionPending?: boolean;
  balanceKnown?: boolean;
  inCoin: WalletCoinView;
  outCoin: WalletCoinView;
  atoms: bigint | null;
  snapshot: TradeQuoteSnapshot;
  nowMs: number;
  /** `trading` from the press until the outcome. */
  busy: boolean;
  /** A trade just failed: the button is off for a moment while the line above says what failed. */
  failed: boolean;
  /** OA-48: the coin a Buy or Sell opened the trade for (`tradeLabel`); none for a plain swap. */
  focus?: string | null;
  /** The snapshot is the browser's estimate (`tradeTicketCta`). */
  estimate?: boolean;
}>): TradeTicketCta {
  const { inCoin, outCoin, atoms, snapshot } = input;
  const title = tradeTitle(inCoin, outCoin, input.focus ?? null);
  return tradeTicketCta({ ...input, amount: atoms, overBalance: atoms !== null && atoms > inCoin.atoms }, {
    label: title,
    quotedLabel: snapshot.quote === null ? title : tradeLabel(snapshot.quote, inCoin, outCoin, input.focus ?? null),
    busyLabel: progressVerb(title),
    signIn: { label: "Sign in", reason: "Sign in to swap." },
    emptyReason: "Enter an amount.",
    walletReason: "Your Blast wallet isn’t ready yet.",
    insufficient: (gas) => gas ? {} : { reason: `Not enough ${inCoin.symbol} for this amount.` },
    unavailable: (reason) => reason === "no_pool" ? "No market for this trade yet. Choose a different token." : `${unavailableText(reason)}.`,
  });
}

/** The button's verb while it runs: `Buy …` buys, `Sell …` sells, else a swap. */
export function progressVerb(title: string): string {
  return title.startsWith("Buy ") ? "Buying" : title.startsWith("Sell ") ? "Selling" : "Swapping";
}

/** How long a failure's words stay on the button before it reads the quote again (the gate's 2.2 s). */
export const FAILURE_SHOWN_MS = 2_200;

// ---------- the picker ----------

export type PickerGroup = Readonly<{ label: string; coins: readonly WalletCoinView[] }>;

/** The picker's search over names, tickers and coin types. */
export function pickerQuery(text: string): string {
  return normalizeTradeCoinQuery(text);
}

export function pickerMatch(coin: WalletCoinView, query: string): boolean {
  const type = normalizeTradeCoinQuery(coin.coinType).toLowerCase();
  const search = query.toLowerCase();
  return search === "" ||
    fullName(coin).toLowerCase().includes(search) ||
    coin.symbol.toLowerCase().includes(search) ||
    (coreCoin(coin.coinType)?.symbol.toLowerCase().includes(search) ?? false) ||
    (search.startsWith("0x") && (type.includes(search) ||
      type.replace(/0x0+([0-9a-f])/g, "0x$1").includes(search)));
}

export function visibleInSwapPicker(coin: WalletCoinView): boolean {
  return !TEST_SUI_COIN_TYPES.includes(normalizeTradeCoinQuery(coin.coinType)) &&
    !TEST_SUI_COIN_TYPES.includes(normalizeTradeCoinQuery(coin.presale?.quoteType ?? ""));
}

/**
 * The picker's list (the gate's `tpListHTML`): `Your coins` — all
 * coins the wallet holds, by USD value —
 * then `More coins` (`Coins` when none of yours is listed): USDC and SUI when
 * you hold none, then every other trading sale's coin, as the coins route
 * lists them.
 */
export function pickerGroups(input: Readonly<{
  wallet: readonly WalletCoinView[];
  more: readonly WalletCoinView[];
  pins: readonly string[];
  query: string;
}>): readonly PickerGroup[] {
  const query = pickerQuery(input.query);
  const offered = new Map(input.more.filter((coin) => coin.presale?.inPresale).map((coin) => [coin.coinType, coin]));
  const heldAll = input.wallet.filter((coin) => coin.atoms > 0n).map((coin) => offered.has(coin.coinType) ? { ...coin, presale: offered.get(coin.coinType)!.presale } : coin);
  const byValue = [...heldAll].sort(compareHoldings);
  const held = byValue.filter((coin) => pickerMatch(coin, query));
  const listed = new Set(heldAll.map((coin) => coin.coinType));
  const rest: WalletCoinView[] = [];
  for (const coin of [...input.wallet.filter((each) => each.presale === null), ...input.more]) {
    if (listed.has(coin.coinType)) continue;
    listed.add(coin.coinType);
    if (pickerMatch(coin, query)) rest.push(coin);
  }
  const groups: PickerGroup[] = [];
  if (held.length) groups.push({ label: "Your coins", coins: held });
  // Unsearched, Blast's own coins follow the preferred coins and the rest of the curated catalog trails them; a search leads with curated matches, as the server does.
  const rank = (coin: WalletCoinView) => {
    const priority = coinPriority(coin.coinType);
    if (query || priority < PREFERRED_COINS.length) return priority;
    return coreCoin(coin.coinType) ? PREFERRED_COINS.length + 1 : PREFERRED_COINS.length;
  };
  // The gate's wording: `More coins` under your coins, `Coins` when none of yours is listed (none held, or none matching).
  if (rest.length) groups.push({ label: held.length ? "More coins" : "Coins", coins: rest.sort((a, b) => rank(a) - rank(b)) });
  return groups;
}

/** `No coins match “xyz”.`, with curly quotes. */
export function noMatchText(text: string): string {
  return `No coins match “${text.trim()}”.`;
}

/** A picker row's figures: what you hold (`$1,410` over `412.38`), or the coin's price when you hold none. */
export function pickerFigures(coin: WalletCoinView, hidden: boolean): Readonly<{ value: string; amount: string | null }> {
  if (coin.atoms > 0n) {
    return { value: hidden ? HIDDEN_AMOUNT : coin.value === null ? "—" : `$${groupDigits(String(Math.round(coin.value)))}`, amount: hidden ? HIDDEN_AMOUNT : coinQuantity(coin.amount) };
  }
  return { value: coin.key === "usdc" ? "$1.00" : coin.price === null ? "—" : priceText(coin.price), amount: null };
}

// ---------- the shell action ----------

/** `openTrade`'s argument (a sale page's Buy and Sell, R3-34): the side and the sale's coin as its own read names it. */
export type TradeAction = Readonly<{ side: "buy" | "sell"; coin: SocialTradeCoin }>;

export function encodeTradeAction(action: TradeAction): string {
  return JSON.stringify(action);
}

export function decodeTradeAction(text: string | undefined): TradeAction | null {
  if (!text) return null;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(value) || (value.side !== "buy" && value.side !== "sell") || !isRecord(value.coin)) return null;
  const coin = value.coin;
  const ok =
    typeof coin.coin_type === "string" && typeof coin.symbol === "string" && typeof coin.name === "string" &&
    Number.isSafeInteger(coin.decimals) && (coin.icon_url === null || typeof coin.icon_url === "string") &&
    (coin.usd_price === null || typeof coin.usd_price === "string") && (coin.presale_id === null || typeof coin.presale_id === "string");
  return ok ? { side: value.side, coin: coin as unknown as SocialTradeCoin } : null;
}

/** The pair a sale page's Buy or Sell opens: Buy spends USDC on the coin, Sell turns the coin into USDC (the gate's `openSaleTrade`). */
export function salePair(action: TradeAction): SwapPair {
  // SUI's wallet key is "sui", like its balance row, so the SUI page swaps against USDC.
  const key = action.coin.presale_id ?? (action.coin.coin_type === SUI_COIN_TYPE ? "sui" : action.coin.coin_type);
  return action.side === "sell" ? { in: key, out: "usdc" } : { in: "usdc", out: key };
}

/**
 * The plain swap's pair (Blast mode's dock `Swap`): the gate's
 * `bxDrawerCoin('trade')`, whose `coinFlow` sells USDC for SUI (`inK: 'usdc'`,
 * `outK: 'sui'`) until either side is picked.
 */
export const PLAIN_SWAP_PAIR: SwapPair = Object.freeze({ in: "usdc", out: "sui" });

/**
 * What the shell's `openTrade` opens: with no argument the plain swap; with a
 * sale page's Buy or Sell (`encodeTradeAction`) that sale's pair, and its coin
 * for the picker (the wallet may not hold it); anything else, nothing.
 * `screen` is the trade screen it opens on: a Buy or Sell keeps the sale's
 * coin in focus, so the screen is named for it (OA-48); the plain swap has none.
 */
export function tradeOpening(argument: string | undefined): Readonly<{ pair: SwapPair; action: TradeAction | null; screen: CoinScreen }> | null {
  if (argument === undefined) return { pair: PLAIN_SWAP_PAIR, action: null, screen: { kind: "trade", key: PLAIN_SWAP_PAIR.in, out: PLAIN_SWAP_PAIR.out } };
  const action = decodeTradeAction(argument);
  if (action === null) return null;
  const pair = salePair(action);
  return { pair, action, screen: { kind: "trade", key: pair.in, out: pair.out, focus: action.coin.presale_id ?? action.coin.coin_type } };
}

const PRICES_UNAVAILABLE = "Couldn’t get a price. Try again.";
/** An outage is asked again on its own every 5 s (`tradeQuoteDueInMs`), so the line says so instead of asking for a retry. */
const PRICES_RETRYING = "Couldn’t get a price. Checking again…";

/**
 * Why there is no price, when the read failed, with what to do next (WS-4); a short
 * balance is the off button's reason on the line above it, said once. An outage reads
 * that prices are asked again (they are, every 5 s), an unknown failure the prices'
 * own sentence, never the generic "temporarily unavailable"; the code line stays
 * under it (docs/errors.md).
 */
export function quoteDiagnostic(snapshot: Pick<TradeQuoteSnapshot, "error" | "loading">): string | null {
  if (snapshot.error === null || snapshot.loading) return null;
  const { code } = snapshot.error;
  const text = code === "service_unavailable" ? PRICES_RETRYING : code === null ? PRICES_UNAVAILABLE : publicErrorCopy(code, PRICES_UNAVAILABLE);
  return diagnosticMessage(text, snapshot.error);
}
