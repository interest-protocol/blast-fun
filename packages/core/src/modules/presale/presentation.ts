import {
  NOT_OPEN_YET,
  fillPct,
  multiple,
  opensAt,
  qm,
  qs,
  qsRaised,
  quoteOf,
  readsInCoin,
  utc,
  utcDay,
  venueName,
} from "@blast/core/lib/format.ts";
import { short } from "@blast/core/lib/compact-dollars.ts";
import type {
  PresalePhase,
  SocialPresaleDetail,
  SocialPresaleSummary,
  SocialPresaleVesting,
  SocialPresaleViewerEntry,
} from "@blast/core/modules/social/contracts/presales.ts";
import { vestingDurationText } from "@blast/core/modules/social/contracts/vesting.ts";

import { exactAtoms, exactDecimal, groupedExact } from "@blast/core/lib/exact-amount.ts";

export function claimableTokenText(sale: Pick<SocialPresaleSummary, "sale_decimals" | "symbol">, mine: SocialPresaleViewerEntry["mine"]): string | null {
  if (mine?.claimed) return null;
  const amount = exactAtoms(mine?.claimable_tokens, sale.sale_decimals ?? -1);
  return amount === null ? null : `${groupedExact(amount, amount.scale)} ${sale.symbol}`;
}

/**
 * Pure presentation rules of the presales list and sale page (FEATURE-MAP
 * §9, §10): which words, figures and states each phase shows. Copy is the
 * design's; where the design has none (a closed-but-unsettled sale, a
 * trading sale before its first claim) it is marked OA-13.
 */

export const PHASE_LABEL: Readonly<Record<PresalePhase, string>> = {
  pending: "Upcoming",
  open: "Live",
  closed: "Closed",
  funded: "Funded",
  trading: "Trading",
  cancelled: "Cancelled",
};

/** Compare atoms before formatting: even one excess atom is oversubscribed. */
export function fundingAmount(raisedAtoms: string, targetAtoms: string) {
  const raised = BigInt(raisedAtoms);
  const target = BigInt(targetAtoms);
  let relationship: "unknown" | "below" | "reached" | "oversubscribed" = "below";
  if (target <= 0n) relationship = "unknown";
  else if (raised > target) relationship = "oversubscribed";
  else if (raised === target) relationship = "reached";
  const percent = target > 0n ? raised * 10_000n / target : null;
  let percentage = "–";
  if (percent !== null) {
    percentage = `${percent / 100n}.${String(percent % 100n).padStart(2, "0")}%`;
    if (relationship === "oversubscribed" && percent === 10_000n) percentage = ">100%";
  }
  return { relationship, percentage, progress: Math.min(100, Number(percent ?? 0n) / 100) };
}

export function fundingState(detail: SocialPresaleDetail, nowMs: number) {
  const { presale: sale, terms } = detail;
  const { relationship, percentage, progress } = fundingAmount(sale.raised_atoms, sale.target_atoms);
  // Only an explicit parsed flag confirms the model; missing terms remain unknown.
  const oversubscription = terms?.hard_cap === false;
  const open = sale.phase === "open" && nowMs < sale.end_ms;
  const phase = sale.phase === "open" && !open ? "closed" : sale.phase;
  const label = { unknown: "Target unavailable", below: `${percentage} of target`, reached: "Target reached", oversubscribed: "Oversubscribed" }[relationship];
  let participation = PHASE_LABEL[phase];
  if (open) {
    participation = "Commitments open";
    if (relationship === "unknown" || (relationship !== "below" && !oversubscription)) participation = "Check commitment availability";
  }
  return { relationship, percentage, progress, oversubscription, open, phase, label, participation };
}

export type TeamUnlockState =
  | Readonly<{ kind: "configured"; durationMs: number; cliffMs: number }>
  | Readonly<{ kind: "pending" | "loading" | "error" | "unavailable" | "none" | "cancelled" }>;

/** Missing terms or ambiguous post-launch reads cannot promise a future schedule. */
export function teamUnlockState(detail: SocialPresaleDetail, read: "ready" | "loading" | "error" = "ready"): TeamUnlockState {
  if (detail.presale.phase === "cancelled") return { kind: "cancelled" };
  if (detail.team_vesting) {
    const schedule = vestingTerms(detail.team_vesting);
    if (schedule.durationMs > 0) return { kind: "configured", ...schedule };
    return { kind: "unavailable" };
  }
  if (detail.terms?.supply.recipients.every((recipient) => BigInt(recipient.amount) === 0n)) return { kind: "none" };
  if (read !== "ready") return { kind: read };
  if (detail.terms === null || detail.presale.phase === "trading" || detail.terms.supply.recipients.some((recipient) => recipient.vesting !== null)) return { kind: "unavailable" };
  return { kind: "pending" };
}

