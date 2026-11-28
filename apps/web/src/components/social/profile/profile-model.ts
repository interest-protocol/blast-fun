import { HIDDEN_AMOUNT, multiple, px, qm, qty, quoteOf, readsInCoin, timeLeft, usd, usd0 } from "@blast/core/web/format.ts";
import { exactAtoms, exactDecimal, groupedExact, subtractExact } from "@blast/core/web/exact-amount.ts";
import type {
  MePresalePosition,
  MeVesting,
  ProfileCall,
  ProfilePresale,
  ProfilePresaleStatus,
  ProfileTrackRecord,
  SocialProfileMutuals,
} from "@blast/core/web/contracts/profile-page.ts";
import type { SocialPortfolio } from "@blast/core/web/contracts/portfolio.ts";
import { vestingDurationText } from "@blast/core/web/contracts/vesting.ts";
import type { Claims } from "../claim/use-claims";
import { saleClaimTarget, type ClaimTarget } from "../claim/claims";

/**
 * The profile page's view model (canonical UI §6, §5.5): pure functions from
 * the routes' answers to the strings and classes the components render, so
 * every format is tested once. Copy is the prototype's unless noted (OA-13).
 */

/** The design's status chip labels (`LIFE`) and classes (`.status.<class>`). */
export const STATUS_LABELS: Readonly<Record<ProfilePresaleStatus, string>> = {
  pending: "Upcoming",
  open: "Open",
  closed: "Closed",
  funded: "Funded",
  trading: "Trading",
  cancelled: "Cancelled",
};

const num = (value: string | null): number | null => (value === null ? null : Number(value));

/**
 * A sale amount on a profile row: whole dollars for every sale, as the gate's
 * calls, positions and "in right now" rows draw them (`usd(x.amt)`,
 * `usd(x.usd)`; a SUI sale's dollars from the read). R3-40: a SUI amount with
 * no dollar figure (no SUI price) reads in SUI from its atoms, never a guess.
 */
export function rowMoney(presale: ProfilePresale, usdValue: string | null, atoms: string | null): string {
  if (usdValue !== null) return usd(Math.round(Number(usdValue)));
  if (!readsInCoin(quoteOf(presale))) return "—";
  const amount = exactAtoms(atoms, presale.quote_decimals);
  return amount === null ? "—" : `${groupedExact(amount, presale.quote_decimals)} ${presale.quote_symbol}`;
}

export type TrackTile = Readonly<{ label: string; value: string; tone: "up" | "down" | null }>;

/**
 * Presale participation counts; the separate PnL tile uses account trading
 * history rather than the calls' hypothetical performance.
 */
export function trackTiles(record: ProfileTrackRecord | null): readonly TrackTile[] {
  return [
    { label: "Presales backed", value: record ? String(record.presales_backed) : "–", tone: null },
    { label: "Backed, now trading", value: record ? String(record.launched) : "–", tone: null },
  ];
}

