import { commitOffLine, type CommitBlocker } from "@blast/core/modules/social/contracts/commit.ts";

/**
 * The commit panel's arithmetic and copy (FEATURE-MAP §4, with R3's changes:
 * SUI as an input unit, the minimum in the sale's own quote coin, and the
 * primary button's SUI label). Pure: no React, no fetch, no clock of its own.
 * The dialog renders what this returns, and the tests drive it directly.
 *
 * Three amounts, never confused:
 *
 * - **typed** is the number in the box. Its unit is the pay coin.
 * - **usd** is the commitment in dollars. It is what the person thinks they
 *   are spending and what the posts and the toast print.
 * - **quote** is the commitment in the *sale's* coin, which is what the raise,
 *   the minimum, the wallet cap and the allocation are all counted in.
 *
 * For a USDC sale paid in USDC the three collapse into one, which is why the
 * reference's own fixture never exercises the rest. A SUI-quoted sale, or
 * paying in the coin the sale does not count in, keeps them apart.
 */

export type CommitPayCoin = string;

/** The sale, as the panel needs it. Amounts are whole coins, not atoms. */
export type CommitSale = Readonly<{
  presaleId: string;
  name: string;
  /** The sale token's symbol, for "≈ 90,000 MRDN". */
  symbol: string;
  /** The sale's phase (`presalePhase`), so an open sale before its start reads `pending`. */
  lifecycle: string;
  endMs: number;
  /** The coin the raise is counted in. */
  quoteCoin: CommitPayCoin;
  /** Exact quote type from the presale read; older base-coin fixtures may omit it. */
  quoteType?: string;
  /** A fresh indexed USD price for the sale’s exact quote coin. */
  quoteUsd?: number;
  /** R3-41: its decimals, as the view gives them (`quote_decimals`), for the viewer's atoms. */
  quoteDecimals?: number;
  /** The smallest commitment, in the quote coin; null for an allowlisted sale. */
  minCommitment: number | null;
  /** The most one wallet may hold, in the quote coin; null for an allowlisted sale. */
  walletCap: number | null;
  /** An allowlisted sale: each wallet's cap is its own allowlist leaf's. */
  allowlisted: boolean;
  eligibleUncappedFromMs?: number;
  publicBuy?: boolean;
  hardCapped?: boolean;
  remainingAtoms?: string;
  /** Raised and target, in the quote coin. */
  raised: number;
  target: number;
  /** Quote coin per whole sale token at the presale price; null without a price. */
  presalePrice: number | null;
}>;

/** What the viewer brings. Balances are whole coins. */
export type CommitViewer = Readonly<{
  usdc: number;
  sui: number;
  /** USD per SUI, for every conversion between the two. Null when no fresh price exists. */
  suiUsd: number | null;
  /** The sale's exact quote coin balance and price, including coins without a USD price. */
  quoteCoin?: string;
  quoteBalance?: number;
  quoteUsd?: number | null;
  /** What this wallet already holds in the sale, in the quote coin. */
  committed: number;
  /**
   * For an allowlisted sale: whether the viewer's wallet is on it, and the cap
   * its leaf gives them (quote coin). `null` while it is still being read.
   */
  allowlist: Readonly<{ on: boolean; cap: number | null }> | null;
}>;

export type CommitInput = Readonly<{
  sale: CommitSale;
  viewer: CommitViewer;
  payWith: CommitPayCoin;
  /** The box's contents, as typed. An empty box is "". */
  typed: string;
  /** The why box's contents. */
  why: string;
  /** The why's refusal, from the shared `validateWhy` (empty means none). */
  whyError: string | null;
  /** Why signing is off, from `commitAvailability`. Empty means it is on. */
  blockers: readonly CommitBlocker[];
  nowMs: number;
}>;

/** Two decimals at most, grouped, and no trailing zeros ("25", "14.62", "1,410.34"). */
export function coinAmount(value: number): string {
  return (Math.round(value * 100) / 100).toLocaleString("en-US", { maximumFractionDigits: 2 });
}

