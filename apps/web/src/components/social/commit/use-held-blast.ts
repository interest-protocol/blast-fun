"use client";

import { useEffect, useMemo, useRef, type CSSProperties } from "react";

import { feelBarFor, holdAriaLabel, holdLabel, useFeelHold, type FeelHoldProps, type HoldTimers } from "#web/components/blast-feel/index.ts";
import { useToast } from "#web/components/blast-ui/Toasts.tsx";
import { commitOffLine } from "@blast/core/web/contracts/commit.ts";
import { coinMoney, commitAmounts, commitRefusal, QUICK_COMMIT_MAX_IMPACT_BPS, type CommitInput } from "@blast/core/modules/social/commit/quote.ts";
import type { FeedItem, FeedItemPresale } from "@blast/core/web/contracts/items.ts";
import type { SocialTradeQuote } from "@blast/core/modules/social/contracts/trades.ts";

import { commitErrorText, HOLD_COIN_PRICE_OFF, HOLD_VALUE_UNKNOWN, quickAvailableUsd, quickInput } from "./commit-input";
import { useCommitKit } from "../feed-ui/shell-bridge";
import { saleLifecycleAt } from "@blast/core/web/contracts/presales.ts";
import { commitFactsAt, commitQuoteUsd, sourceThroughName } from "./commit-view";
import type { CommitFacts, CommitKit, CommitSendResult } from "./commit-kit";
import type { CommitBlastInput } from "./CommitPanel";
import { prepareCommitPayment, saleQuoteCoin } from "./commit-payment";

/**
 * Hold to blast on any Blast button (R3-13, OA-25 Q3: "hold-to-blast on every
 * Blast button, through T-024's commit route and refusals").
 *
 * The gesture is the Feel layer's (`useFeelHold`); everything about the money
 * is the **one commit module's**, through the commit host's kit
 * (`commit-kit.ts`, R3-54) — exactly what Blast mode's quick blast confirms
 * through:
 *
 *  - **the ladder's bound** is the viewer's available dollars from the commit quote's own
 *    reads (`kit.quotes`, the Blast wallet route), warmed at the press and
 *    read at every step — never a guess;
 *  - **the quote at the release** is `quotes.fresh` (no older than the sale
 *    read's own lifetime) run through `commit/quote.ts`'s refusals: blasting
 *    off, a sale that closed while held, the allowlist, the minimum, the wallet
 *    cap with what is already in, the balance. A refusal shakes the ball, says
 *    the refusal in the gate's words and writes nothing;
 *  - **the write** is `kit.send` — the commit dialog's own `blastWith` →
 *    `runCommitFor` → `runCommit`: the blockers, the signature, the intent
 *    registered through `callSocialApi` with the transaction digest as its
 *    idempotency key (T-024), the transaction-log row (R3-27), the toast with
 *    its explorer link and the `land` / `error` sound. A held blast carries
 *    no why and pays with the coin chosen in Settings (`kit.holdCoin`; by
 *    default the sale's own coin), swapping when it is another coin and
 *    refusing a swap that moves the price more than
 *    `QUICK_COMMIT_MAX_IMPACT_BPS`. It never pays with a coin other than the
 *    chosen one. It credits the post it came through when it came through one.
 *
 * With no commit host above (a page outside the shell, a fixture without a
 * kit), or for a visitor, the button keeps only its own press.
 */

export type HeldBlastTarget = Readonly<{
  presaleId: string;
  name: string;
  /** The sale takes commitments (its lifecycle is `open` and its start has passed, `saleLifecycleAt`); the quote re-checks the clock at the release. */
  open: boolean;
  /** How full (0..1), for where the ball lands; null when unknown. */
  fill: number | null;
  /**
   * The post a "Blast" came through, read at the release: the intent
   * credits its entry (T-024, stored only if visible) and the toast names its
   * author. Null for a surface that is not a post.
   */
  source?: () => Readonly<{ entryId: string | null; through: string | null }>;
}>;

export type HeldBlastOptions = Readonly<{
  /** The kit to commit through; the shell's commit host's by default. */
  kit?: CommitKit | null;
  /** The press stays a plain press: Blast mode's panel is open on this sale, or another card is armed. */
  blocked?: boolean;
  /** A held blast went through: repaint the sale from the route. */
  onSent?: (presaleId: string) => void;
  /** An owner's task registry (R3-60): the hold's timers and listeners stop with it. */
  tasks?: HoldTimers;
}>;

export type HeldBlast = Readonly<{
  /** Spread on the button; empty while the hold is off. */
  holdProps: Partial<FeelHoldProps>;
  charging: boolean;
  /** True from the release until the write has answered. */
  blasting: boolean;
  /** The button's label: the charge or the amount on its way, else the button's own. */
  label: (own: string) => string;
  /** The accessible name while it charges or sends, else undefined (the button keeps its own). */
  ariaLabel: string | undefined;
  className: string;
  style: CSSProperties | undefined;
}>;

const usd = (value: number) => coinMoney(value, "USDC");

