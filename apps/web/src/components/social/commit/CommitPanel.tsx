"use client";
import { atomsToField, parseAtoms } from "#web/components/social/trade/trade-ticket.ts";

import { Button, DisclosureSummary } from "#web/components/blast-ui/Button.tsx";
import { Spinner } from "#web/components/blast-ui/LoadingIndicator.tsx";
import { SkeletonLine } from "#web/components/blast-ui/Skeleton.tsx";
import { diagnosticMessage, publicErrorMessage } from "#web/lib/errors.ts";

import clsx from "clsx";
import { useEffect, useId, useRef, useState, type ReactNode, type RefObject } from "react";

import { Sheet, SheetClose, SheetDock, SheetHeading } from "#web/components/blast-ui/Sheet.tsx";
import { groupedExact } from "@blast/core/web/exact-amount.ts";
import { decimalText, dropDecimal, pasteDecimal } from "#web/lib/decimal-input.ts";
import { qty } from "@blast/core/web/format.ts";
import { commitOffLine, type CommitBlocker } from "@blast/core/web/contracts/commit.ts";
import { USED_ALLOCATION_MESSAGE, allocationLine, balanceLine, coinMoney, commitAmounts, commitPresets, commitPrimary, commitRefusal, commitTerms, conversionLine, presetAmount, sanitizeAmount, type CommitInput, type CommitPrimary, type CommitPayCoin, type CommitSale, type CommitViewer } from "@blast/core/modules/social/commit/quote.ts";
import { validateWhy, WHY_MAX_CODE_POINTS, whyLength } from "@blast/core/modules/social/whys/validate.ts";

import { useSignInDraft } from "../sign-in-draft";
import { authenticatedAction } from "../sign-in-gate";
import { useSocialViewer } from "../SignInGate";
import { useShellActions } from "#web/components/blast-ui/shell-actions.tsx";
import { WHY_TEXT_MESSAGES } from "../post/why-client";
import styles from "./commit.module.css";
import { withPreferredCoins, maxWithdrawAtoms, type WalletCoinView } from "../coins/coin-model";
import { fundedPaymentInput, saleQuoteCoin } from "./commit-payment";
import { canTrade } from "../coins/swap-model";
import { sellPresetAmount, SELL_PRESETS } from "../trade/trade-ticket.ts";
import { atomsText, atomsValue } from "@blast/core/web/format.ts";
import { impactText, isOffered } from "../trades/trade-quote-view";
import { useCommitSwap } from "./use-commit-swap";
import { useWalletCoinBalance, type WalletCoinBalance } from "../coins/use-wallet-coin-balance";
import type { CommitPhase } from "./commit-flow";
import { PaymentCoinSelector } from "./PaymentCoinSelector";
import { CommitPendingNotice } from "./CommitPendingNotice";

/**
 * The commit panel (FEATURE-MAP §4, with R3's changes): "You pay", the
 * pay-with toggle, the amount with its presets, the terms, the why, and one
 * primary button that is the only thing in the product that can start a
 * signature (AC-092).
 *
 * Commitment terms come from `commit/quote.ts`; routed payments use the
 * router's guaranteed quote-coin minimum. The panel owns the pay coin, amount and why.
 *
 * Accessibility beyond the reference, which the Definition of Done requires
 * and FEATURE-MAP §4 asks for in as many words ("the prototype does not; add
 * it"): the why's hint is tied to the textarea with `aria-describedby`, and an
 * amount the panel refuses points the amount field at the button that says
 * why, so a screen reader hears the reason on the field rather than only on a
 * control it may never reach.
 */

export type CommitBlastInput = Readonly<{
  payWith: CommitPayCoin;
  /** What leaves the wallet, in the pay coin. */
  pay: number;
  usd: number;
  /** The commitment in the sale's own coin. */
  quote: number;
  /** The why, trimmed; empty means none. */
  why: string;
  swapQuoteId?: string;
  quoteAtoms?: string;
  paymentSymbol?: string;
}>;

export type CommitDraft = Readonly<{ coinType: string; amount: string; why: string; paymentCoin?: WalletCoinView }>;

export type CommitPanelProps = Readonly<{
  sale: CommitSale;
  viewer: CommitViewer;
  walletCoins?: readonly WalletCoinView[];
  walletCoinsState?: "loading" | "unavailable" | "ready";
  initialPayCoin?: string;
  initialPaymentCoin?: WalletCoinView;
  draft?: CommitDraft;
  onDraftChange?: (draft: CommitDraft) => void;
  onDetails?: () => void;
  walletFee?: "wallet" | "sponsored";
  walletAddress?: string | null;
  /** Why blasting is off, for reasons that do not depend on the pay coin. */
  blockers: readonly CommitBlocker[];
  nowMs: number;
  /** Starts the commit. The panel shows the phase and any refusal it answers. */
  onBlast: (input: CommitBlastInput, onPhase: (phase: CommitPhase) => void) => Promise<Readonly<{ ok: true; digest?: string; pending?: string } | { ok: false; message?: string }>>;
  /** "Add USDC" / "Add SUI": the Deposit sheet for that coin. */
  onDeposit: (coin: CommitPayCoin) => void;
  /** Spread on the primary button by a surface that charges it (hold to blast). */
  primaryExtra?: Readonly<Record<string, unknown>>;
  /** The dialog's handle on the amount field, so the sheet can focus it on open. */
  amountRef?: RefObject<HTMLInputElement | null>;
  /**
   * Drawn in a page's column rather than a sheet (the sale page's side box,
   * OA-43's `panelHTML(…, 'side')`): the primary button sits in the panel
   * itself, as the gate's does, not in the sheet's dock. Nothing else changes.
   */
  inline?: boolean;
  /** The Buy sheet keeps its form body scrolling between a fixed header and action. */
  purchase?: boolean;
  /** Featured cards keep the amount and estimate visible, with terms in a disclosure. */
  compact?: boolean;
  active?: boolean;
  summary?: ReactNode;
  details?: ReactNode;
}>;