/** A money figure in whichever coin: "$500", "$12.50" or "25 SUI". */
export function coinMoney(value: number, coin: CommitPayCoin, digits?: number): string {
  if (coin !== "USDC") return `${coin === "SUI" ? coinAmount(value) : value.toLocaleString("en-US", { maximumFractionDigits: 18 })} ${coin}`;
  const places = digits ?? (Math.round(value * 100) % 100 === 0 ? 0 : 2);
  return value.toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: places, maximumFractionDigits: places });
}

/**
 * A commit with no confirm screen (hold to commit) refuses a swap whose price
 * impact is above this many basis points (3%); the commit window shows the
 * route and lets the person decide.
 */
export const QUICK_COMMIT_MAX_IMPACT_BPS = 300;

/** The ladder in each pay coin (R3: `SUI_PRESETS = [10, 25, 100]`, USDC unchanged). */
export const COMMIT_PRESETS_USDC = [50, 100, 500] as const;
export const COMMIT_PRESETS_SUI = [10, 25, 100] as const;

/** Digits and one dot, bounded by the payment coin’s decimals. */
export function sanitizeAmount(raw: string, decimals = 2): string {
  return raw
    .replace(/[^0-9.]/g, "")
    .replace(/(\..*)\./g, "$1")
    .replace(new RegExp(`^(\\d*\\.\\d{0,${decimals}}).*`), "$1");
}

/** The two decimals a coin amount is rounded down to, for a Max that is always payable. */
const floor2 = (value: number) => Math.floor(value * 100) / 100;
const ceil2 = (value: number) => Math.ceil(value * 100) / 100;

export type CommitAmounts = Readonly<{
  /** The number in the box. */
  typed: number;
  /** The commitment in dollars. */
  usd: number;
  /** What leaves the wallet, in the pay coin. */
  pay: number;
  /** The commitment in the sale's own coin. */
  quote: number;
}>;

/**
 * The three amounts from what was typed. Without a SUI price the two coins
 * cannot be converted, so a cross-coin amount is zero rather than a guess —
 * which lands the panel on "Enter an amount" instead of quoting a number
 * nobody can honour.
 */
export function commitAmounts(input: Pick<CommitInput, "sale" | "viewer" | "payWith" | "typed">): CommitAmounts {
  const typed = Number(sanitizeAmount(input.typed, input.sale.quoteDecimals ?? 2)) || 0;
  if (input.payWith === input.sale.quoteCoin && input.viewer.quoteCoin === input.payWith) {
    const usd = typed * (input.viewer.quoteUsd ?? 0);
    return { typed, usd: Math.round(usd * 100) / 100, pay: typed, quote: typed };
  }
  if (input.sale.quoteCoin !== "USDC" && input.sale.quoteCoin !== "SUI") {
    return { typed, usd: 0, pay: typed, quote: input.payWith === input.sale.quoteCoin ? typed : 0 };
  }
  const suiUsd = input.viewer.suiUsd;
  const usd = input.payWith === "SUI" ? (suiUsd === null ? 0 : typed * suiUsd) : typed;
  const quote =
    input.sale.quoteCoin === "SUI"
      ? input.payWith === "SUI"
        ? typed
        : suiUsd === null
          ? 0
          : typed / suiUsd
      : usd;
  return { typed, usd: Math.round(usd * 100) / 100, pay: typed, quote };
}

/** The pay coin's spendable balance, in the pay coin and in dollars. */
export function payBalance(input: Pick<CommitInput, "viewer" | "payWith">): Readonly<{ coin: number; usd: number }> {
  const { viewer, payWith } = input;
  if (viewer.quoteCoin === payWith) return { coin: viewer.quoteBalance ?? 0, usd: (viewer.quoteBalance ?? 0) * (viewer.quoteUsd ?? 0) };
  if (payWith === "SUI") return { coin: viewer.sui, usd: viewer.suiUsd === null ? 0 : viewer.sui * viewer.suiUsd };
  return payWith === "USDC" ? { coin: viewer.usdc, usd: viewer.usdc } : { coin: 0, usd: 0 };
}

export type CommitPreset = Readonly<{
  /** The preset's own value (`data-v`): a number, or "Max". */
  value: string;
  label: string;
  /** Set only when it differs from the label, as the reference's apple pass left it. */
  ariaLabel: string | null;
  pressed: boolean;
}>;