/** The mutuals line: "Followed by Luca, Mira, Ana and others you follow" (the last part only when there are more). */
export function mutualsLine(mutuals: SocialProfileMutuals): string | null {
  const names = mutuals.accounts.map((account) => (account.display_name ?? account.callsign).split(" ")[0]);
  if (names.length === 0) return null;
  if (mutuals.total > names.length) return `Followed by ${names.join(", ")} and others you follow`;
  if (names.length === 1) return `Followed by ${names[0]}`;
  return `Followed by ${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

export type CallRow = Readonly<{
  presale: ProfilePresale;
  sub: string;
  /** A trading call's multiple, or null (the row then shows its status chip). */
  result: Readonly<{ text: string; tone: "up" | "down" }> | null;
  status: Readonly<{ label: string; tone: ProfilePresaleStatus }>;
  hasSeries: boolean;
  /** The account's thesis on the call (its latest active why), one line under the row; null without one. */
  why: string | null;
}>;

/**
 * A call row: "$25,000 at $0.0005 · now $0.0021" (the design's), or "$2,000
 * committed" while the presale price is not known yet (OA-13: it comes from
 * claims, after launch).
 */
export function callRow(call: ProfileCall): CallRow {
  const committed = rowMoney(call.presale, call.committed_usd, call.committed_atoms);
  // The gate's call row: `usd(x.amt) at px(price) · now px(now)`, dollars for every sale.
  const entry = num(call.entry_price_usd);
  const now = num(call.price_usd);
  const m = num(call.multiple);
  const sub = entry === null ? `${committed} committed` : `${committed} at ${px(entry)}${m !== null && now !== null ? ` · now ${px(now)}` : ""}`;
  return {
    presale: call.presale,
    sub,
    result: m === null ? null : { text: multiple(m), tone: m >= 1 ? "up" : "down" },
    status: { label: STATUS_LABELS[call.presale.status], tone: call.presale.status },
    hasSeries: call.series !== null,
    why: call.why?.trim() || null,
  };
}

export type SideRow = Readonly<{
  presale: ProfilePresale;
  sub: string;
  /** The right column; `inner` draws the top figure in the row's small type, as the design's fill figure renders. */
  right: Readonly<{ top: string; bottom?: string; tone: "up" | "down" | null; inner?: boolean }> | null;
  status: ProfilePresaleStatus | null;
}>;

/** An open sale's line on an "In right now" row (the boards): "62% filled · 2d left". */
function openLine(presale: ProfilePresale, nowMs: number): string {
  return `${presale.fill_pct}% filled · ${timeLeft(presale.end_ms - nowMs)} left`;
}

/** "In right now" for someone else, from their open calls: "73% filled · 6h 12m left" and what they put in, "$15,000". */
export function inRightNowOf(calls: readonly ProfileCall[], nowMs: number): SideRow[] {
  return calls
    .filter((call) => call.presale.status === "open")
    .map((call) => ({
      presale: call.presale,
      sub: openLine(call.presale, nowMs),
      right: { top: rowMoney(call.presale, call.committed_usd, call.committed_atoms), tone: null },
      status: null,
    }));
}

/** "In right now" on one's own profile and Portfolio, from one's open positions: "62% filled · 2d left" and "500 SUI" in. */
export function ownInRightNow(positions: readonly MePresalePosition[], nowMs: number, hidden: boolean): SideRow[] {
  return positions
    .filter((position) => position.status === "open")
    .map((position) => ({
      presale: position.presale,
      sub: openLine(position.presale, nowMs),
      right: { top: hidden ? HIDDEN_AMOUNT : rowMoney(position.presale, position.committed_usd, position.committed_atoms), tone: null },
      status: null,
    }));
}

/** "Backed together": the viewer's positions in presales the other account called. */
export function backedTogether(
  firstName: string,
  positions: readonly MePresalePosition[],
  calls: readonly ProfileCall[],
  hidden: boolean,
): SideRow[] {
  const theirs = new Map(calls.map((call) => [call.presale.presale_id, call]));
  return positions.flatMap((position) => {
    const call = theirs.get(position.presale.presale_id);
    if (!call) return [];
    const m = num(call.multiple);
    const mine = hidden ? HIDDEN_AMOUNT : rowMoney(position.presale, position.committed_usd, position.committed_atoms);
    return [{
      presale: call.presale,
      sub: `You ${mine} · ${firstName} ${rowMoney(call.presale, call.committed_usd, call.committed_atoms)}`,
      right: m === null ? null : { top: multiple(m), bottom: "since presale", tone: m >= 1 ? "up" as const : "down" as const },
      status: m === null ? call.presale.status : null,
    }];
  });
}

/** The gold card's figures (USD numbers; null when unknown). */
export type GoldFigures = Readonly<{
  total: number | null;
  committed: number | null;
  claimable: number | null;
  tokens: number | null;
  usdc: number | null;
  sui: number | null;
  /** SUI held, in SUI. */
  suiQty: number | null;
  /** USDC held, in USDC (known without a price). */
  usdcQty?: number | null;
}>;

/**
 * §6.3: total = USDC + SUI + committed + claimable + tokens. Tokens is the
 * portfolio's sale coins held (T-020 `coins`, the same values as the
 * holdings card's coin rows), unknown while a coin has no fresh price, which
 * makes the total unknown too. Any unavailable holding or balance makes
 * the total unknown rather than smaller; an empty coin list is a known zero.
 *
 * R3-40: Committed and Claimable are the portfolio's own `commitments` — every
 * quote's positions in dollars, a SUI sale's at SUI's price, valued exactly
 * on the server by the daily snapshot's rule (`position-value.ts`), so the
 * card and the snapshot agree. They used to sum USDC-quoted positions only,
 * which dropped a SUI commitment from the card entirely. Every part is
 * dollars: the total sums one unit.
 */
export function goldFigures(portfolio: SocialPortfolio | null): GoldFigures {
  if (!portfolio) return { total: null, committed: null, claimable: null, tokens: null, usdc: null, sui: null, suiQty: null, usdcQty: null };
  const commitments = portfolio.positions === null ? null : portfolio.commitments;
  const committed = commitments?.committed_usd != null ? commitments.committed_usd_subcent ?? num(commitments.committed_usd) : null;
  const claimable = commitments?.claimable_usd != null ? commitments.claimable_usd_subcent ?? num(commitments.claimable_usd) : null;
  // USDC counts at $1, as the shell's balance card counts it (T-019 gives no USD without a fresh price).
  const usdc = portfolio.balances ? Number(portfolio.balances.usdc.atoms) / 1e6 : null;
  const sui = portfolio.balances?.sui.atoms === "0" ? 0 : portfolio.balances?.sui.usd_subcent ?? num(portfolio.balances?.sui.usd ?? null);
  const suiQty = portfolio.balances ? Number(portfolio.balances.sui.atoms) / 1e9 : null;
  const usdcQty = portfolio.balances ? Number(portfolio.balances.usdc.atoms) / 1e6 : null;
  const coins = portfolio.coins?.filter((coin) => coin.balance !== "0");
  const summary = portfolio.coin_summary;
  const tokens = summary ? (summary.value_usd === null ? null : summary.known_value_usd_exact ?? Number(summary.value_usd)) : coins && coins.every((coin) => coin.value_usd !== null)
    ? coins.reduce((total, coin) => total + (Number(coin.value_usd) || Number(coin.value_usd_exact ?? 0)), 0)
    : null;
  const parts = [committed, claimable, usdc, sui, tokens];
  const total = parts.every((part) => part !== null) ? parts.reduce<number>((a, b) => a + (b as number), 0) : null;
  return { total, committed, claimable, tokens, usdc, sui, suiQty, usdcQty };
}

/** A coin of the holdings card: USDC, SUI and the presale tokens the wallets hold (T-020). */
export type HoldingCoin = Readonly<{
  coinType?: string;
  compactQuantityText?: string;
  key: string;
  name: string;
  symbol: string;
  /** A presale token's presale (its row links there); null for USDC and SUI. */
  presaleId: string | null;
  /** A Blast bonding-curve launch's id (its `/coin/<launchId>` page); null or absent for every other coin. */
  launchId?: string | null;
  /** The coin's mark: a round coin logo or a presale's square mark. */
  icon: string;
  round: boolean;
  usd: number | null;
  quantity: number | null;
  /** Exact wallet amount; stays in integer/decimal text through rendering. */
  quantityText?: string;
  category?: string;
  /** Blast checked who is behind the coin (`verified_team`, a sale or a curve coin); absent for SUI and USDC. */
  verifiedTeam?: boolean;
}>;

/** USDC and SUI from the portfolio's balances. */
export function balanceCoins(figures: GoldFigures): HoldingCoin[] {
  return [
    { key: "sui", name: "SUI", symbol: "SUI", presaleId: null, icon: "/blast-ui/coins/sui.svg", round: true, usd: figures.sui, quantity: figures.suiQty },
    { key: "usdc", name: "USDC", symbol: "USDC", presaleId: null, icon: "/blast-ui/coins/usdc.svg", round: true, usd: figures.usdc, quantity: figures.usdcQty ?? figures.usdc },
  ];
}

/** The value split as the design's `money()`: `$4,760` and `.34`. */
export function moneyParts(value: number): Readonly<{ whole: string; cents: string }> {
  const [whole, cents] = value.toFixed(2).split(".");
  return { whole: `$${Number(whole).toLocaleString("en-US")}`, cents: `.${cents}` };
}

export type HoldingRight =
  | Readonly<{ kind: "figures"; top: string; bottom: string; bottomAtMs?: number; tone: "up" | "down" | null }>
  /** Claimed in place, from the row (A-03, A-04): what the button runs. */
  | Readonly<{ kind: "claim"; label: string; target: ClaimTarget }>;

export type PositionView = Readonly<{ presale: ProfilePresale; sub: string; right: HoldingRight }>;

/** A position of the holdings card (§6.4, the live design's Presales tab). */
export function positionView(position: MePresalePosition, hidden: boolean, nowMs: number): PositionView {
  const hide = (text: string) => (hidden ? HIDDEN_AMOUNT : text);
  const { presale } = position;
  const committed = hide(rowMoney(presale, position.committed_usd, position.committed_atoms));
  const cancelled = presale.status === "cancelled";
  if (position.status === "delivered" && cancelled) {
    // The gate's "$N refunded to USDC", in dollars; R3-40: the refund comes back in the sale's own coin, and names it.
    const refunded = rowMoney(presale, position.refunded_usd ?? position.committed_usd, position.refunded_atoms ?? position.committed_atoms);
    const coin = presale.quote_symbol;
    return { presale, sub: `${hide(refunded)} refunded to ${coin}`, right: { kind: "figures", top: "Refunded", bottom: `to ${coin}`, tone: null } };
  }
  if (position.status === "delivered") {
    return deliveredPosition(position, committed, hide);
  }
  if (position.status === "claimable") {
    // The toast's refund in two places (the gate's `usd(amt, 2)`), never hidden: it is the claim's own answer.
    const refund = qm(quoteOf(presale), { usd: position.committed_usd, atoms: position.committed_atoms }, 2) ?? rowMoney(presale, position.committed_usd, position.committed_atoms);
    return cancelled
      ? { presale, sub: `${committed} refund ready`, right: { kind: "claim", label: "Claim refund", target: saleClaimTarget("claim_refund", presale, refund) } }
      : { presale, sub: `${committed} committed`, right: { kind: "claim", label: "Claim", target: saleClaimTarget("claim_tokens", presale, refund) } };
  }
  if (position.status === "open") return { presale, sub: `${committed} committed`, right: { kind: "figures", top: "Open", bottom: `${timeLeft(presale.end_ms - nowMs)} left`, tone: null } };
  return { presale, sub: `${committed} committed`, right: { kind: "figures", top: presale.status === "funded" ? "Funded" : "Closed", bottom: "claims at launch", tone: null } };
}

function deliveredPosition(position: MePresalePosition, committed: string, hide: (text: string) => string): PositionView {
  const { presale } = position;
    const m = num(position.multiple);
    const tokens = position.claimed_tokens === null ? null : Number(position.claimed_tokens);
    return {
      presale,
      sub: tokens === null ? `${committed} committed` : `${hide(qty(tokens))} ${presale.symbol} claimed`,
      right: {
        kind: "figures",
        top: position.value_usd === null ? "Claimed" : hide(usd0(Number(position.value_usd))),
        bottom: m === null ? STATUS_LABELS[presale.status] : multiple(m),
        tone: m === null ? null : m >= 1 ? "up" : "down",
      },
    };
}

export type VestingView = Readonly<{
  presale: ProfilePresale;
  /** The coin the schedule pays (a creator's raise vests in the quote coin). */
  symbol: string;
  title: string;
  sub: string;
  bar: number;
  progress: string;
  fullyVestAtMs?: number;
  balances: Readonly<{ claimed: string; remaining: string; available: string }>;
  right: HoldingRight;
}>;

/**
 * A vesting schedule of the holdings card: "400,000 LUMN · linear over 12 mo,
 * 3-mo cliff", its unlocked share, and Claim or its state ("Cliff / ends
 * Jan 9" until the cliff ends, OA-18).
 */
export function vestingView(vesting: MeVesting, hidden: boolean, nowMs: number, claims?: Claims): VestingView {
  const view = indexedVestingView(vesting, hidden, nowMs);
  return claims?.view(`vesting:${vesting.schedule_id}`, vesting.claimed).state === "done"
    ? { ...view, progress: "Updating claimed balance", fullyVestAtMs: undefined, right: { kind: "figures", top: "Claimed", bottom: "Updating", tone: null } }
    : view;
}

function indexedVestingView(vesting: MeVesting, hidden: boolean, nowMs: number): VestingView {
  const hide = (text: string) => (hidden ? HIDDEN_AMOUNT : text);
  const { presale } = vesting;
  const symbol = vesting.symbol ?? presale.symbol;
  const duration = vestingDurationText(vesting.end_ms - vesting.start_ms);
  const cliffMs = Math.max(0, vesting.cliff_end_ms - vesting.start_ms);
  const claimable = exactDecimal(vesting.claimable);
  const available = claimable ? groupedExact(claimable, claimable.scale) : "—";
  const exactClaimed = exactDecimal(vesting.claimed);
  const claimedText = exactClaimed ? groupedExact(exactClaimed, exactClaimed.scale) : "—";
  const remainingText = remainingVestingText(vesting.total, vesting.claimed);
  const right: HoldingRight =
    nowMs < vesting.cliff_end_ms
      ? { kind: "figures", top: "Cliff", bottom: "ends", bottomAtMs: vesting.cliff_end_ms, tone: null }
      : claimable !== null && claimable.n > 0n
        ? {
          kind: "claim",
          label: `Claim ${hide(available)} ${symbol}`,
          target: {
            key: `vesting:${vesting.schedule_id}`,
            kind: "claim_vesting",
            presaleId: presale.presale_id,
            scheduleId: vesting.schedule_id,
            vesting: { claimed: vesting.claimed, claimable: vesting.claimable },
            // The gate's `Claimed N SYM` / `Name · label`; the schedule's label is not served (A-05), so the row's "Vesting".
            done: { title: `Claimed ${available} ${symbol}`, sub: `${presale.name} · Vesting` },
          },
        }
        : nowMs >= vesting.end_ms
          ? { kind: "figures", top: "Up to date", bottom: "fully unlocked", tone: null }
          : { kind: "figures", top: "Up to date", bottom: "next unlock soon", tone: null };
  return {
    presale,
    symbol,
    title: `${presale.name} · Vesting`,
    sub: `${hide(qty(Number(vesting.total)))} ${symbol} · linear over ${duration}${cliffMs ? `, ${vestingDurationText(cliffMs).replace(" ", "-")} cliff` : ""}`,
    bar: vesting.vested_pct,
    progress: `${vesting.vested_pct}% unlocked${nowMs < vesting.end_ms ? " · fully vested" : " · fully unlocked"}`,
    fullyVestAtMs: nowMs < vesting.end_ms ? vesting.end_ms : undefined,
    balances: { claimed: hide(claimedText), remaining: hide(remainingText), available: hide(available) },
    right,
  };
}

/** Remaining escrow includes unlocked tokens that have not yet been claimed. */
function remainingVestingText(total: string, claimed: string): string {
  const principal = exactDecimal(total);
  const released = exactDecimal(claimed);
  const remaining = principal && released ? subtractExact(principal, released) : null;
  return remaining === null ? "—" : groupedExact(remaining, remaining.scale);
}