const BUSY_LABEL: Readonly<Record<CommitPhase, string>> = {
  preparing: "Preparing commitment",
  signing: "Confirm in your wallet",
  executing: "Blasting",
};

function whyValidationMessage(why: string): string | null {
  if (why.trim().length === 0) return null;
  const checked = validateWhy(why);
  return checked.ok ? null : WHY_TEXT_MESSAGES[checked.code];
}

function blastPhaseLabel(phase: CommitPhase | null, routed: boolean, payWith: CommitPayCoin, quoteCoin: CommitPayCoin): string {
  if (phase === null) return "";
  return phase === "executing" && (routed || payWith !== quoteCoin) ? "Swapping and blasting" : BUSY_LABEL[phase];
}

function initialSwapType(quoteType: string, coin: string | undefined): string | null {
  return coin && coin !== quoteType ? coin : null;
}

/** What the wallet can pay with now: the fresh balance less the SUI a wallet-paid fee needs. Null until it is verified. */
function spendableAtoms(coin: WalletCoinView | null, balance: WalletCoinBalance, fee: CommitPanelProps["walletFee"]): bigint | null {
  return coin && balance.status === "ready" ? maxWithdrawAtoms({ ...coin, atoms: balance.atoms }, fee === "sponsored" ? "sponsored" : "wallet") : null;
}

function balanceGate(primary: CommitPrimary, balance: WalletCoinBalance, checked: boolean): CommitPrimary {
  if (!checked || balance.status === "ready" || primary.action === "none") return primary;
  return { ...primary, label: balance.status === "loading" ? "Checking balance…" : "Balance unavailable", disabled: true, action: "none" };
}

/** The swap action's label for the latest quote: the route answered, is being looked for, failed, or has no amount yet. */
function swapLabel(payment: ReturnType<typeof useCommitSwap>, direct: CommitPrimary): string {
  if (payment.ready) return direct.action === "commit" ? "Swap & contribute" : direct.label;
  if (payment.loading) return "Checking swap route…";
  return payment.atoms !== null && payment.atoms > BigInt(0) ? "Swap unavailable" : "Enter an amount";
}

function routedPrimary(direct: CommitPrimary, payment: ReturnType<typeof useCommitSwap>, routed: boolean, coin: WalletCoinView | null, quoteCoin: WalletCoinView, allocationUsed: boolean, insufficient: boolean): CommitPrimary {
  if (allocationUsed) return direct;
  // The balance check does not wait for a route: a known shortfall is the first thing to fix.
  if (routed && insufficient) return { ...direct, label: "Insufficient balance", disabled: true, action: "none" };
  if (!routed) {
    const needsDeposit = direct.action === "deposit" || (direct.action === "commit" && insufficient);
    if (!needsDeposit) return direct;
    return { label: `Add ${quoteCoin.symbol}`, disabled: false, action: "deposit" };
  }
  return { ...direct, label: swapLabel(payment, direct), disabled: direct.disabled || !payment.ready || coin === null || !canTrade(coin) };
}

function commitStatusText(blockers: readonly CommitBlocker[], allocationUsed: boolean, walletExpected: boolean): string | null {
  if (allocationUsed) return USED_ALLOCATION_MESSAGE;
  const reasons = blockers.filter(reason => reason !== "wallet_missing" || walletExpected);
  return reasons.length > 0 ? commitOffLine(reasons) : null;
}

function swapOrder(routed: boolean, quote: ReturnType<typeof useCommitSwap>["quote"], coin: WalletCoinView | null) {
  return routed && quote?.quote_id && quote.min_out !== null && coin
    ? { swapQuoteId: quote.quote_id, quoteAtoms: quote.min_out, paymentSymbol: coin.symbol }
    : {};
}

function amountAccessibility(refusal: ReturnType<typeof commitRefusal>, offLine: string | null, primaryId: string, noteId: string) {
  const invalidAmount = refusal === "min" || refusal === "cap" || refusal === "insufficient";
  return { invalidAmount, amountDescribedBy: [invalidAmount ? primaryId : null, offLine ? noteId : null].filter(Boolean).join(" ") };
}

function paymentChoices(quoteCoin: WalletCoinView, coins: readonly WalletCoinView[]) {
  return [quoteCoin, ...coins.filter(coin => coin.atoms > BigInt(0) && coin.coinType !== quoteCoin.coinType)];
}

function initialPayment(quoteCoin: WalletCoinView, coins: readonly WalletCoinView[], options: Pick<CommitPanelProps, "draft" | "initialPayCoin" | "initialPaymentCoin">) {
  const type = options.draft?.coinType ?? options.initialPayCoin;
  const amount = options.draft?.amount;
  const known = coins.find((each) => each.coinType === type) ?? options.draft?.paymentCoin ?? options.initialPaymentCoin;
  const coin = type === quoteCoin.coinType ? quoteCoin : known?.coinType === type ? known : undefined;
  const atoms = coin && amount ? parseAtoms(amount, coin.decimals) : null;
  return { type: type ?? coin?.coinType, amount: amount !== undefined ? coin && atoms !== null ? atomsText(atoms, coin.decimals) : amount : null, changed: Boolean(type && !coin) };
}