/** The ladder, with the one that matches what is typed pressed. */
export function commitPresets(input: Pick<CommitInput, "sale" | "viewer" | "payWith" | "typed">): readonly CommitPreset[] {
  const sui = input.payWith !== "USDC";
  const typed = commitAmounts(input).typed;
  const top = floor2(payBalance(input).coin);
  const rungs = (sui ? COMMIT_PRESETS_SUI : COMMIT_PRESETS_USDC).map((rung) => ({
    value: String(rung),
    label: sui ? String(rung) : coinMoney(rung, "USDC", 0),
    ariaLabel: sui ? `${rung} ${input.payWith}` : null,
    pressed: typed === rung,
  }));
  return [...rungs, { value: "Max", label: "Max", ariaLabel: null, pressed: typed !== 0 && typed === top }];
}

/** What a preset puts in the box, in the pay coin. */
export function presetAmount(value: string, input: Pick<CommitInput, "viewer" | "payWith">): number {
  if (value !== "Max") return Number(value);
  const balance = payBalance(input);
  return input.payWith === "SUI" ? floor2(balance.coin) : Math.floor(balance.coin);
}

export type CommitTerms = Readonly<{
  /** Sale tokens the commitment buys if the sale closed now; null without a price. */
  tokens: number | null;
  /** `after / target`. */
  multiple: number;
  /** The share of the commitment that is filled, 0 to 1. */
  fill: number;
  /** The commitment's share of the raise, as a percentage. */
  share: number;
}>;

/** The allocation maths of FEATURE-MAP §4, in the sale's own coin. */
export function commitTerms(sale: CommitSale, quote: number): CommitTerms {
  const after = sale.raised + quote;
  const multiple = sale.target > 0 ? after / sale.target : 0;
  const fill = multiple > 1 ? 1 / multiple : 1;
  const share = Math.max(sale.target, after) > 0 ? (quote / Math.max(sale.target, after)) * 100 : 0;
  const tokens = sale.presalePrice && sale.presalePrice > 0 ? Math.round((quote * fill) / sale.presalePrice) : null;
  return { tokens, multiple, fill, share };
}

/**
 * Why a commitment cannot go through, in the order the reference's own
 * `quoteCommit` checks them, with two the reference only reaches after the
 * button is pressed (`closed` and `cap`) and one it has no copy for at all
 * (`allowlist`). See `COMMIT_REFUSALS` for each one's words.
 */
export type CommitRefusal = "blocked" | "closed" | "allowlist" | "allocation_used" | "empty" | "min" | "cap" | "insufficient" | "why" | null;

/** The sale is taking commitments right now. */
export function saleIsOpen(sale: CommitSale, nowMs: number): boolean {
  return sale.lifecycle === "open" && nowMs < sale.endMs;
}

/** The smallest commitment, in the pay coin, as the button prints it. */
export function minimumLabel(input: Pick<CommitInput, "sale" | "viewer" | "payWith">): string | null {
  const { sale, viewer, payWith } = input;
  if (sale.minCommitment === null) return null;
  // The sale's own coin is the gate's `qm`: whole dollars without cents
  // ("Minimum is $10", as R3-41 has it), cents only when there are some.
  if (sale.quoteCoin === payWith) return coinMoney(sale.minCommitment, payWith);
  if (viewer.suiUsd === null) return null;
  // Rounded up, so paying exactly what the button names always clears the minimum.
  return payWith === "SUI"
    ? coinMoney(ceil2(sale.minCommitment / viewer.suiUsd), "SUI")
    : coinMoney(ceil2(sale.minCommitment * viewer.suiUsd), "USDC", 2);
}

function walletCapAt(sale: CommitSale, viewer: CommitViewer, nowMs: number): number | null {
  if (sale.eligibleUncappedFromMs !== undefined && nowMs >= sale.eligibleUncappedFromMs) return null;
  return sale.allowlisted ? (viewer.allowlist?.cap ?? null) : sale.walletCap;
}

/** The most this wallet may still put in, in the quote coin; null when there is no cap. */
export function walletRoom(sale: CommitSale, viewer: CommitViewer, nowMs: number): number | null {
  const cap = walletCapAt(sale, viewer, nowMs);
  if (cap === null) return null;
  return Math.max(0, cap - viewer.committed);
}

