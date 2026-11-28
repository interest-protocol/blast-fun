"use client";
import { focusAfterDelay } from "#web/lib/deferred-focus.ts";
import { AmountPresets } from "./AmountPresets.tsx";
import { exactText, groupDigits } from "@blast/core/web/exact-amount.ts";

import { instantFeedback } from "#web/components/blast-ui/feedback-motion.ts";
import { EASE_OUT_ARRAY, T2 } from "#web/components/blast-ui/motion-tokens.ts";
import { Collapse } from "#web/components/blast-ui/Collapse.tsx";
import { Button, DisclosureButton } from "#web/components/blast-ui/Button.tsx";

import { SkeletonLine } from "#web/components/blast-ui/Skeleton.tsx";
import { LoadingIndicator } from "#web/components/blast-ui/LoadingIndicator.tsx";
import { DiagnosticText } from "#web/components/blast-ui/DiagnosticText.tsx";
import { diagnosticMessage, publicErrorMessage } from "#web/lib/errors.ts";
import { isOffered, sealRefusalLine } from "../trades/trade-quote-view";

import clsx from "clsx";
import { useAnimate } from "motion/react";
import { useEffect, useEffectEvent, useId, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";

import type { SocialTransferFee } from "@blast/core/web/contracts/coins.ts";
import type { SocialTradeQuote, TradeFeeRequired } from "@blast/core/web/contracts/trades.ts";

import { CoinMark } from "#web/components/blast-ui/CoinMark.tsx";
import { TickerText } from "#web/components/blast-ui/Ticker.tsx";
import type { WalletCoinView } from "./coin-model";
import styles from "./coins.module.css";
import { FlipIcon, KnowCheckIcon } from "./icons";
import { AmountFit } from "#web/components/blast-ui/AmountFit.tsx";
import { quoteDiagnostic, canTrade, costSentence, FINDING_PRICE, flippedField, progressVerb, quoteWithUsd, swapCta, swapPanels, swapPayoutWarning, swapQuoteRequest, tradeAction, tradeTitle, txRows, txSummary } from "./swap-model";
import { useQuoteUsd } from "../prices/use-quote-usd.ts";
import { useTradeQuoteQuery } from "../trade/trade-quote-query.ts";
import { tradeQuoteReader, type TradeQuoteRequester } from "../trades/trades-client.ts";
import { estimateReads, usdPriceText, type TradeRouteFinder } from "../trade/trade-estimate.ts";
import { TRADE_QUOTE_SHOWN_REFRESH_MS, tradeRequestKey, type TradeQuoteSnapshot } from "../trade/trade-quotes.ts";
import { tokenAmountAtoms, selectedSellPreset, sellPresetAmount, typedAmount, type TradeAmount } from "../trade/trade-ticket.ts";
import { decimalText, dropDecimal, pasteDecimal } from "#web/lib/decimal-input.ts";
import { useAppQueryClient } from "#web/lib/query/provider.tsx";
import { refreshWalletCoinBalance, useWalletCoinBalance } from "./use-wallet-coin-balance";

/** What the sheet asks its host to trade: the quote the button showed, pinned (R3-31). */
export type TradeAsk = Readonly<{
  quote: SocialTradeQuote;
  inCoin: WalletCoinView;
  outCoin: WalletCoinView;
  /** One per quote the person pressed for; the same again when they accept the fee. */
  idempotencyKey: string;
  /** Pay the network fee from the wallet's SUI (after `fee_required`). */
  acceptFee: boolean;
}>;

/**
 * How a trade ended, for the sheet. `traded` settles on the button before
 * resetting the amounts; `pending` closes with the host's toast; `fee_required` asks the person to
 * pay the fee themselves; `failed` keeps a readable alert until the amount changes.
 */
export type TradeOutcome =
  | Readonly<{ status: "traded" }>
  | Readonly<{ status: "pending" }>
  | TradeFeeRequired
  | Readonly<{ status: "failed"; message: string; code: string | null }>;

/** The coins sheet's trading capabilities, from its host (`CoinsHost`) or a fixture. */
export type CoinSheetTrading = Readonly<{
  /** A visitor sees `Sign in to trade`; the press opens the sign-in sheet. */
  signedIn: boolean;
  sessionPending?: boolean;
  balanceKnown?: boolean;
  /** The authenticated signer address, or null while the host resolves it. Standalone fixtures can supply their balances directly. */
  walletAddress?: string | null;
  onSignIn: () => void;
  /** R3-30's quote route, through the shared session helper: the sealed quote requested on press. */
  requestQuote: TradeQuoteRequester;
  /** The browser's route for the estimate shown while typing (`trade-estimate.ts`); without one, the estimate is the server's quote, shown only. */
  findRoute?: TradeRouteFinder;
  /** The picker's coins a trade can name (`GET /api/social/trades/coins`), as sheet coins; null when the read failed. */
  listCoins: (query: string | null, signal: AbortSignal, cursor?: string | null) => Promise<readonly WalletCoinView[] | import("./coin-model").WalletCoinCatalogPage | null>;
  /** R3-31's trade: build, sign, execute, settle. */
  trade: (ask: TradeAsk) => Promise<TradeOutcome>;
}>;

const newKey = () => crypto.randomUUID();
/** "Successful" holds on the button at least this long (MA-8), so it can be read before the form resets. */
export const SWAP_SUCCESS_MS = 4_000;

/** The minimum and warning that were on screen when the user pressed Swap. */
type Seal = Readonly<{ key: string | null; press: number; minOut: bigint; warning: string | null }>;

/**
 * The trade screen's body (FEATURE-MAP-R3 §14.1): `You sell` with its coin
 * chip, its presets, the flip, `You get`, the trade's cost in one sentence,
 * the button, and under it the one-line detail that opens into four rows. Every figure is the quote's (`swap-model.ts`);
 * the quotes are asked and kept fresh by `useTradeQuoteQuery`.
 */
function quoteWithWalletFee(quote: SocialTradeQuote | null, mist: string | null): SocialTradeQuote | null {
  if (quote === null || mist === null) return quote;
  return { ...quote, network_fee: { payer: "wallet", label: "Paid from your SUI", estimate_mist: mist } };
}

/** A sent trade still confirming: the line beside the off button (DS rule 18). */
const PENDING_LINE = "Waiting for your wallet. Check it before you trade again.";
/** The line beside the button while a balance it needs is read. */
const BALANCE_CHECK_LINE = "Checking your balance…";
const offeredNow = (quote: SocialTradeQuote) => isOffered(quote, Date.now());

const PRICE_CHANGED_LINE = "The price changed before sending. Nothing was sent.";
const PRICE_MOVED_LINE = "Price changed. Review the new minimum.";
/** A press whose sealed quote could not be asked (busy, offline): nothing is asked again until the next press. */
export const SEAL_FAILED_LINE = "The price could not be confirmed. Nothing was sent. Press to try again.";

/** The estimate is kept fresh while it is on screen (never while the tab is hidden). */
const ESTIMATE_POLICY = { shownRefreshMs: TRADE_QUOTE_SHOWN_REFRESH_MS } as const;

function activeQuoteRequest(active: boolean, inCoin: WalletCoinView, outCoin: WalletCoinView, atoms: bigint | null) {
  if (!active || !canTrade(inCoin) || !canTrade(outCoin)) return null;
  return swapQuoteRequest(inCoin, outCoin, atoms);
}

/** A failure kept for its amount. A retryable failure allows a fresh press. */
type Failure = Readonly<{ key: string | null; message: string; retry?: boolean }>;

function useSuccessFocus(successful: boolean, active: boolean, scope: RefObject<HTMLDivElement | null>, inputRef: RefObject<HTMLInputElement | null>) {
  const wasSuccessful = useRef(false);
  useEffect(() => {
    if (wasSuccessful.current && !successful && active && (document.activeElement === document.body || document.activeElement === scope.current?.querySelector("[data-trade]"))) {
      inputRef.current?.focus({ preventScroll: true });
    }
    wasSuccessful.current = successful;
  }, [successful, active, scope, inputRef]);
}

/** Each flip carries on the previous rotation, with reduced motion respected. */
function useSwapFlipMotion(flips: number, scope: RefObject<HTMLDivElement | null>, animate: ReturnType<typeof useAnimate<HTMLDivElement>>[1]) {
  useLayoutEffect(() => {
    if (flips === 0 || !scope.current) return;
    const button = scope.current.querySelector<HTMLElement>("[data-flip]");
    if (button) button.style.transform = `rotate(${flips * 180}deg)`;
    if (instantFeedback()) return;
    const panels = scope.current.querySelectorAll("[data-panel]");
    panels.forEach((panel, index) => animate(panel, { opacity: [0.6, 1], transform: [`translateY(${index ? -4 : 4}px)`, "translateY(0px)"] }, { duration: T2 / 1000, ease: EASE_OUT_ARRAY }));
  }, [flips, animate, scope]);
}

/** Quote presentation is derived once, keeping fee consent and failures tied to their amount. */
function swapDisplay({ inLine, outLine, inCoin, outCoin, snapshot, hidden, key, fee, failure, walletFee, focus, atoms }: Readonly<{
  inLine: ShownBalance; outLine: ShownBalance;
  inCoin: WalletCoinView; outCoin: WalletCoinView; snapshot: TradeQuoteSnapshot; hidden: boolean;
  key: string | null; fee: Readonly<{ key: string | null; mist: string }> | null; failure: Failure | null;
  walletFee: SocialTransferFee; focus: string | null; atoms: bigint | null;
}>) {
  const quoteError = quoteDiagnostic(snapshot);
  const panels = swapPanels({ inCoin: inLine.coin, outCoin: outLine.coin, snapshot, hidden, balanceKnown: inLine.known, outBalanceKnown: outLine.known });
  const effectiveFee = fee?.key === key ? fee : null;
  const quote = quoteWithWalletFee(snapshot.quote, effectiveFee?.mist ?? null);
  const effectiveWalletFee = effectiveFee === null ? walletFee : "wallet";
  const shownFailure = failure?.key === key ? failure : null;
  // While a new amount is asked, the line keeps the last answer's rate for this pair (the panels keep it, faint).
  const summary = txSummary({ inCoin, outCoin, quote, shown: quote === null && snapshot.loading ? snapshot.shown : null, walletFee: effectiveWalletFee });
  const rows = txRows({ outCoin, quote, walletFee: effectiveWalletFee });
  const rateState: "failed" | "asking" | "live" = quoteError !== null ? "failed" : quote === null && snapshot.loading ? "asking" : "live";
  // When Blast can't sponsor today the money sentence names the fee the wallet pays (the quote carries it); the button keeps its verb.
  const money = costSentence({ inCoin, outCoin, quote, focus, atoms });
  return { panels, quote, quoteError, shownFailure, summary, rows, rateState, money };
}

/** Hold the estimate while a press requests its sealed quote for the same amount. */
function useSwapQuotes({ active, inCoin, outCoin, atoms, locked, trading }: Readonly<{
  active: boolean;
  inCoin: WalletCoinView;
  outCoin: WalletCoinView;
  atoms: bigint | null;
  locked: boolean;
  trading: CoinSheetTrading;
}>) {
  const request = activeQuoteRequest(active, inCoin, outCoin, atoms);
  const key = tradeRequestKey(request);
  const [pressed, setPressed] = useState<Seal | null>(null);
  const serverQuote = tradeQuoteReader(trading.requestQuote);
  const estimate = useTradeQuoteQuery({
    ...estimateReads(trading.findRoute, [inCoin, outCoin], serverQuote),
    request,
    held: locked || pressed !== null,
    active,
    scope: "estimate",
    policy: ESTIMATE_POLICY,
  });
  const seal = active && pressed !== null && pressed.key === key ? pressed : null;
  if (pressed !== null && seal === null) setPressed(null);
  // Per mount, so a press never joins a sealed quote cached by an earlier mount of the sheet.
  const [mount] = useState(newKey);
  const sealed = useTradeQuoteQuery({ read: serverQuote, request: seal === null ? null : request, now: true, held: true, active, scope: `seal:${mount}:${seal?.press ?? 0}` });
  // Show the sealed answer until the press ends or the amount changes.
  const live = seal !== null && (sealed.quote !== null || sealed.error !== null) ? sealed : estimate;
  return { key, estimate, sealed, seal, live, setPressed };
}

/**
 * The payout warning to show. Once the sealed quote asks about a new one, the press keeps that question:
 * a display price that later changes or goes missing must not answer it for the user.
 */
function usePayoutWarning(seal: Seal | null, answered: boolean, quote: SocialTradeQuote | null, locked: boolean) {
  const [kept, setKept] = useState<Readonly<{ press: number; warning: string }> | null>(null);
  const live = locked ? null : swapPayoutWarning(quote);
  const asked = !locked && seal !== null && kept?.press === seal.press ? kept.warning : null;
  if (seal !== null && answered && asked === null && live !== null && live !== seal.warning) setKept({ press: seal.press, warning: live });
  return { warning: live ?? asked, asked: asked !== null };
}

function swapReview(seal: Seal | null, quote: SocialTradeQuote | null, cta: ReturnType<typeof swapCta>, asked: boolean) {
  if (seal === null || quote?.min_out == null || !cta.enabled || cta.action !== "trade") return null;
  if (BigInt(quote.min_out) < seal.minOut) return PRICE_MOVED_LINE;
  return asked ? "Review the payout before confirming." : null;
}

/** What a side's balance line shows: the coin with its number, if there is one to show. Display only; spending reads `useSwapInputBalance`. */
type ShownBalance = Readonly<{ coin: WalletCoinView; known: boolean }>;

/** The number on screen: the fresh one, else the last one while it is read again. */
function shownAtoms(read: ReturnType<typeof useWalletCoinBalance>): bigint | undefined {
  if (read.status === "ready") return read.atoms;
  return read.status === "loading" ? read.lastAtoms : undefined;
}

/** One side's balance, read the same way for both coins. */
function useSwapSideBalance(trading: CoinSheetTrading, coin: WalletCoinView, active: boolean) {
  const read = useWalletCoinBalance(trading.walletAddress, coin.coinType, active && trading.signedIn && !trading.sessionPending);
  const held = shownAtoms(read);
  let line: ShownBalance = { coin, known: false };
  if (trading.walletAddress === undefined) line = { coin, known: trading.balanceKnown ?? trading.signedIn };
  else if (held !== undefined) line = { coin: { ...coin, atoms: held }, known: true };
  return { read, line };
}

function useSwapInputBalance(trading: CoinSheetTrading, selectedCoin: WalletCoinView, field: TradeAmount, active: boolean) {
  const queries = useAppQueryClient();
  const walletAddress = trading.walletAddress;
  const usesExactBalance = walletAddress !== undefined;
  const { read: walletBalance, line } = useSwapSideBalance(trading, selectedCoin, active);
  const known = usesExactBalance ? walletBalance.status === "ready" : trading.balanceKnown ?? trading.signedIn;
  const inCoin = walletBalance.status === "ready" ? { ...selectedCoin, atoms: walletBalance.atoms } : selectedCoin;
  const needsBalance = usesExactBalance && !known && field.mode !== "typed" && field.fixedAtoms === undefined;
  const status = walletBalance.status;
  const retry = status === "unavailable" ? walletBalance.retry : null;
  const refresh = (coinType?: string) => {
    if (walletAddress) void refreshWalletCoinBalance(queries, walletAddress, coinType ?? inCoin.coinType);
  };
  return { inCoin, line, balanceKnown: known, usesExactBalance, balanceStatus: status, atoms: needsBalance ? null : tokenAmountAtoms(field, inCoin), retryBalance: retry, refreshBalance: refresh };
}

/**
 * A coin's dollar price, to fill the values a quote came without: its own, else the app's price read,
 * which is null while old or unknown. Only a coin with no price of its own is asked about.
 */
function useSwapSidePrice(coin: WalletCoinView, active: boolean) {
  const market = useQuoteUsd(active && coin.price === null ? coin.coinType : null);
  return { coinType: coin.coinType, decimals: coin.decimals, usdPrice: usdPriceText(coin.price) ?? market };
}

function swapBalanceAction(trading: CoinSheetTrading, active: boolean, balance: ReturnType<typeof useSwapInputBalance>, action: ReturnType<typeof swapCta>) {
  const { usesExactBalance, balanceStatus } = balance;
  const pending = usesExactBalance && active && (trading.sessionPending === true || balanceStatus === "loading");
  const failed = usesExactBalance && trading.signedIn && !pending && balanceStatus === "unavailable";
  return { pending, action: failed ? { ...action, reason: "Your balance could not load." } : action };
}

function swapButtonView(cta: ReturnType<typeof swapCta>, title: string, balancePending: boolean, confirming: boolean, pending: boolean, money: string | null) {
  if (balancePending) return { action: { ...cta, label: title, enabled: false }, cost: pending ? PENDING_LINE : BALANCE_CHECK_LINE };
  return { action: confirming ? { ...cta, label: "Confirm swap" } : cta, cost: pending ? PENDING_LINE : cta.reason ?? money };
}

function useSwapFormControls({
  active,
  inCoin: selectedCoin,
  outCoin,
  field,
  onField,
  detail,
  onDetail,
  focus = null,
  onFlip,
  onPick,
  trading,
  walletFee,
  hidden,
  focusAmount = true,
  persistent = false,
}: Readonly<{
  active: boolean;
  persistent?: boolean;
  inCoin: WalletCoinView;
  outCoin: WalletCoinView;
  field: TradeAmount;
  onField: (next: TradeAmount) => void;
  detail: boolean;
  onDetail: (open: boolean) => void;
  /** OA-48: the coin a Buy or Sell opened the trade for, which names the button `Buy …` / `Sell …`. */
  focus?: string | null;
  /** Swap the two sides; `field` is what you sell next (the last quote's output). */
  onFlip: (field: TradeAmount) => void;
  onPick: (side: "in" | "out") => void;
  trading: CoinSheetTrading;
  walletFee: SocialTransferFee;
  hidden: boolean;
  focusAmount?: boolean;
}>) {
  const id = useId();
  const [busy, setBusy] = useState(false);
  const [confirmedQuote, setConfirmedQuote] = useState<SocialTradeQuote | null>(null);
  const successful = confirmedQuote !== null;
  const [pending, setPending] = useState(false);
  const locked = busy || successful || pending;
  const [failure, setFailure] = useState<Failure | null>(null);
  const balance = useSwapInputBalance(trading, selectedCoin, field, active);
  const { inCoin, balanceKnown, usesExactBalance, balanceStatus, atoms, retryBalance, refreshBalance } = balance;
  const { read: outRead, line: outLine } = useSwapSideBalance(trading, outCoin, active);
  const inPrice = useSwapSidePrice(inCoin, active);
  const outPrice = useSwapSidePrice(outCoin, active);
  const [fee, setFee] = useState<Readonly<{ key: string | null; mist: string }> | null>(null);
  const { key, estimate, sealed, seal, live, setPressed } = useSwapQuotes({ active, inCoin, outCoin, atoms, locked, trading });
  const { nowMs } = live;
  const snapshot = confirmedQuote === null ? live : { ...live, quote: confirmedQuote, loading: false, error: null };
  const keys = useRef(new Map<string, string>());
  const inputRef = useRef<HTMLInputElement>(null);
  const [scope, animate] = useAnimate<HTMLDivElement>();
  const [flips, setFlips] = useState(0);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useSuccessFocus(successful, active, scope, inputRef);

  const reset = useEffectEvent(() => {
    onField(typedAmount("", inCoin.decimals));
    onDetail(false);
    setConfirmedQuote(null);
    setFee(null);
    setFailure(null);
    keys.current.clear();
  });
  useEffect(() => {
    if (!successful || !active) return;
    const timer = setTimeout(() => reset(), SWAP_SUCCESS_MS);
    return () => clearTimeout(timer);
  }, [successful, active]);

  useEffect(() => {
    if (!focusAmount) return;
    return focusAfterDelay(() => inputRef.current, 60, { preventScroll: true });
  }, [focusAmount]);

  useSwapFlipMotion(flips, scope, animate);

  // Filled as the screen is drawn: a cached quote does not change when a price arrives later.
  const priced = { ...snapshot, quote: quoteWithUsd(snapshot.quote, inPrice, outPrice), shown: quoteWithUsd(snapshot.shown, inPrice, outPrice) };
  const { panels, quote, quoteError, shownFailure, summary, rows, rateState, money } = swapDisplay({ inLine: balance.line, outLine, inCoin, outCoin, snapshot: priced, hidden, key, fee, failure, walletFee, focus, atoms });
  const swapAction = swapCta({
    signedIn: trading.signedIn,
    sessionPending: trading.sessionPending,
    balanceKnown: usesExactBalance ? balanceKnown : trading.balanceKnown,
    inCoin,
    outCoin,
    atoms,
    snapshot,
    nowMs,
    busy,
    failed: shownFailure !== null && shownFailure.retry !== true,
    focus,
    estimate: live === estimate,
  });
  const { pending: balancePending, action: cta } = swapBalanceAction(trading, active, balance, swapAction);
  const { warning, asked } = usePayoutWarning(seal, sealed.quote !== null, quote, locked);
  const review = swapReview(seal, sealed.quote, cta, asked);
  const waiting = seal !== null && !locked && review === null;
  const title = tradeTitle(inCoin, outCoin, focus);
  const { action, cost } = swapButtonView(cta, title, balancePending, review !== null, pending, money);
  const verb = progressVerb(title);

  const flip = () => {
    const out = quote !== null && quote.out_coin === outCoin.coinType && quote.amount_out !== null ? BigInt(quote.amount_out) : null;
    setFailure(null);
    setFee(null);
    onFlip(flippedField(out, outCoin.decimals));
    setFlips((count) => count + 1);
    inputRef.current?.focus({ preventScroll: true });
  };

  const presses = useRef(0);
  const sentPress = useRef(0);
  const endPress = (message: string) => {
    setFailure({ key, message, retry: true });
    setPressed(null);
  };

  const press = () => {
    if (!active || locked || waiting || !cta.enabled) return;
    if (cta.action === "sign-in") {
      trading.onSignIn();
      return;
    }
    if (quote === null || quote.amount_out === null || quote.min_out === null) return;
    if (review !== null && seal !== null) {
      if (offeredNow(quote)) void trade(seal, quote);
      else endPress(PRICE_CHANGED_LINE);
      return;
    }
    setFailure(null);
    presses.current += 1;
    setPressed({ key, press: presses.current, minOut: BigInt(quote.min_out), warning });
  };

  const trade = async (confirmedPress: Seal, quote: SocialTradeQuote) => {
    if (quote.quote_id === null || sentPress.current === confirmedPress.press) return;
    sentPress.current = confirmedPress.press;
    const acceptFee = fee !== null && fee.key === key;
    const idempotencyKey = keys.current.get(quote.quote_id) ?? newKey();
    keys.current.set(quote.quote_id, idempotencyKey);
    setBusy(true);
    const outcome = await trading.trade({ quote, inCoin, outCoin, idempotencyKey, acceptFee }).catch((error): TradeOutcome => ({ status: "failed", code: "execution_unconfirmed", message: publicErrorMessage(error, "This trade could not be confirmed. Check your wallet before retrying.", "execution_unconfirmed") })).finally(() => {
      if (mounted.current) {
        setBusy(false);
        setPressed(null);
      }
    });
    if (!mounted.current) return;
    if (outcome.status === "traded") {
      // The balances moved: the next estimate is asked afresh.
      estimate.invalidate();
      setConfirmedQuote(quote);
      return;
    }
    if (outcome.status === "pending" && persistent) {
      setPending(true);
      return;
    }
    if (outcome.status === "fee_required") {
      setFee({ key, mist: outcome.feeMist });
      if (outcome.payable === false) setFailure({ key, message: outcome.message ?? "Add native SUI to pay the network fee." });
      return;
    }
    if (outcome.status !== "failed") return;
    const insufficient = outcome.code === "insufficient_balance";
    setFailure({ key, message: outcome.message, retry: insufficient });
    // The quote moved or lapsed: the estimate is asked again, and the next press seals afresh.
    if (outcome.code === "price_moved" || outcome.code === "quote_expired") estimate.refresh({ cancel: true });
  };

  const finishPress = useEffectEvent(() => {
    if (seal === null || locked || sentPress.current === seal.press) return;
    if (sealed.error !== null) {
      endPress(diagnosticMessage(SEAL_FAILED_LINE, sealed.error));
      return;
    }
    if (quote === null || sealed.quote === null) return;
    if (quote.quote_id === null) {
      if (quote.offer_refused === "insufficient_balance") refreshBalance(quote.balance_failure?.coin_type);
      endPress(sealRefusalLine(quote, inCoin.symbol) ?? SEAL_FAILED_LINE);
      return;
    }
    if (quote.min_out === null) {
      endPress(SEAL_FAILED_LINE);
      return;
    }
    if (usesExactBalance && balanceStatus === "loading") return;
    if (!offeredNow(quote) || !cta.enabled || cta.action !== "trade") {
      endPress(cta.reason ?? PRICE_CHANGED_LINE);
      return;
    }
    if (review === null) void trade(seal, quote);
  });
  useEffect(() => {
    if (seal === null || (sealed.quote === null && sealed.error === null)) return;
    let current = true;
    queueMicrotask(() => {
      if (current) finishPress();
    });
    return () => { current = false; };
  }, [seal, sealed.quote, sealed.error, sealed.nowMs, cta.enabled, cta.action, cta.reason, balanceStatus]);

  const changeField = (next: TradeAmount) => {
    setFailure(null);
    setFee(null);
    onField(next);
  };

  const outReading = usesExactBalance && !outLine.known && (trading.sessionPending === true || outRead.status === "loading");
  return { inCoin, outCoin, field, onField: changeField, detail, onDetail, onPick, id, locked, successful, pending, inputRef, scope, panels, summary, rows, rateState, hasQuote: quote?.amount_out != null, cost, warning, review, cta: action, verb, quoteError: shownFailure?.message ?? quoteError, flip, press, waiting, balanceKnown, balancePending, inBalanceShown: balance.line.known, outReading, retryBalance, usesExactBalance };
}

export function SwapForm(props: Parameters<typeof useSwapFormControls>[0]) {
  const { inCoin, outCoin, field, onField, detail, onDetail, onPick, id, locked, successful, pending, inputRef, scope, panels, summary, rows, rateState, hasQuote, cost, warning, review, cta, verb, quoteError, flip, press, waiting, balanceKnown, balancePending, inBalanceShown, outReading, retryBalance, usesExactBalance } = useSwapFormControls(props);
  const describedBy = swapDescription({ id, balancePending, warning, review, quoteError, cost });
  const pickPreset = (value: string) => {
    const preset = sellPresetAmount(value, inCoin);
    if (!usesExactBalance || preset.mode !== "all") return onField(preset);
    onField({ ...preset, typed: groupDigits(exactText({ n: inCoin.atoms, scale: inCoin.decimals })), fixedAtoms: inCoin.atoms });
  };
  const payLabel = !props.persistent ? "Pay" : tradeAction(inCoin, outCoin, props.focus ?? null) === "buy" ? "You pay" : "You sell";
  return (
    <div className={styles.tradeBody} ref={scope}>
      <SwapPair balancePending={balancePending} inBalanceShown={inBalanceShown} outReading={outReading} payLabel={payLabel} receiveLabel={props.persistent ? "You get" : "Receive"} field={field} flip={flip} id={id} inCoin={inCoin} inputRef={inputRef} locked={locked} onField={onField} onPick={onPick} outCoin={outCoin} panels={panels}
        presets={<AmountPresets selected={selectedSellPreset(field, inCoin)} disabled={locked || !balanceKnown} onPick={pickPreset} />} />
      <TradeLine cost={cost} costId={`${id}-cost`} message={quoteError} noticeId={`${id}-notice`} review={review} symbols={[inCoin.symbol, outCoin.symbol]} warning={warning} />
      {retryBalance ? <Button onClick={retryBalance} size="sm" variant="secondary">Retry balance</Button> : null}
      <SwapAction describedBy={describedBy} waiting={waiting} sessionPending={props.trading.sessionPending && !balancePending} cta={pending ? { ...cta, enabled: false, busy: false, label: `${verb}…` } : cta} pending={pending} successful={successful} onPress={press} />
      {hasQuote ? <SwapDetails id={`${id}-detail`} open={detail} onDetail={onDetail} rows={rows} rate={summary.price} rateState={rateState} showRate={showSwapRate(field, inCoin, outCoin)} /> : props.walletFee === "wallet" ? <dl className={styles.terms}><div><dt>Network fee</dt><dd>Paid from your SUI</dd></div></dl> : null}
    </div>
  );
}

function swapDescription({ id, balancePending, warning, review, quoteError, cost }: Pick<ReturnType<typeof useSwapFormControls>, "id" | "balancePending" | "warning" | "review" | "quoteError" | "cost">) {
  return [
    balancePending && `${id}-balance`,
    (warning !== null || review !== null) && `${id}-notice`,
    quoteError === null && cost !== null && `${id}-cost`,
  ].filter(Boolean).join(" ") || undefined;
}

function SwapPair({ balancePending, inBalanceShown, outReading, payLabel, receiveLabel, id, field, inCoin, outCoin, locked, onField, inputRef, onPick, panels, flip, presets }: Readonly<{
  balancePending: boolean; inBalanceShown: boolean; outReading: boolean; payLabel: string; receiveLabel: string; id: string; field: TradeAmount; inCoin: WalletCoinView; outCoin: WalletCoinView; locked: boolean;
  onField: (next: TradeAmount) => void; inputRef: RefObject<HTMLInputElement | null>; onPick: (side: "in" | "out") => void;
  panels: ReturnType<typeof swapPanels>; flip: () => void; presets: ReactNode;
}>) {
  return <>{/* The Swap board's boxes: the label and balance over the amount and its coin, the dollar value under it. */}
      <div className={styles.swapPair}>
        <div className={styles.amt} data-panel="">
          <div className={styles.amtTop}>
            <label htmlFor={`${id}-amount`}>{payLabel}</label>
            <BalanceLine id={`${id}-balance`} pending={balancePending && !inBalanceShown} symbol={inCoin.symbol} text={panels.inBalance} />
          </div>
          <div className={styles.amtRow}>
            <AmountFit value={field.typed}>
              <input
                aria-describedby={`${id}-in-usd${(field.mode === "all") ? ` ${id}-mode` : ""}`}
                autoComplete="off"
                data-coin-focus=""
                data-mode={(field.mode === "all") ? "whole" : "typed"}
                disabled={locked}
                id={`${id}-amount`}
                inputMode="decimal"
                onChange={(event) => onField(typedAmount(decimalText(event), inCoin.decimals))}
                onPaste={(event) => pasteDecimal(event, (text) => onField(typedAmount(text, inCoin.decimals)))}
                onDrop={(event) => dropDecimal(event, (text) => onField(typedAmount(text, inCoin.decimals)))}
                placeholder="0"
                ref={inputRef}
                value={field.typed}
              />
            </AmountFit>
            <CoinChip coin={inCoin} disabled={locked} label={`Change sell token (${inCoin.symbol})`} onPress={() => onPick("in")} side="in" />
          </div>
          <div className={styles.amtFoot}>
            <span className={clsx(panels.out.pending && styles.pending)} id={`${id}-in-usd`}>{panels.inUsd}</span>
            {/* The selected Max chip shows whole-balance mode; the field names it to screen readers only. */}
            {(field.mode === "all") ? <span className="sr" id={`${id}-mode`}>Whole balance</span> : null}
          </div>
        </div>
        {/* The presets are shares of the coin you pay with, so they sit under its box, before the flip. */}
        {presets}
        <div className={styles.flipSlot}>
          <button aria-label={`Flip: sell ${outCoin.symbol} for ${inCoin.symbol} instead`} className={styles.swapFlip} data-flip="" disabled={locked} onClick={flip} title="Flip" type="button">
            <FlipIcon />
          </button>
        </div>
        <div aria-live="polite" className={clsx(styles.amt, styles.amtOut)} data-panel="">
          <div className={styles.amtTop}>
            <span className={styles.lbl}>{receiveLabel}</span>
            <BalanceLine pending={outReading} symbol={outCoin.symbol} text={panels.outBalance} />
          </div>
          <div className={styles.amtRow}>
            <AmountFit value={panels.out.text}>
              <b className={clsx(styles.amtVal, "num", panels.out.muted && styles.zero, panels.out.pending && styles.pending)} data-out="">
                {panels.out.text}
              </b>
            </AmountFit>
            <CoinChip coin={outCoin} disabled={locked} label={`Change receive token (${outCoin.symbol})`} onPress={() => onPick("out")} side="out" />
          </div>
          {panels.outUsd === null ? null : (
            <div className={styles.amtFoot}>
              <span className={clsx(panels.out.pending && styles.pending)}>{panels.outUsd}</span>
            </div>
          )}
        </div>
      </div></>;
}

function showSwapRate(field: TradeAmount, inCoin: WalletCoinView, outCoin: WalletCoinView) {
  return field.typed.trim() !== "" || (outCoin.key === "usdc" && inCoin.price !== null);
}

/**
 * The collapsed line: the rate, faint while a new amount is asked (it is the last
 * answer's, kept), and none after a failed read (no figure without its quote).
 */
function SwapDetails({ id, open, onDetail, rows, rate, rateState, showRate }: Readonly<{
  id: string;
  open: boolean;
  onDetail: (open: boolean) => void;
  rows: ReturnType<typeof txRows>;
  rate: ReturnType<typeof txSummary>["price"];
  rateState: "live" | "asking" | "failed";
  showRate: boolean;
}>) {
  return <div className={styles.tx}>
    <DisclosureButton aria-controls={id} aria-expanded={open} className={styles.txSum} onClick={() => onDetail(!open)} variant="ghost">
      {showRate && rateState !== "failed" ? <span className={clsx("num", rateState === "asking" && styles.pending)}>{rate}</span> : "Trade details"}
    </DisclosureButton>
    <Collapse id={id} open={open}><div className={styles.txDetailSpace}><dl className={clsx(styles.terms, styles.txDet)}>
      {rows.map((row) => (
        <div key={row.label}>
          <dt>{row.label}</dt>
          <dd className={clsx(row.numeric && "num", row.tone === "warn" && styles.warnT, row.tone === "down" && styles.down) || undefined}>{row.value}</dd>
        </div>
      ))}
    </dl></div></Collapse>
  </div>;
}

/**
 * The line above the button: why there is no trade, else what the trade costs; its slot keeps one height either way.
 * A failure's code and reference stay visible (docs/errors.md) on a quieter second line under the sentence.
 */
function TradeLine({ message, cost, costId, noticeId, symbols, warning, review }: Readonly<{
  message: string | null; cost: string | null; costId: string; noticeId: string; symbols: readonly string[]; warning: string | null; review: string | null;
}>) {
  return (
    <div className={styles.validationSlot}>
      <div id={noticeId} aria-live="polite">
        {warning !== null ? <p className={clsx(styles.status, styles.payoutWarning)}>{warning}</p> : null}
        {review !== null ? <p className={styles.status}>{review}</p> : null}
      </div>
      {message !== null ? <p className={styles.status} role="alert"><DiagnosticText message={message} /></p> : cost !== null ? <p className={clsx(styles.status, "num")} id={costId}><TickerText symbols={symbols} text={cost} /></p> : null}
    </div>
  );
}

/** The action stays focusable while a quote or transaction is in flight and while success is shown. */
function SwapAction({ cta, successful, pending, onPress, sessionPending, waiting, describedBy }: Readonly<{ waiting: boolean; sessionPending?: boolean; cta: ReturnType<typeof swapCta>; successful: boolean; pending: boolean; onPress: () => void; describedBy: string | undefined }>) {
  const busy = !successful && (cta.busy || sessionPending || waiting);
  return (
    <>
      <Button
        aria-describedby={describedBy}
        aria-busy={busy || undefined}
        className={successful ? styles.tradeDone : undefined}
        data-trade=""
        disabled={successful || !cta.enabled}
        focusableDisabled={successful || waiting || cta.busy}
        onClick={onPress}
        size="lg"
        variant="primary"
      >
        <SwapActionLabel cta={cta} quoting={cta.quoting === true || waiting} sessionPending={sessionPending} successful={successful} />
      </Button>
      <span className="sr" role="status">{successful ? "Swap successful." : pending ? PENDING_LINE : ""}</span>
    </>
  );
}

/** A balance line: the figure stays on one line, a no-break space keeps the ticker with it, and a long ticker breaks inside itself (the shared ticker class). */
function BalanceLine({ id, pending, text, symbol }: Readonly<{ id?: string; pending?: boolean; text: string; symbol: string }>) {
  if (pending) return <span id={id}>Balance <SkeletonLine label="Checking balance" /></span>;
  const figure = text.endsWith(`\u00a0${symbol}`) ? text.slice(0, -symbol.length - 1) : text;
  return (
    <span id={id}>
      <span className={styles.balFigure}>{figure}</span>
      {figure === text ? null : <>{"\u00a0"}<span className="ticker">{symbol}</span></>}
    </span>
  );
}

/** A side's coin chip: the coin, and a press that opens the picker for that side (the shared trigger and its chevron). */
function CoinChip({ coin, label, onPress, disabled, side }: Readonly<{ coin: WalletCoinView; label: string; onPress: () => void; disabled: boolean; side: "in" | "out" }>) {
  return (
    <DisclosureButton aria-label={label} className={styles.tokPick} data-coin-pick={side} disabled={disabled} leadingIcon={<CoinMark coin={coin} size={28} />} onClick={onPress}>
      <span className={clsx(styles.tokSymbol, "ticker")}>{coin.symbol}</span>
    </DisclosureButton>
  );
}

function SwapActionLabel({ cta, quoting, sessionPending, successful }: Readonly<{ cta: ReturnType<typeof swapCta>; quoting: boolean; sessionPending?: boolean; successful: boolean }>) {
  if (successful) return <span className={styles.tradeSuccess}><KnowCheckIcon />Successful</span>;
  if (sessionPending) return <LoadingIndicator label="Restoring session…">Swap</LoadingIndicator>;
  // The action keeps its name; the ring takes its place after 300 ms, and only assistive technology hears the operation.
  if (quoting) return <LoadingIndicator label={FINDING_PRICE}>{cta.label}</LoadingIndicator>;
  if (cta.busy) return <><span className={styles.spin} />{cta.label}</>;
  return cta.label;
}