function selectedPaymentCoin(type: string | null, coins: readonly WalletCoinView[], picked: WalletCoinView | null, accepted: WalletCoinView): WalletCoinView | null {
  if (type === null) return null;
  const held = coins.find(coin => coin.coinType === type);
  if (held) return held;
  if (picked?.coinType === type) return picked;
  return { ...accepted, coinType: type, key: type, symbol: type.split("::").at(-1) ?? "Coin", name: "Payment coin unavailable", metadataAvailable: false, price: null, atoms: 0n, amount: 0 };
}

type CommitFieldsOptions = Pick<CommitPanelProps, "sale" | "draft" | "initialPayCoin" | "initialPaymentCoin" | "onDraftChange"> & Readonly<{
  quoteCoin: WalletCoinView;
  walletCoins: readonly WalletCoinView[];
  signedIn: boolean;
  active: boolean;
  busy: boolean;
}>;

function useCommitFields({ sale, quoteCoin, walletCoins, signedIn, active, busy, draft, initialPayCoin, initialPaymentCoin, onDraftChange }: CommitFieldsOptions) {
  const initial = initialPayment(quoteCoin, walletCoins, { draft, initialPayCoin, initialPaymentCoin });
  const [swapType, setSwapType] = useState<string | null>(() => initialSwapType(quoteCoin.coinType, initial.type));
  const [pickedCoin, setPickedCoin] = useState<WalletCoinView | null>(draft?.paymentCoin ?? initialPaymentCoin ?? null);
  const swapCoin = selectedPaymentCoin(swapType, withPreferredCoins(walletCoins), pickedCoin, quoteCoin);
  // The box holds only what the person typed (or their own draft): no default amount, so typing never joins one (#1012).
  const [typed, setTypedState] = useState(initial.amount ?? "");
  const [paymentChanged, setPaymentChanged] = useState(initial.changed);
  const [why, setWhyState] = useState(draft?.why ?? "");
  const saveDraft = (patch: Partial<CommitDraft>) => onDraftChange?.({
    coinType: swapType ?? quoteCoin.coinType, amount: typed, why,
    paymentCoin: swapCoin?.metadataAvailable !== false ? swapCoin ?? undefined : undefined,
    ...patch,
  });
  const setTyped = (value: string) => {
    setTypedState(value);
    setPaymentChanged(false);
    saveDraft({ amount: value });
  };
  const setWhy = (value: string) => { setWhyState(value); saveDraft({ why: value }); };
  useSignInDraft(`commit:fields:${sale.presaleId}`, !signedIn ? { payWith: sale.quoteCoin, typed, why, swapType: swapType ?? "" } : null, (saved) => {
    if (saved.payWith !== sale.quoteCoin) return;
    setSwapType(saved.swapType || null);
    setTypedState(saved.typed ?? "");
    setWhyState(saved.why ?? "");
    onDraftChange?.({ coinType: saved.swapType || quoteCoin.coinType, amount: saved.typed ?? "", why: saved.why ?? "" });
  }, active);

  const selectPayment = (coin: WalletCoinView) => {
    const type = coin.coinType;
    if (busy || type === (swapType ?? quoteCoin.coinType)) return false;
    setSwapType(type === quoteCoin.coinType ? null : type);
    setTypedState("");
    setPickedCoin(coin);
    saveDraft({ coinType: type, amount: "", paymentCoin: coin });
    setPaymentChanged(false);
    return true;
  };
  return { swapCoin, routed: swapType !== null, typed, setTyped, why, setWhy, paymentChanged, setPaymentChanged, selectPayment };
}

type CommitPaymentOptions = Pick<CommitPanelProps, "walletAddress" | "walletCoinsState" | "walletFee"> & Readonly<{
  direct: CommitInput;
  swapCoin: WalletCoinView | null;
  quoteCoin: WalletCoinView;
  routed: boolean;
  active: boolean;
  busy: boolean;
  walletExpected: boolean;
  signedIn: boolean;
}>;

function applyExactCommitBalance(direct: CommitInput, payBase: WalletCoinView, balance: WalletCoinBalance, routed: boolean) {
  // The same verified balance drives the label, presets, Max and validation.
  const payCoin = balance.status === "ready"
    ? { ...payBase, atoms: balance.atoms, amount: atomsValue(balance.atoms, payBase.decimals) ?? 0 }
    : payBase;
  const directInput = balance.status === "ready" && !routed
    ? { ...direct, viewer: { ...direct.viewer, quoteCoin: direct.sale.quoteCoin, quoteBalance: payCoin.amount } }
    : direct;
  return { payCoin, directInput };
}

function exceedsSpendable(amount: bigint | null, spendable: bigint | null): boolean {
  return spendable !== null && amount !== null && amount > spendable;
}