/** A USD decimal string as a number (0 when absent). */
export function n(value: string | null | undefined): number {
  const parsed = value == null ? NaN : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function ended(phase: PresalePhase): boolean {
  return phase !== "open" && phase !== "pending";
}

/** The colour a sale's progress bar takes once it has stopped filling (`Bar`'s `stage`). */
export type BarStage = "funded" | "trading" | "cancelled";

/**
 * OA-24: a sale's bar wears its stage once it has stopped filling — funded
 * blue, trading neutral, cancelled grey — on the presale rows and the sale
 * page's strip; null (the pink fill) while it is open or before. A closed,
 * unsettled sale keeps the fill too: the gate draws no such stage.
 */
export function barStage(phase: PresalePhase): BarStage | null {
  return phase === "funded" || phase === "trading" || phase === "cancelled" ? phase : null;
}

/**
 * The sale sheet's bar takes only funded and cancelled, as the gate's sheet
 * rule and Blast mode's panel bar do; a trading sale's sheet keeps the fill.
 */
export function sheetBarStage(phase: PresalePhase): BarStage | null {
  return phase === "funded" || phase === "cancelled" ? phase : null;
}

/** The ratio of raised over target, two places: `1.25`. */
export function oversubscribed(sale: Pick<SocialPresaleSummary, "fill_bps">): string {
  return (sale.fill_bps / 10_000).toFixed(2);
}

export type WhenText =
  | Readonly<{ kind: "left"; endMs: number }>
  | Readonly<{ kind: "opens"; day: string; time: string }>
  | Readonly<{ kind: "multiple"; value: string; up: boolean }>
  | Readonly<{ kind: "oversubscribed"; value: string }>
  | Readonly<{ kind: "plain"; text: string }>;

/** A list row's "when" column. */
export function whenOf(sale: SocialPresaleSummary): WhenText {
  switch (sale.phase) {
    case "open":
      return { kind: "left", endMs: sale.end_ms };
    case "pending": {
      const opens = opensAt(sale.start_ms);
      if (opens === null) return { kind: "plain", text: NOT_OPEN_YET };
      const [day, time] = utc(opens).split(", ");
      return { kind: "opens", day, time };
    }
    case "trading":
      return sale.multiple === null
        ? { kind: "plain", text: `Trading on ${venueName(sale.venue)}` }
        : { kind: "multiple", value: multiple(Number(sale.multiple)), up: Number(sale.multiple) >= 1 };
    case "funded":
      return sale.fill_bps > 10_000 ? { kind: "oversubscribed", value: `${oversubscribed(sale)}×` } : { kind: "plain", text: "Funded" };
    case "cancelled":
      return { kind: "plain", text: "Refunds open" };
    case "closed":
      return { kind: "plain", text: "Settling" };
  }
}

/** Only protocol lifecycle milestones belong here; claims and vesting are separate actions. */
export const STEPS = ["Open", "Closed", "Trading"] as const;

export function stepIndex(phase: PresalePhase): number {
  return { pending: 0, open: 0, closed: 1, funded: 1, trading: 2, cancelled: -1 }[phase];
}

export function stepLabel(label: (typeof STEPS)[number], phase: PresalePhase): string {
  if (label === "Open" && phase === "pending") return "Opens";
  if (label === "Closed" && (phase === "pending" || phase === "open")) return "Closes";
  return label;
}

/** Elapsed commitment time, never an estimate of settlement or trading readiness. */
export function stepProgress(phase: PresalePhase, times: Readonly<{ startMs: number | null; endMs: number }>, nowMs: number): number {
  if (phase !== "open" || times.startMs === null || times.startMs <= 0 || times.endMs <= times.startMs) return 0;
  return Math.max(0, Math.min(1, (nowMs - times.startMs) / (times.endMs - times.startMs)));
}

export function stepSubs(detail: SocialPresaleDetail): readonly string[] {
  const sale = detail.presale;
  const opened = sale.opened_ms ?? sale.start_ms;
  return [
    sale.phase === "pending" ? (opensAt(sale.start_ms) === null ? NOT_OPEN_YET : utc(sale.start_ms)) : `Opened ${utcDay(opened)}`,
    sale.phase === "pending" ? "At close" : utcDay(sale.ended_ms ?? sale.end_ms),
    sale.launched_ms ? utcDay(sale.launched_ms) : `On ${venueName(sale.venue)}`,
  ];
}

/** The third strip figure: what happens next, never the status again. */
export function nextFigure(sale: SocialPresaleSummary): Readonly<{ label: string; at: number | null; note: string; countdownTo?: number }> {
  if (sale.phase === "open") return { label: "Closes", at: null, note: utc(sale.end_ms), countdownTo: sale.end_ms };
  if (sale.phase === "trading") return { label: "Launched", at: sale.launched_ms ?? sale.end_ms, note: `on ${venueName(sale.venue)}` };
  if (sale.phase === "funded") return { label: "Closed", at: sale.ended_ms ?? sale.end_ms, note: "Claims open at launch" };
  if (sale.phase === "closed") return { label: "Closed", at: sale.end_ms, note: "Settling on chain" };
  return { label: "Ended", at: sale.ended_ms ?? sale.end_ms, note: "Refunds are open" };
}

/** A vesting's length and cliff in milliseconds, without rounding short schedules. */
export function vestingTerms(vesting: SocialPresaleVesting): Readonly<{ durationMs: number; cliffMs: number }> {
  const durationMs = Math.max(0, vesting.end_ms - vesting.start_ms);
  return { durationMs, cliffMs: Math.min(durationMs, Math.max(0, vesting.cliff_end_ms - vesting.start_ms)) };
}

/** The design's `vestNote`: "Vests 12 mo, 3-mo cliff" or "Vests 6 mo". */
export function vestNote(vesting: SocialPresaleVesting): string {
  const { durationMs, cliffMs } = vestingTerms(vesting);
  return `Vests ${vestingDurationText(durationMs)}${cliffMs ? `, ${vestingDurationText(cliffMs).replace(" ", "-")} cliff` : ""}`;
}

/** The design's `vestPlain`: the unlock curve in words, with the share that unlocks at the cliff. */
export function vestPlain(durationMs: number, cliffMs = 0): string {
  const duration = vestingDurationText(durationMs);
  if (!cliffMs) return `Unlocks steadily from launch, all of it after ${duration}. No one can cancel the schedule.`;
  return `Nothing unlocks for ${vestingDurationText(cliffMs)}. Then ${Math.round((cliffMs / durationMs) * 100)}% unlocks at once, and the rest steadily until ${duration} after launch. No one can cancel the schedule.`;
}

/**
 * The design's `vestViz` to scale: the hatched cliff's width and the ramp's
 * start as a share of the length (0 without a cliff), and whether the cliff's
 * month is labelled on the axis (only away from both ends).
 */
export function vestCurve(durationMs: number, cliffMs: number): Readonly<{ cliffPct: number; labelCliff: boolean }> {
  const cliffPct = durationMs > 0 ? Math.min(100, (cliffMs / durationMs) * 100) : 0;
  return { cliffPct, labelCliff: cliffPct >= 18 && cliffPct <= 82 };
}

/** A payload carrying its sale's quote coin (R3-40). */
export type QuoteSource = Readonly<{ quote_symbol: string; quote_decimals: number }>;

/** A figure of zero, in either form. */
const ZERO = { usd: "0", atoms: "0" } as const;

/**
 * R3-40: a sale figure in the sale's own coin, the gate's `qm` — `$184,221`
 * for a USDC sale (its `*_usd`, exactly as `usd(n(…))` read before), `184,221
 * SUI` for a SUI sale (its atoms and decimals). An unknown figure reads as
 * zero in that coin, as `n()` always made it.
 */
export function saleMoney(sale: QuoteSource, usdValue: string | null | undefined, atoms: string | null | undefined, digits = 0): string {
  const quote = quoteOf(sale);
  return qm(quote, { usd: usdValue ?? null, atoms: atoms ?? null }, digits) ?? qm(quote, ZERO, digits)!;
}

/** R3-40: the same figure compact, the gate's `qs` — `$250K`, `100K SUI`. */
export function saleShort(sale: QuoteSource, usdValue: string | null | undefined, atoms: string | null | undefined): string {
  const quote = quoteOf(sale);
  return qs(quote, { usd: usdValue ?? null, atoms: atoms ?? null }) ?? qs(quote, ZERO)!;
}

/**
 * R3-40: `bps` of a quote figure, exactly — the gate's `qm(s, s.target * b /
 * 1e4)`: the atoms times the basis points, read with four more decimals, so
 * no share is floored to an atom first. A USDC sale keeps its dollar rule.
 */
export function saleShare(sale: QuoteSource, usdValue: string | null | undefined, atoms: string | null | undefined, bps: number): string {
  const quote = quoteOf(sale);
  const shareUsd = (n(usdValue) * bps) / 10_000;
  if (atoms === null || atoms === undefined || !/^(0|[1-9][0-9]*)$/.test(atoms)) return saleMoney(sale, String(shareUsd), "0");
  const widened = { symbol: quote.symbol, decimals: quote.decimals + 4 };
  return qm(widened, { usd: String(shareUsd), atoms: (BigInt(atoms) * BigInt(Math.max(0, Math.round(bps)))).toString() })!;
}

/**
 * A dollar figure the gate prints for every sale (`usd`, `short`), or `–`
 * when the read has none: a SUI sale's dollars need the SUI price, and
 * without it no figure is guessed (R3-40).
 */
export function orDash(value: string | null | undefined, format: (value: number) => string): string {
  return value === null || value === undefined ? "–" : format(n(value));
}

/** The Oversubscribed example amount: twice the target, short (in the sale's coin). */
export function doubleTarget(sale: Pick<SocialPresaleSummary, "target_usd" | "target_atoms" | "quote_symbol" | "quote_decimals">): string {
  const atoms = /^(0|[1-9][0-9]*)$/.test(sale.target_atoms) ? (BigInt(sale.target_atoms) * 2n).toString() : null;
  return saleShort(sale, String(n(sale.target_usd) * 2), atoms);
}

export { utcDay };

export function isOversubscribed(sale: Pick<SocialPresaleSummary, "raised_atoms" | "target_atoms">): boolean {
  return BigInt(sale.target_atoms) > 0n && BigInt(sale.raised_atoms) > BigInt(sale.target_atoms);
}

/** Keep tiny overflows visible even when the list's whole percentage rounds to 100. */
export function fundingPercentText(sale: SocialPresaleSummary): string {
  const percent = fillPctOf(sale);
  return `${isOversubscribed(sale) && percent <= 100 ? ">100" : percent}%`;
}

/** The whole percentage a raise is filled, by the design's rule (`fillPct`). */
export function fillPctOf(sale: Pick<SocialPresaleSummary, "fill_bps">): number {
  return fillPct(sale.fill_bps);
}

/** R3-40: a row's target in the sale's coin (`qs`): `$400K`, `100K SUI`; `–` when unknown. */
export function targetText(sale: SocialPresaleSummary): string {
  return qs(quoteOf(sale), { usd: sale.target_usd, atoms: sale.target_atoms }) ?? "–";
}

/**
 * R3-40: a row's raised figure in the sale's coin, floored while it fills
 * (`qsRaised`): `$399K`, `99.9K SUI`. A USDC sale without a target figure
 * reads its raise compact, as before; `–` when the raise is unknown.
 */
export function raisedText(sale: SocialPresaleSummary): string {
  const quote = quoteOf(sale);
  const raised = { usd: sale.raised_usd, atoms: sale.raised_atoms };
  return qsRaised(quote, raised, { usd: sale.target_usd, atoms: sale.target_atoms }) ?? qs(quote, raised) ?? "–";
}

/**
 * The Rules' "Per wallet": the limits in the sale's own coin (a SUI sale's
 * from its atoms, which an unpriced SUI never loses, R3-40). OA-13: an
 * allowlisted sale takes any amount up to each wallet's own cap (its
 * allowlist leaf's).
 */
export function perWalletText(sale: SocialPresaleDetail["presale"]): string {
  if (sale.allowlisted) return "up to each wallet's cap";
  const coin = readsInCoin(quoteOf(sale));
  if ((coin ? sale.min_commitment_atoms : sale.min_commitment_usd) === null) return "–";
  const from = saleMoney(sale, sale.min_commitment_usd, sale.min_commitment_atoms);
  if ((coin ? sale.wallet_cap_atoms : sale.wallet_cap_usd) === null) return `From ${from}`;
  return `${from} to ${saleMoney(sale, sale.wallet_cap_usd, sale.wallet_cap_atoms)}`;
}

/** FDV at the presale price: the price times the supply, in the sale's coin (`qs`); exact for a SUI sale. Null without a price. */
export function fdvText(sale: SocialPresaleDetail["presale"], terms: NonNullable<SocialPresaleDetail["terms"]>): string | null {
  const quote = quoteOf(sale);
  if (readsInCoin(quote)) {
    const price = exactDecimal(terms.presale_price_quote);
    if (price === null) return null;
    return qs({ symbol: quote.symbol, decimals: price.scale + sale.sale_decimals }, { usd: null, atoms: (price.n * BigInt(terms.supply.total)).toString() });
  }
  return terms.presale_price_usd ? short(n(terms.presale_price_usd) * (Number(terms.supply.total) / 10 ** sale.sale_decimals)) : null;
}