/** The wallet cap, in the pay coin, as the button prints it. */
export function capLabel(input: Pick<CommitInput, "sale" | "viewer" | "payWith" | "nowMs">): string | null {
  const { sale, viewer, payWith, nowMs } = input;
  const cap = walletCapAt(sale, viewer, nowMs);
  if (cap === null) return null;
  if (sale.quoteCoin === payWith) return coinMoney(cap, payWith, payWith === "SUI" ? undefined : 0);
  if (viewer.suiUsd === null) return null;
  return payWith === "SUI" ? coinMoney(cap / viewer.suiUsd, "SUI") : coinMoney(cap * viewer.suiUsd, "USDC", 0);
}

/**
 * Whether `quoteAmount` (in the sale's coin) is under the sale's minimum. A
 * public buy counts the wallet's whole position, in atoms, and lets the buy
 * that fills what is left through.
 */
function belowMinimum(input: CommitInput, quoteAmount: number): boolean {
  const { sale, viewer } = input;
  if (sale.minCommitment === null) return false;
  if (!sale.publicBuy) return quoteAmount < sale.minCommitment - 1e-9;
  const decimals = sale.quoteDecimals ?? 9;
  const offered = toAtoms(quoteAmount, decimals);
  const remaining = BigInt(sale.remainingAtoms ?? "0");
  const fillsRemaining = sale.hardCapped && remaining > 0n && offered >= remaining;
  const position = offered + toAtoms(viewer.committed, decimals);
  return !fillsRemaining && position < toAtoms(sale.minCommitment, decimals);
}

/**
 * The refusal the panel is standing on, or null when the commitment is good
 * to sign. Check sale and wallet eligibility before validating any amount. `insufficient` stays ahead of `why` exactly as the reference
 * has it (`!amt || under || (!!bad && !short1)`): "Add USDC" is an action, a
 * bad why is a correction, and the reference offers the action first.
 */
export function commitRefusal(input: CommitInput): CommitRefusal {
  const { sale, viewer } = input;
  if (input.blockers.length > 0) return "blocked";
  if (!saleIsOpen(sale, input.nowMs)) return "closed";
  if (sale.allowlisted && viewer.allowlist !== null && !viewer.allowlist.on) return "allowlist";
  const room = walletRoom(sale, viewer, input.nowMs);
  if (room === 0 && viewer.committed > 0) return "allocation_used";
  const amounts = commitAmounts(input);
  if (amounts.typed <= 0 || amounts.quote <= 0) return "empty";
  if (belowMinimum(input, amounts.quote)) return "min";
  if (room !== null && amounts.quote > room + 1e-9) return "cap";
  if (amounts.pay > payBalance(input).coin + 1e-9) return "insufficient";
  if (input.whyError) return "why";
  return null;
}

export type CommitPrimary = Readonly<{
  label: string;
  disabled: boolean;
  /** `deposit` opens the Deposit sheet; `commit` signs. A disabled button does neither. */
  action: "commit" | "deposit" | "none";
}>;

export const USED_ALLOCATION_MESSAGE = "You’ve already committed your full allocation.";

/** The primary button, in the reference's own words. */
export function commitPrimary(input: CommitInput): CommitPrimary {
  const refusal = commitRefusal(input);
  const amounts = commitAmounts(input);
  switch (refusal) {
    case "closed":
      return { label: `${input.sale.name} isn’t taking commitments`, disabled: true, action: "none" };
    case "allowlist":
      return { label: "You’re not on the allowlist", disabled: true, action: "none" };
    case "allocation_used":
      return { label: "Wallet limit reached", disabled: true, action: "none" };
    case "empty":
      return { label: "Enter an amount", disabled: true, action: "none" };
    case "min": {
      const minimum = minimumLabel(input);
      return { label: minimum ? `Minimum is ${minimum}` : "Enter a larger amount", disabled: true, action: "none" };
    }
    case "cap": {
      const cap = capLabel(input);
      return {
        label: cap ? `The most one wallet can put in is ${cap}` : "That is more than one wallet can put in",
        disabled: true,
        action: "none",
      };
    }
    case "insufficient":
      return { label: `Add ${input.payWith}`, disabled: false, action: "deposit" };
    case "why":
      return { label: "Fix your why to continue", disabled: true, action: "none" };
    case "blocked":
    case null:
    default:
      return {
        label: `Blast ${coinMoney(amounts.pay, input.payWith)}`,
        disabled: refusal === "blocked",
        action: refusal === "blocked" ? "none" : "commit",
      };
  }
}