/** The refusal's own words: the published line for the blasting-off wall, else the gate's (`commitErrorText`). */
export function heldRefusalText(input: CommitInput | null): string | null {
  if (input === null) return commitErrorText("unreadable", null);
  const refusal = commitRefusal(input);
  if (refusal === null) return null;
  if (refusal === "blocked") return commitOffLine(input.blockers);
  return commitErrorText(refusal, input);
}

/** What the release judged: the facts and the commitment the write will send. */
export type HeldJudgement = Readonly<{ facts: CommitFacts; input: CommitInput; order: CommitBlastInput; quote: SocialTradeQuote | null }>;

type HeldKit = Pick<CommitKit, "quotes" | "quotePayment" | "holdCoin" | "inputBalance" | "paymentCoin">;

function needsPaymentMetadata(facts: CommitFacts, type: string) {
  return facts.sale !== null &&
    (type !== saleQuoteCoin(facts.sale).coinType || commitQuoteUsd(facts.sale, facts.viewer) === null);
}

async function readHeldPayment(kit: HeldKit, presaleId: string) {
  const [facts, coinType] = await Promise.all([
    kit.quotes.fresh(presaleId),
    kit.holdCoin ? kit.holdCoin.read().catch(() => undefined) : null,
  ]);
  if (!facts?.sale || coinType === undefined) return null;
  const address = facts.wallet?.address;
  if (kit.inputBalance && !address) return null;
  const type = coinType ?? saleQuoteCoin(facts.sale).coinType;
  const [exact, metadata] = await Promise.all([
    address ? kit.inputBalance?.read(address, type).catch(() => null) : undefined,
    needsPaymentMetadata(facts, type) ? kit.paymentCoin?.read(type).catch(() => null) : undefined,
  ]);
  return { facts, coinType, exact, metadata: metadata ?? undefined };
}

/**
 * The quote at the release: the commit quote's fresh facts (`quotes.fresh`,
 * joining a read in flight), the Settings pay coin (`holdCoin.read`), the
 * amount as a commitment in that coin with no why (`quickInput`), its swap
 * quote when it is not the sale's coin, and `commit/quote.ts`'s refusal in
 * the gate's words. Nothing is built or sent here.
 */
export async function judgeHeldBlast(
  kit: HeldKit,
  presaleId: string,
  amountUsd: number,
  nowMs: number | (() => number),
): Promise<Readonly<{ refusal: string }> | HeldJudgement> {
  const unreadable = { refusal: commitErrorText("unreadable", null) };
  const funding = await readHeldPayment(kit, presaleId);
  if (!funding || funding.exact === null) return unreadable;
  const now = typeof nowMs === "number" ? () => nowMs : nowMs;
  const facts = commitFactsAt(funding.facts, now());
  const quick = quickInput(facts, amountUsd, now(), funding.coinType, funding.exact, funding.metadata);
  if (quick === null) return unreadable;
  if ("refusal" in quick) return quick;
  const payment = await prepareCommitPayment(quick.input, quick.coin, kit.quotePayment, now, null, QUICK_COMMIT_MAX_IMPACT_BPS);
  if ("refusal" in payment) return payment;
  const { quote } = payment;
  if (quote === null) return { facts, ...payment };
  const refreshed = commitFactsAt(facts, now());
  const sale = refreshed.sale ?? payment.input.sale;
  const quoteUsd = commitQuoteUsd(sale, refreshed.viewer);
  const input = {
    ...payment.input,
    sale: { ...sale, quoteDecimals: payment.input.sale.quoteDecimals },
    viewer: { ...payment.input.viewer, quoteUsd },
  };
  const { usd } = commitAmounts(input);
  const priceRefusal = swapValueRefusal(quote, usd, amountUsd);
  if (priceRefusal !== null) return { refusal: priceRefusal };
  return { facts: refreshed, input, quote, order: { ...payment.order, usd } };
}

/**
 * The coin was sized at the wallet's price; the swap's guaranteed output says
 * what it is really worth, and there is no confirm screen to catch a wrong
 * price. Above the cap over the dollars asked, or below them by more than the
 * route's own costs (impact, fees, slippage) plus the cap, refuses. With no
 * dollar value for the output there is nothing to check against, so it
 * refuses too.
 */
function swapValueRefusal(quote: SocialTradeQuote, usd: number, amountUsd: number): string | null {
  if (!(usd > 0)) return HOLD_VALUE_UNKNOWN;
  const costBps = (quote.price_impact_bps ?? 0) + (quote.fee_bps ?? 0) + (quote.blast_fee_bps ?? 0) + quote.slippage_bps;
  const most = amountUsd * (1 + QUICK_COMMIT_MAX_IMPACT_BPS / 10_000);
  const least = amountUsd * (1 - (costBps + QUICK_COMMIT_MAX_IMPACT_BPS) / 10_000);
  return usd > most || usd < least ? HOLD_COIN_PRICE_OFF : null;
}

/**
 * The write: one `kit.send` — the commit dialog's own flow — with the judged
 * amounts, in USDC, an empty why, and the post it came through.
 */