function useCommitPayment({ direct, swapCoin, quoteCoin, routed, active, busy, walletExpected, signedIn, walletAddress, walletCoinsState, walletFee }: CommitPaymentOptions) {
  const payBase = swapCoin ?? quoteCoin;
  const balance = useWalletCoinBalance(walletAddress, payBase.coinType, active && walletExpected, walletCoinsState === "loading");
  const { payCoin, directInput } = applyExactCommitBalance(direct, payBase, balance, routed);

  const allocationUsed = signedIn && commitRefusal(directInput) === "allocation_used";
  const canQuote = active && walletExpected && !allocationUsed;
  const scope = `${direct.sale.presaleId}:mainnet:${walletAddress ?? ""}`;
  const payment = useCommitSwap(swapCoin, quoteCoin, direct.typed, busy, canQuote, undefined, scope);
  const quotedAtoms = payment.ready ? payment.quote?.min_out ?? null : null;
  const input = routed ? fundedPaymentInput(directInput, quotedAtoms, quoteCoin.decimals) : directInput;
  const inputAtoms = routed ? payment.atoms : parseAtoms(direct.typed, quoteCoin.decimals);
  const insufficient = exceedsSpendable(inputAtoms, spendableAtoms(payBase, balance, walletFee));
  const refusal = commitRefusal(input) ?? (!routed && insufficient ? "insufficient" : null);
  const routedAction = routedPrimary(commitPrimary(input), payment, routed, swapCoin, quoteCoin, allocationUsed, insufficient);
  const primary = balanceGate(routedAction, balance, walletExpected && !allocationUsed);
  return { balance, payCoin, allocationUsed, payment, quotedAtoms, input, amounts: commitAmounts(input), insufficient, refusal, primary };
}

function useCommitPanelControls({ sale, viewer, blockers, nowMs, onBlast, onDeposit, primaryExtra, amountRef, inline = false, purchase = false, active = true, walletCoins = [], walletCoinsState = "ready", initialPayCoin, initialPaymentCoin, walletFee, walletAddress, draft, onDraftChange, onDetails }: CommitPanelProps) {
  const session = useSocialViewer();
  const run = useShellActions();
  const prefix = useId();
  const amountId = `amt-${prefix}`;
  const whyId = `why-${prefix}`;
  const hintId = `hint-${prefix}`;
  const primaryId = `go-${prefix}`;
  const noteId = `note-${prefix}`;
  const payWith = sale.quoteCoin;
  const quoteCoin = saleQuoteCoin(sale, walletCoins);
  const canSwap = true;
  const [phase, setPhase] = useState<CommitPhase | null>(null);
  const busy = phase !== null;
  const { swapCoin, routed, typed, setTyped, why, setWhy, paymentChanged, setPaymentChanged, selectPayment } = useCommitFields({
    sale, quoteCoin, walletCoins, signedIn: session.signedIn, active, busy, draft, initialPayCoin, initialPaymentCoin, onDraftChange,
  });
  const walletExpected = session.signedIn && !session.sessionPending;
  const [refused, setRefused] = useState<string | null>(null);
  const [pending, setPending] = useState<Readonly<{ message: string; digest?: string }> | null>(null);
  const ownAmount = useRef<HTMLInputElement | null>(null);

  // A restored draft keeps the caret at its end, so the person carries on
  // where they stopped. Once only: it must not fight the person typing.
  useEffect(() => {
    const field = amountRef?.current ?? ownAmount.current;
    if (field) field.setSelectionRange(field.value.length, field.value.length);
  }, [amountRef]);

  const whyError = whyValidationMessage(why);
  const { balance, payCoin, allocationUsed, payment, quotedAtoms, input, amounts, insufficient, refusal, primary } = useCommitPayment({
    direct: { sale, viewer, payWith, typed, why, whyError, blockers, nowMs },
    swapCoin, quoteCoin, routed, active, busy, walletExpected, signedIn: session.signedIn, walletAddress, walletFee, walletCoinsState,
  });
  const terms = commitTerms(sale, amounts.quote);
  const phaseLabel = blastPhaseLabel(phase, routed, payWith, sale.quoteCoin);
  const offLine = commitStatusText(blockers, allocationUsed, walletExpected);
  const length = whyLength(why);

  const submitting = useRef(false);
  async function submit() {
    if (!active || submitting.current || busy || session.sessionPending) return;
    if (!session.signedIn) { run("openSignIn"); return; }
    if (primary.action === "deposit") {
      onDeposit(quoteCoin.key);
      return;
    }
    if (primary.action !== "commit" || primary.disabled) return;
    // Recheck the quote immediately before requesting a signature.
    if (routed && (!payment.quote || !isOffered(payment.quote, Date.now()))) { payment.refresh(); return; }
    submitting.current = true;
    setRefused(null);
    setPending(null);
    setPaymentChanged(false);
    setPhase("preparing");
    return await (async () => {
      const result = await onBlast({ payWith, pay: routed ? Number(typed.replaceAll(",", "")) : amounts.pay, usd: amounts.usd, quote: amounts.quote, why: why.trim(),
        ...(!routed ? { quoteAtoms: (parseAtoms(typed, quoteCoin.decimals) ?? BigInt(0)).toString() } : {}),
        ...swapOrder(routed, payment.quote, swapCoin),
      }, setPhase);
      if (!result.ok) setRefused(result.message ?? diagnosticMessage("That didn’t go through. Nothing was sent.", { code: "request_refused" }));
      else if (result.pending) setPending({ message: result.pending, digest: result.digest });
    })().catch((error) => {
      setRefused(publicErrorMessage(error, "This commitment could not be confirmed. Check your wallet before retrying.", "execution_unconfirmed"));
    }).finally(() => {
      submitting.current = false;
      setPhase(null);
    });
  }

  const { invalidAmount, amountDescribedBy } = amountAccessibility(refusal, offLine, primaryId, noteId);

  const pickPayment = (coin: WalletCoinView) => {
    if (selectPayment(coin)) setRefused(null);
  };
  const paymentChoice = <PaymentCoinSelector accepted={quoteCoin} coins={walletCoins} busy={busy} selected={payCoin} onPick={pickPayment} purchase={purchase} />;

  const conversion = paymentConversion(input, routed, quotedAtoms);
  const balanceLine = paymentBalance(input, routed, payCoin, walletExpected);
  const labels = commitActionLabels(primary, amounts.pay, payWith, purchase);
  const action = authenticatedAction(session, labels.label, labels.signIn, primary.disabled, busy);

  const attachAmount = (element: HTMLInputElement | null) => {
    ownAmount.current = element;
    if (amountRef) amountRef.current = element;
  };
  return { active, allocationUsed, conversion, balanceLine, balance, payCoin, insufficient, canSwap, walletCoinsState, walletFee, walletCoins, quoteCoin, swapCoin, routed, payment, paymentChanged, pickPayment, paymentChoice, attachAmount, sale, inline, purchase, onDetails, amounts, amountId, whyId, hintId, noteId, payWith, setTyped, typed, why, setWhy, whyError, input, terms, busy, session, offLine, length, invalidAmount, amountDescribedBy, action, primaryId, primaryExtra, submit, phaseLabel, refused, pending };
}