/**
 * Why a commitment with no panel around it (hold to blast) is refused, in one
 * sentence, or null when it may be sent. The same refusal as the panel's, so
 * the gesture can never send what the dialog would have refused; only the
 * words differ where the panel's are a button ("Add USDC" is an action, not a
 * reason) or a line above it (blasting off).
 */
export function commitRefusalText(input: CommitInput): string | null {
  const refusal = commitRefusal(input);
  if (refusal === null) return null;
  if (refusal === "blocked") return commitOffLine(input.blockers);
  if (refusal === "insufficient") return "Not enough to cover it";
  if (refusal === "allocation_used") return USED_ALLOCATION_MESSAGE;
  return commitPrimary(input).label;
}

/**
 * The foot's left line: `Paid in USDC` when the pay coin is the sale's own,
 * and the conversion otherwise. R3 moved the figure to the *other* coin from
 * the one in the box, so the line never repeats what is already above it.
 */
export function conversionLine(input: Pick<CommitInput, "sale" | "viewer" | "payWith" | "typed">): string {
  const { sale, payWith } = input;
  if (sale.quoteCoin === payWith) return `Paid in ${payWith}`;
  const amounts = commitAmounts(input);
  if (input.viewer.suiUsd === null) return `Swapped to ${sale.quoteCoin} for you`;
  return payWith === "SUI"
    ? `≈ ${coinMoney(amounts.usd, "USDC", 2)}, swapped to USDC for you`
    : `≈ ${coinAmount(amounts.quote)} SUI, swapped to SUI for you`;
}

/** The foot's right line. */
export function balanceLine(input: Pick<CommitInput, "viewer" | "payWith">): string {
  return input.payWith !== "USDC"
    ? `Balance ${coinMoney(payBalance(input).coin, input.payWith)}`
    : `Balance ${coinMoney(input.viewer.usdc, "USDC", 2)}`;
}

/** The allocation row's words. */
export function allocationLine(terms: CommitTerms): string {
  return terms.multiple > 1
    ? `${terms.multiple.toFixed(1)}× oversubscribed · you'd get ~${Math.round(terms.fill * 100)}%`
    : "Under target · you get 100%";
}

/** The share row's words. */
export function shareLine(terms: CommitTerms): string {
  return `${terms.share < 0.01 ? "<0.01" : terms.share.toFixed(2)}%`;
}

/** The toast's title, in the coin that actually left the wallet. */
export function commitToastTitle(payAmount: number, payWith: CommitPayCoin, saleName: string): string {
  return `Blasted ${coinMoney(payAmount, payWith)} into ${saleName}`;
}

/**
 * The toast's sub-line (R3 dropped the amount, which the title already
 * carries): how it was paid, and the post it came through.
 */
export function commitToastSub(
  input: Readonly<{ payWith: CommitPayCoin; quoteCoin: CommitPayCoin; usd: number; quote: number; throughName: string | null }>,
): string {
  const paid =
    input.payWith === input.quoteCoin
      ? `Paid with ${input.payWith}`
      : input.payWith === "SUI"
        ? `Swapped to ${coinMoney(input.usd, "USDC", 2)} USDC`
        : `Swapped to ${coinAmount(input.quote)} SUI`;
  return input.throughName ? `${paid} · through ${input.throughName}’s post` : paid;
}

/**
 * Whole coins to atoms, floored, so a rounded display never asks for more than
 * was typed. The browser turns the panel's quote-coin amount into the atoms
 * it asks the commit route to build (`POST /api/social/me/commits`).
 */
export function toAtoms(amount: number, decimals: number): bigint {
  if (!Number.isFinite(amount) || amount <= 0) return 0n;
  const [whole = "0", fraction = ""] = amount.toFixed(Math.min(decimals, 20)).split(".");
  const padded = `${fraction}${"0".repeat(decimals)}`.slice(0, decimals);
  return BigInt(`${whole}${padded}`);
}