export function sendHeldBlast(
  kit: Pick<CommitKit, "send">,
  judged: HeldJudgement,
  source: Readonly<{ entryId: string | null; through: string | null }> | null,
): Promise<CommitSendResult> {
  return kit.send(
    judged.facts,
    judged.order,
    source ? { source } : undefined,
  );
}

/** A post's Blast: its sale, and the post as the source. */
export function heldTargetOfItem(item: FeedItem, viewerCallsign: string | null, nowMs = Date.now()): HeldBlastTarget | null {
  const presale = item.presale;
  if (!presale) return null;
  return {
    ...heldTargetOfPresale(presale, nowMs),
    source: () => ({ entryId: item.entry_id, through: sourceThroughName(item, viewerCallsign) }),
  };
}

/** A sale as the feed and Home's live reads carry it (Today on Blast, a post's chip), at `nowMs`: one scheduled to open later does not charge (#588). */
export function heldTargetOfPresale(presale: FeedItemPresale, nowMs = Date.now()): HeldBlastTarget {
  const raised = Number(presale.raised);
  const target = Number(presale.raise_target);
  return {
    presaleId: presale.presale_id,
    name: presale.name,
    open: saleLifecycleAt(presale.lifecycle, presale.start_ms, nowMs) === "open",
    fill: target > 0 && Number.isFinite(raised) ? Math.min(1, raised / target) : null,
  };
}

export function useHeldBlast(target: HeldBlastTarget | null, options: HeldBlastOptions = {}): HeldBlast {
  const shellKit = useCommitKit();
  const kit = options.kit === undefined ? shellKit : options.kit;
  const toast = useToast();
  const enabled = kit !== null && kit.signedIn && target !== null && target.open && options.blocked !== true;
  // The quote the release judged, handed to the write that follows it.
  const judged = useRef<HeldJudgement | null>(null);
  // Handlers read the target and kit as they are now, not as they were when the press began.
  const latest = useRef({ kit, target, onSent: options.onSent });
  useEffect(() => {
    latest.current = { kit, target, onSent: options.onSent };
  });

  const charge = useFeelHold({
    enabled,
    tasks: options.tasks,
    availableUsd: () => {
      const { kit: now, target: sale } = latest.current;
      if (!now || !sale) return null;
      const coinType = now.holdCoin ? now.holdCoin.peek() : null;
      const facts = commitFactsAt(now.quotes.peek(sale.presaleId).facts, Date.now());
      if (!facts?.sale || coinType === undefined) return null;
      if (!now.inputBalance) return quickAvailableUsd(facts, coinType);
      if (!facts.wallet?.address) return null;
      const type = coinType ?? saleQuoteCoin(facts.sale).coinType;
      const exact = now.inputBalance.peek(facts.wallet.address, type);
      const metadata = needsPaymentMetadata(facts, type) ? now.paymentCoin?.peek(type) : null;
      return exact === null ? null : quickAvailableUsd(facts, coinType, exact, metadata ?? undefined);
    },
    saleName: target?.name ?? "",
    fill: target?.fill ?? null,
    bar: (button) => (target ? feelBarFor(button, target.presaleId) : null),
    onPress: () => {
      const { kit: now, target: sale } = latest.current;
      if (!now || !sale) return;
      // Read only for the interaction, never for every card that renders a Blast button.
      void readHeldPayment(now, sale.presaleId);
    },
    quote: async (amountUsd) => {
      const { kit: now, target: sale } = latest.current;
      judged.current = null;
      if (!now || !sale) return commitErrorText("unreadable", null);
      const judgement = await judgeHeldBlast(now, sale.presaleId, amountUsd, Date.now);
      if ("refusal" in judgement) return judgement.refusal;
      judged.current = judgement;
      return null;
    },
    onRefused: (message) => toast(message),
    onBlast: async () => {
      const { kit: now, target: sale, onSent } = latest.current;
      const held = judged.current;
      judged.current = null;
      if (!now || !sale || !held || held.facts.sale?.presaleId !== sale.presaleId) throw new Error("nothing judged");
      const result = await sendHeldBlast(now, held, sale.source?.() ?? null);
      // The host played the outcome's sound and toasted a success; a refusal's sentence is ours to show.
      if (result.status === "pending") return;
      if (result.status === "sent") onSent?.(sale.presaleId);
      else toast(result.message ?? "That didn’t go through. Nothing was sent.");
    },
  });

  const name = target?.name ?? "";
  const shownUsd = charge.charging ? charge.amountUsd : charge.sendingUsd;
  return useMemo<HeldBlast>(
    () => ({
      holdProps: enabled ? charge.holdProps : {},
      charging: charge.charging,
      blasting: charge.blasting,
      label: (own) => (shownUsd === null ? own : holdLabel(shownUsd, usd)),
      ariaLabel: shownUsd === null ? undefined : holdAriaLabel(shownUsd, name, usd),
      className: charge.chargeClassName,
      style: charge.chargeStyle,
    }),
    [charge.blasting, charge.chargeClassName, charge.chargeStyle, charge.charging, charge.holdProps, enabled, name, shownUsd],
  );
}