function paymentConversion(input: CommitInput, routed: boolean, atoms: string | null): string {
  if (!routed) return conversionLine(input);
  return atoms === null ? "" : `You contribute ${atomsToField(BigInt(atoms), input.sale.quoteDecimals ?? 6)} ${input.sale.quoteCoin} · swap minimum`;
}

function paymentBalance(input: CommitInput, routed: boolean, coin: WalletCoinView | null, signedIn: boolean): string {
  if (!signedIn) return "Balance —";
  return routed && coin ? `Balance ${atomsToField(coin.atoms, coin.decimals)} ${coin.symbol}` : balanceLine(input);
}

function settlementText(atoms: string | null, coin: WalletCoinView): string {
  return atoms === null ? "Unavailable" : `${atomsToField(BigInt(atoms), coin.decimals)} ${coin.symbol}`;
}

function swapTerms(quote: NonNullable<ReturnType<typeof useCommitSwap>["quote"]>, coin: WalletCoinView, fee: CommitPanelProps["walletFee"]) {
  return [
    ["Estimated swap output", settlementText(quote.amount_out, coin)],
    ["Minimum contribution", settlementText(quote.min_out, coin)],
    ["Swap route", quote.route_label ?? "Unavailable"],
    ["Price impact", quote.price_impact_bps === null ? "Unavailable" : impactText(quote.price_impact_bps)],
    ["Slippage", impactText(quote.slippage_bps)],
    ["Blast swap fee", quote.blast_fee_bps === null ? "Unavailable" : `${impactText(quote.blast_fee_bps)} · ${settlementText(quote.blast_fee_amount, coin)}`],
    ["Network fee", fee === "sponsored" ? "Paid by Blast" : "Paid in SUI · shown in wallet"],
  ];
}

function SwapTerms({ payment, walletFee, quoteCoin }: Readonly<{ payment: ReturnType<typeof useCommitSwap>; walletFee: CommitPanelProps["walletFee"]; quoteCoin: WalletCoinView }>) {
  if (!payment.ready || !payment.quote) return null;
  return swapTerms(payment.quote, quoteCoin, walletFee).map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>);
}

function AmountPresets({ coin: heldCoin, routed, busy, signedIn, input, onPick, walletFee }: Readonly<{ coin: WalletCoinView | null; routed: boolean; busy: boolean; signedIn: boolean; input: CommitInput; onPick: (value: string) => void; walletFee: CommitPanelProps["walletFee"] }>) {
  const coin = heldCoin ? { ...heldCoin, atoms: maxWithdrawAtoms(heldCoin, walletFee === "sponsored" ? "sponsored" : "wallet") } : null;
  if (routed && coin) {
    return SELL_PRESETS.map(([preset, label]) => (
      <button className={styles.preset} disabled={busy || (preset === "max" && !signedIn)} key={preset} onClick={() => onPick(preset === "max" ? atomsText(coin.atoms, coin.decimals) : sellPresetAmount(preset, coin).typed)} type="button">{label}</button>
    ));
  }
  return commitPresets(input).map((preset) => {
    const isMax = preset.value === "Max";
    const maxCoin = isMax ? coin : null;
    const pressed = maxCoin ? maxCoin.atoms > 0n && parseAtoms(input.typed, maxCoin.decimals) === maxCoin.atoms : preset.pressed;
    const amount = maxCoin ? atomsText(maxCoin.atoms, maxCoin.decimals) : String(presetAmount(preset.value, input));
    return (
      <button
        aria-label={preset.ariaLabel ?? undefined}
        aria-pressed={pressed}
        className={styles.preset}
        disabled={busy || (isMax && !signedIn)}
        key={preset.value}
        onClick={() => onPick(amount)}
        type="button"
      >
        {preset.label}
      </button>
    );
  });
}

function CommitWhy({ why, whyError, whyId, hintId, length, busy, setWhy }: Readonly<{ why: string; whyError: string | null; whyId: string; hintId: string; length: number; busy: boolean; setWhy: (value: string) => void }>) {
  return (
      <div className={clsx(styles.whybox, whyError && styles.whyErr)}>
        <div className={styles.whyLbl}>
          <label htmlFor={whyId}>
            <b>Why are you in?</b> <em>optional</em>
          </label>
          <span className={clsx(styles.counter, styles.num, length > 250 && styles.near)}>
            {length}/{WHY_MAX_CODE_POINTS}
          </span>
        </div>
        <textarea
          aria-describedby={hintId}
          aria-invalid={whyError ? true : undefined}
          disabled={busy}
          id={whyId}
          // Four times the limit in UTF-16 units, so a long paste is still
          // caught by `validateWhy` and counted in code points, not clipped.
          maxLength={WHY_MAX_CODE_POINTS * 4}
          onChange={(event) => setWhy(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.nativeEvent.isComposing) event.preventDefault();
          }}
          placeholder="Add a note"
          rows={2}
          value={why}
        />
        <span className={styles.hint} id={hintId}>
          {whyError ?? ""}
        </span>
      </div>
  );
}

function PaymentGuidance({ controls }: Readonly<{ controls: ReturnType<typeof useCommitPanelControls> }>) {
  const { sale, walletCoins, quoteCoin, walletCoinsState, canSwap, session, input, routed } = controls;
  if (!session.signedIn || session.sessionPending || walletCoinsState !== "ready") return null;
  if (!canSwap && paymentChoices(quoteCoin, walletCoins).length > 1) return <p className={styles.note}>Other coins unavailable.</p>;
  if (canSwap && !routed && commitRefusal(input) === "insufficient" && walletCoins.some(coin => coin.coinType !== quoteCoin.coinType && coin.atoms > BigInt(0) && canTrade(coin))) return <p className={styles.note}>Choose another coin or add {sale.quoteCoin}.</p>;
  return null;
}

function CommitAmount({ controls }: Readonly<{ controls: ReturnType<typeof useCommitPanelControls> }>) {
  const { conversion, balanceLine, balance, payCoin, quoteCoin, swapCoin, routed, paymentChoice, attachAmount, amountId, setTyped, typed, busy, invalidAmount, amountDescribedBy, walletCoinsState, session } = controls;
  const signedIn = session.signedIn && !session.sessionPending;
  const balanceCoin = signedIn && balance.status === "ready" ? payCoin : null;
  return (
      <div className={styles.amt}>
        <div className={styles.amtTop}>
          <label htmlFor={amountId}>You pay</label>
          {session.sessionPending || (session.signedIn && walletCoinsState !== "ready") ? <span role="status">{session.sessionPending || walletCoinsState === "loading" ? <SkeletonLine label="Loading coins" status={false} /> : "Coins unavailable. Refresh."}</span> : null}
        </div>
        <div className={styles.amtRow}>
          <input
            aria-describedby={amountDescribedBy === "" ? undefined : amountDescribedBy}
            aria-invalid={invalidAmount ? true : undefined}
            autoComplete="off"
            className={styles.amtInput}
            disabled={busy}
            id={amountId}
            inputMode="decimal"
            placeholder="0"
            onChange={(event) => setTyped(sanitizeAmount(decimalText(event), swapCoin?.decimals ?? quoteCoin.decimals))}
            onPaste={(event) => pasteDecimal(event, (text) => setTyped(sanitizeAmount(text, swapCoin?.decimals ?? quoteCoin.decimals)))}
            onDrop={(event) => dropDecimal(event, (text) => setTyped(sanitizeAmount(text, swapCoin?.decimals ?? quoteCoin.decimals)))}
            ref={attachAmount}
            value={typed}
          />
          {paymentChoice}
        </div>
        <div className={styles.amtFoot}>
          {routed ? <span>{conversion}</span> : null}
          {signedIn && balance.status !== "ready" ? <PendingBalance balance={balance} /> : <CommitBalance balance={balanceLine} coin={balanceCoin} />}
        </div>
      </div>
  );
}

function PendingBalance({ balance }: Readonly<{ balance: WalletCoinBalance }>) {
  if (balance.status !== "unavailable") return <span role="status"><SkeletonLine label="Loading balance" status={false} /></span>;
  return <span role="status">Balance unavailable. {balance.retry ? <Button onClick={balance.retry} size="xs" variant="ghost">Try again</Button> : "Refresh."}</span>;
}

function CommitBalance({ balance, coin }: Readonly<{ balance: string; coin?: WalletCoinView | null }>) {
  if (!coin) return <span>{balance}</span>;
  const value = { n: coin.atoms, scale: coin.decimals };
  const exact = groupedExact(value, coin.decimals);
  const compact = groupedExact(value, Math.min(coin.decimals, 4), "floor");
  const displayed = coin.atoms > BigInt(0) && compact === "0" ? "<0.0001" : compact;
  return <span className={styles.balance} aria-label={`Balance ${exact === compact || compact === "0" ? "" : "approximately "}${displayed} ${coin.symbol}`}>Balance {exact === compact || compact === "0" ? "" : "≈ "}{displayed} {coin.symbol}</span>;
}

export function CommitPanel(props: Parameters<typeof useCommitPanelControls>[0]) {
  const controls = useCommitPanelControls(props);
  const { allocationUsed, sale, purchase, noteId, offLine, phaseLabel, refused, pending } = controls;
  return (
    <div className={clsx(styles.panel, purchase && styles.purchase, purchase && props.compact && styles.compact, props.summary && styles.dialogPanel)} data-kind="commit" data-key={sale.presaleId}>
      <div className={purchase || props.summary ? styles.purchaseBody : styles.panel}>
        {props.summary}
        {!allocationUsed ? <CommitFields compact={props.compact} controls={controls} /> : null}
        {props.details}

        {offLine ? (
          <p className={styles.note} id={noteId} role="status">
            {offLine}
          </p>
        ) : null}

        <span className="sr-only" role="status">{phaseLabel}</span>
        {refused ? <p className={styles.note} role="alert">{refused}</p> : null}
        <CommitPendingNotice pending={pending} />
      </div>
      <CommitAction compact={props.compact} controls={controls} />
      {props.compact && !allocationUsed ? <CommitPurchaseOptions controls={controls} /> : null}
    </div>
  );
}

function CommitFields({ controls, compact }: Readonly<{ controls: ReturnType<typeof useCommitPanelControls>; compact?: boolean }>) {
  const { walletFee, payCoin, balance, routed, busy, session, input, setTyped } = controls;
  return <>
    <CommitAmount controls={controls} />
    {!compact ? <div aria-label="Amount presets" className={styles.presets} role="group">
      <AmountPresets walletFee={walletFee} coin={payCoin} routed={routed} busy={busy || (session.signedIn && !session.sessionPending && balance.status !== "ready")} signedIn={session.signedIn && !session.sessionPending} input={input} onPick={setTyped} />
    </div> : null}
    <CommitPayment compact={compact} controls={controls} />
    <CommitEstimates compact={compact} controls={controls} />
    {!compact ? <CommitExtras controls={controls} /> : null}
  </>;
}

function paymentMessage(payment: ReturnType<typeof useCommitSwap>, insufficient: boolean): string | null {
  return payment.state === "ready" && insufficient ? "Insufficient balance." : payment.message;
}

/** An error or an expired quote retries. A confirmed no-route is said in the message; the coin chip opens the picker. */
function PaymentRecovery({ payment, busy }: Readonly<{ payment: ReturnType<typeof useCommitSwap>; busy: boolean }>) {
  if (payment.state !== "temporary-error" && payment.state !== "expired") return null;
  return <Button disabled={busy} onClick={payment.refresh} size="sm" variant="ghost">{payment.state === "expired" ? "Refresh quote" : "Try again"}</Button>;
}

function CommitPayment({ controls, compact }: Readonly<{ controls: ReturnType<typeof useCommitPanelControls>; compact?: boolean }>) {
  const { purchase, paymentChanged, sale, routed, payment, busy, insufficient } = controls;
  return <>
    <PaymentGuidance controls={controls} />
    {compact && purchase ? <p className={styles.context}>{sale.raised > sale.target && sale.target > 0 ? "Allocation is proportional." : "Allocation is set at close."} Unallocated payment is refunded at claim.</p> : null}

    {paymentChanged ? <p className={styles.note} role="status">Payment coin unavailable. Choose another coin.</p> : null}
    {routed && paymentMessage(payment, insufficient) ? <div className={styles.paymentNotice}>
      <p role="status">{paymentMessage(payment, insufficient)}</p>
      <PaymentRecovery payment={payment} busy={busy} />
    </div> : null}
  </>;
}

function CommitEstimates({ controls, compact }: Readonly<{ controls: ReturnType<typeof useCommitPanelControls>; compact?: boolean }>) {
  const { purchase, amounts, terms, sale, routed, payment, walletFee, quoteCoin } = controls;
  const hasEstimate = amounts.quote > 0;
  const tokens = !hasEstimate || terms.tokens === null ? "—" : `≈ ${qty(terms.tokens)} ${sale.symbol}`;
  const fill = hasEstimate ? `${Math.round(terms.fill * 100)}% at current funding` : "—";
  const termsList = <CommitTermsList compact={compact} controls={controls} tokens={tokens} fill={fill} />;
  if (compact) return <>
    {routed ? <details><summary>Transaction details</summary><dl className={styles.terms}><SwapTerms payment={payment} walletFee={walletFee} quoteCoin={quoteCoin} /></dl></details> : null}
    <div className={styles.allocation}>
      <div className={styles.allocationHeading} aria-live="polite"><span>Estimated allocation</span><b className={styles.estimate}>{tokens}</b><small>{hasEstimate ? "If the presale closed now" : "Enter an amount to see your estimate"}</small></div>
    </div>
  </>;
  return <div className={purchase ? styles.allocation : undefined}>
      {purchase ? <div className={styles.allocationHeading} aria-live="polite">
        <span>Estimated allocation</span>
        <b className={styles.estimate}>{hasEstimate ? tokens : "—"}</b>
        <small>{hasEstimate ? "If the presale closed now" : "Enter an amount to see your estimate"}</small>
      </div> : null}
      {termsList}
  </div>;
}

function CommitTermsList({ controls, compact, tokens, fill }: Readonly<{ controls: ReturnType<typeof useCommitPanelControls>; compact?: boolean; tokens: string; fill: string }>) {
  const { purchase, amounts, terms, routed, payment, walletFee, quoteCoin } = controls;
  return <dl className={styles.terms}>
    {routed && !compact ? <div><dt>Transaction details</dt><dd><details><summary>Route, fees and minimum</summary><dl><SwapTerms payment={payment} walletFee={walletFee} quoteCoin={quoteCoin} /></dl></details></dd></div> : null}
    {!purchase ? <div><dt>Estimated tokens <small>if closed now</small></dt><dd className={styles.num}>{tokens}</dd></div> : null}
    <div><dt>{purchase ? "Payment allocated" : "Allocation"}</dt><dd>{purchase ? fill : amounts.quote > 0 ? allocationLine(terms) : "—"}</dd></div>
    <div><dt>Tokens unlock</dt><dd>At launch, no lockup</dd></div>
  </dl>;
}

function CommitPurchaseOptions({ controls }: Readonly<{ controls: ReturnType<typeof useCommitPanelControls> }>) {
  const { amounts, terms, sale, onDetails, why, whyError, whyId, hintId, length, busy, setWhy } = controls;
  const [open, setOpen] = useState(whyError !== null);
  const [kind, setKind] = useState<"allocation" | "message">(whyError ? "message" : "allocation");
  const [lastError, setLastError] = useState(whyError);
  const titleId = useId();
  if (lastError !== whyError) {
    setLastError(whyError);
    if (whyError) { setKind("message"); setOpen(true); }
  }
  const fill = amounts.quote > 0 ? `${Math.round(terms.fill * 100)}% at current funding` : "—";
  const close = () => setOpen(false);
  return <>
    <div className={styles.compactDetails}>
      <button aria-haspopup="dialog" disabled={busy} onClick={() => { setKind("allocation"); setOpen(true); }} type="button">Allocation details <span aria-hidden="true">→</span></button>
      <button aria-haspopup="dialog" disabled={busy} onClick={() => { setKind("message"); setOpen(true); }} type="button">{why ? "Edit message" : "Add a message"} <span className="sr-only">Optional</span><span aria-hidden="true">→</span></button>
    </div>
    <Sheet initialFocus={kind === "message" ? () => document.getElementById(whyId) : undefined} labelledBy={titleId} onRequestClose={close} open={open}>
      <SheetClose onClick={close} />
      <SheetHeading id={titleId} title={kind === "message" ? "Add a message" : "Allocation details"} />
      {kind === "message" ? <>
        <CommitWhy why={why} whyError={whyError} whyId={whyId} hintId={hintId} length={length} busy={busy} setWhy={setWhy} />
        <button className="btn btn-quiet btn-block" onClick={close} type="button">Done</button>
      </> : <>
        <CommitTermsList compact controls={controls} tokens="—" fill={fill} />
        <p className={styles.context}>Final allocation is set at close.</p>
        <a className={styles.detailsLink} href={`/presale/${sale.presaleId}`} onClick={onDetails}>Presale details <span aria-hidden="true">→</span></a>
      </>}
    </Sheet>
  </>;
}

function CommitExtras({ controls }: Readonly<{ controls: ReturnType<typeof useCommitPanelControls> }>) {
  const { purchase, sale, why, whyError, whyId, hintId, length, busy, setWhy, onDetails } = controls;
  const disclosure = useRef<HTMLDetailsElement>(null);
  useEffect(() => { if (whyError && disclosure.current) disclosure.current.open = true; }, [whyError]);
  const whyField = <CommitWhy why={why} whyError={whyError} whyId={whyId} hintId={hintId} length={length} busy={busy} setWhy={setWhy} />;
  return <>
      {purchase ? <>
        <details className={styles.disclosure}>
          <DisclosureSummary>How this presale works</DisclosureSummary>
          <p className={styles.context}>Allocation is set at close. Unused payment is refunded; a full refund is available if the target is missed. Claim tokens at launch, with no lockup.</p>
        </details>
        <a className={styles.detailsLink} href={`/presale/${sale.presaleId}`} onClick={onDetails}>Presale details <span aria-hidden="true">→</span></a>
      </> : null}
      <details className={clsx(styles.disclosure, styles.optional)} ref={disclosure}>
        <DisclosureSummary>Add a message <span>Optional</span></DisclosureSummary>
        {whyField}
      </details>
  </>;
}

function commitActionLabels(primary: CommitPrimary, pay: number, payWith: CommitPayCoin, purchase: boolean) {
  if (!purchase) return { label: primary.label, signIn: "Sign in to blast" };
  return { label: primary.action === "commit" && primary.label !== "Swap & contribute" ? `Buy allocation · ${coinMoney(pay, payWith)}` : primary.label, signIn: "Sign in to buy allocation" };
}

function CommitActionLabel({ controls }: Readonly<{ controls: ReturnType<typeof useCommitPanelControls> }>) {
  const { busy, phaseLabel, session, purchase, action } = controls;
  if (busy) return <><Spinner />{phaseLabel}</>;
  if (session.sessionPending) return purchase ? "Sign in to buy allocation" : "Sign in to blast";
  return action.label;
}

function CommitAction({ controls, compact }: Readonly<{ controls: ReturnType<typeof useCommitPanelControls>; compact?: boolean }>) {
  const { active, allocationUsed, purchase, inline, action, busy, noteId, primaryId, primaryExtra, submit, session, payment, insufficient } = controls;
  // The one primary action. A transaction's phase stays on it ("Confirm in your wallet"); a session or route read keeps the resting label's width.
  const primaryButton = (
    <Button
      aria-busy={busy || undefined}
      aria-describedby={allocationUsed ? noteId : undefined}
      className={styles.primary}
      disabled={action.disabled || !active}
      id={primaryId}
      loading={!busy && (session.sessionPending || (!allocationUsed && payment.loading && !insufficient))}
      loadingLabel={session.sessionPending ? "Restoring session…" : "Checking swap route…"}
      onClick={() => void submit()}
      size={compact ? "md" : "lg"}
      variant="primary"
      {...(primaryExtra ?? {})}
    >
      <CommitActionLabel controls={controls} />
    </Button>
  );
  const dock = <>{primaryButton}{!allocationUsed ? <p className={styles.commitTerms}>{compact ? "Locked until close. Full refund if the target is missed." : "Locked until close. Unallocated payment refunded; full refund if the target is missed."}</p> : null}</>;
  if (purchase) return <div className={styles.purchaseFooter}>{dock}</div>;
  return inline ? dock : <SheetDock>{dock}</SheetDock>;
}
