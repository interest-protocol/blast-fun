import { coinPagePath } from "@blast/core/modules/launchpad-coin/page-key.ts";
import { ago, bxSigned, qs, qsRaised, qm, raisedShort, short, shortAddress, signPct, usd0 } from "@blast/core/web/format.ts";
import { amtExact, atLeastPow10, bxUsdExact, compareExact, exactAtoms, exactDecimal, groupedExact, numShortExact, shortQtyExact } from "@blast/core/web/exact-amount.ts";
import type { FeedItemActor } from "@blast/core/web/contracts/items.ts";
import type { HomeTapeEvent, HomeActivity, HomeAmount, HomeCoin, HomeEvent, HomeKind, HomeParticipant, HomeRecentBuy, HomeSide, HomeWindow } from "@blast/core/web/contracts/home.ts";
import type { DiscoveryResponse, DiscoveryRow } from "@blast/core/modules/launchpad-discovery/rows.ts";
import { HOME_BONDING_ROWS } from "@blast/core/modules/launchpad-discovery/bonding.ts";
import { BLAST_V1_COINS } from "@blast/core/modules/social/portfolio/core-coins.ts";
import { explorerTxUrl } from "../post/post-format";
import { presaleHref } from "../feed-ui/shell-bridge-model";
import { numberDecimal, readablePrice, readableUsd } from "#web/lib/market-format.ts";
import { ALMOST_GRADUATED_BPS } from "#web/components/launchpad/discovery/discovery-model.ts";

/**
 * Every word and figure the coin-centred Home draws, as plain values. Pure,
 * so each rule is tested without a DOM: how an amount names its asset, how a
 * participant's directions read, what a card's summary says and what its
 * thread entry point counts.
 *
 * Amounts (the brief's §10): "bought 100" is never enough. A figure names the
 * asset spent or received, the coin bought or sold, whether it is one trade
 * or several, and its window. Sums are per asset and never mixed; USD only
 * as the indexer priced the rows (`usd_complete`), otherwise the coin figure
 * stands and nothing reads $0.
 */

/** A coin's identity as the words need it. */
export type CoinWords = Readonly<{ symbol: string; decimals: number }>;

const COIN = (symbol: string | null, decimals: number | null) => (symbol !== null && decimals !== null ? { symbol, decimals } : null);

export type BondingColumn = "new" | "almost" | "graduated";
export const BONDING_COLUMN_ROWS = HOME_BONDING_ROWS;

/** Keep the catalog order and reserve four of the ten Graduated rows for V1 coins. */
export function columnRows(column: BondingColumn, answer: DiscoveryResponse | undefined): readonly DiscoveryRow[] | null {
  const section = answer?.section;
  if (!section || section.state === "unavailable") return null;
  if (section.state === "empty") return [];
  const rows = section.data.rows;

  if (column === "graduated") return rows.slice(0, BONDING_COLUMN_ROWS - BLAST_V1_COINS.length);

  const kept = column === "new"
    ? rows.filter((row) => row.progressBps === null || row.progressBps < ALMOST_GRADUATED_BPS)
    : rows.filter((row) => row.progressBps !== null && row.progressBps >= ALMOST_GRADUATED_BPS);
  return kept.slice(0, BONDING_COLUMN_ROWS);
}

export function graduatedColumnRows(rows: readonly DiscoveryRow[] | null, answer: DiscoveryResponse | undefined) {
  const launches = (rows ?? []).map((row) => ({
    kind: "launch" as const, row, cap: exactDecimal(answer?.metrics?.[row.launchId]?.market?.market_cap_usd),
  }));
  const legacy = BLAST_V1_COINS.map((coin) => {
    const value = answer?.legacyMarket?.[coin.coinType]?.marketCapUsd;
    return { kind: "legacy" as const, coin, value, cap: exactDecimal(value) };
  });
  return [...launches, ...legacy].sort((a, b) =>
    a.cap && b.cap ? compareExact(b.cap, a.cap) : Number(!a.cap) - Number(!b.cap));
}

/** A whole-coin figure from atoms: `100 SUI`, `1,234.5 SUI`; null for an asset the web cannot name. */
export function coinFigure(atoms: string, symbol: string | null, decimals: number | null, places = 2): string | null {
  const coin = COIN(symbol, decimals);
  if (coin === null) return null;
  const value = exactAtoms(atoms, coin.decimals);
  return value === null ? null : `${groupedExact(value, places)} ${coin.symbol}`;
}

/**
 * An amount as a card writes it: a USDC sum as dollars (`$370`; USDC is the
 * dollar quote), any other named asset in its own coin (`100 SUI`), an
 * unnamed one as "an unlisted coin". Nothing is converted: a SUI sum does not
 * become dollars here.
 */
export function amountText(amount: HomeAmount): string {
  if (amount.quote_symbol?.toUpperCase() === "USDC" && amount.quote_decimals !== null) {
    const value = exactAtoms(amount.atoms, amount.quote_decimals);
    return value === null ? "an unlisted coin" : `$${groupedExact(value, 0)}`;
  }
  return coinFigure(amount.atoms, amount.quote_symbol, amount.quote_decimals) ?? "an unlisted coin";
}

/** A compact amount in the coin it was traded in: "400K SUI", "1.3K USDC". */
export function amountShort(amount: HomeAmount): string {
  const coin = COIN(amount.quote_symbol, amount.quote_decimals);
  const value = coin && exactAtoms(amount.atoms, coin.decimals);
  return coin && value ? `${numShortExact(value)} ${coin.symbol}` : "an unlisted coin";
}

/** How loud a buy lands on its row: a quiet figure, a filled one from $100, and an icon that pops from $1,000. */
export type HomeBuyTier = "small" | "big" | "huge";
export type HomeBuyCue = Readonly<{ text: string; tier: HomeBuyTier }>;

/**
 * A live buy as its row flashes it, short enough to read in a glance: dollars
 * when the indexer priced it (`+$0.42`, `+$13`, `+$1.2K`), else the coin it
 * was paid in (`+13.5 SUI`). Null for an amount the web cannot read.
 */
export function buyCueOf(buy: Pick<HomeRecentBuy, "quote_atoms" | "quote_decimals" | "quote_symbol" | "usd">): HomeBuyCue | null {
  const usd = exactDecimal(buy.usd);
  if (usd) {
    const text = atLeastPow10(usd, 1) ? `$${numShortExact(usd)}` : bxUsdExact(usd);
    if (atLeastPow10(usd, 3)) return { text: `+${text}`, tier: "huge" };
    return { text: `+${text}`, tier: atLeastPow10(usd, 2) ? "big" : "small" };
  }
  const paid = exactAtoms(buy.quote_atoms, buy.quote_decimals);
  if (!paid) return null;
  return { text: `+${atLeastPow10(paid, 0) ? shortQtyExact(paid) : amtExact(paid)} ${buy.quote_symbol}`, tier: "small" };
}

/** The buy worth showing from one read: the most dollars, the newest among equals; an unpriced buy only when none is priced. */
export function biggestBuy(buys: readonly HomeRecentBuy[]): HomeRecentBuy | undefined {
  const usd = (buy: HomeRecentBuy) => exactDecimal(buy.usd) ?? { n: 0n, scale: 0 };
  return [...buys].sort((a, b) => compareExact(usd(b), usd(a)) || b.occurred_at_ms - a.occurred_at_ms)[0];
}

/**
 * The indexer's dollar value of an amount, when it priced every row: `$370`;
 * `$370+` when some rows were unpriced (a lower bound, said so); null when
 * none was priced. Never a figure for a sum that was not priced.
 */
export function usdText(amount: HomeAmount): string | null {
  if (amount.usd === null) return null;
  const value = usd0(Number(amount.usd));
  return amount.usd_complete ? value : `${value}+`;
}

/** The amounts of a side, every asset named, joined: `100 SUI`, or `100 SUI + $20`. */
export function sideAmounts(side: HomeSide): string {
  return side.amounts.map(amountText).join(" + ");
}

/** A count of events as the thread names them: `3 trades`, `1 commitment`. */
export function eventsWord(count: number, kind: "trade" | "commitment" | "claim" | "event"): string {
  return `${count.toLocaleString("en-US")} ${kind}${count === 1 ? "" : "s"}`;
}

/** Tokens of the sale's coin from atoms: `24,000 ORBIT`; null without a figure. */
export function tokensText(atoms: string | null, coin: CoinWords): string | null {
  if (atoms === null) return null;
  const value = exactAtoms(atoms, coin.decimals);
  return value === null ? null : `${groupedExact(value, 0)} ${coin.symbol}`;
}

/**
 * One direction of a participant in words, with its count when it is more
 * than one trade:
 *
 *     Bought 100 SUI of ORBIT across 3 trades
 *     Sold ORBIT for 40 SUI
 *     Backed with $150 across 2 commitments
 *     Claimed 500 ORBIT
 */
export function sideLine(kind: HomeKind, side: HomeSide, coin: CoinWords): string {
  const amounts = sideAmounts(side);
  switch (kind) {
    case "trade_buy":
      return `Bought ${amounts}${side.count > 1 ? ` · ${eventsWord(side.count, "trade")}` : ""}`;
    case "trade_sell":
      return `Sold for ${amounts}${side.count > 1 ? ` · ${eventsWord(side.count, "trade")}` : ""}`;
    case "presale_commit":
      return `Backed with ${amounts}${side.count > 1 ? ` · ${eventsWord(side.count, "commitment")}` : ""}`;
    case "presale_claim": {
      const tokens = tokensText(side.tokens, coin);
      // A zero refund (the sale filled exactly) is nothing to say.
      const refund = side.amounts.some((amount) => /[1-9]/.test(amount.atoms)) ? ` and ${amounts} back` : "";
      return `Claimed ${tokens ?? "tokens"}${refund}${side.count > 1 ? ` · ${eventsWord(side.count, "claim")}` : ""}`;
    }
  }
}

/** The directions a participant has, in the order a row lists them: its latest first, then the rest. */
export function participantSides(participant: HomeParticipant): readonly (readonly [HomeKind, HomeSide])[] {
  const sides: (readonly [HomeKind, HomeSide])[] = [];
  if (participant.buys) sides.push(["trade_buy", participant.buys]);
  if (participant.sells) sides.push(["trade_sell", participant.sells]);
  if (participant.commits) sides.push(["presale_commit", participant.commits]);
  if (participant.claims) sides.push(["presale_claim", participant.claims]);
  return sides.sort((a, b) => (a[0] === participant.latest_kind ? -1 : b[0] === participant.latest_kind ? 1 : b[1].latest_ms - a[1].latest_ms));
}

/** The same lines, each with its direction, for a row that draws a glyph by each. */
export function participantSideLines(participant: HomeParticipant, coin: CoinWords): readonly (readonly [HomeKind, string])[] {
  return participantSides(participant).map(([kind, side]) => [kind, sideLine(kind, side, coin)] as const);
}

/** The row's counts by direction, in the gate's order; only the directions that happened. */
export function directionCounts(activity: Pick<HomeActivity, "buyers" | "sellers" | "backers" | "claimers">): readonly (readonly [HomeKind, number])[] {
  const counts: (readonly [HomeKind, number])[] = [];
  if (activity.buyers > 0) counts.push(["trade_buy", activity.buyers]);
  if (activity.sellers > 0) counts.push(["trade_sell", activity.sellers]);
  if (activity.backers > 0) counts.push(["presale_commit", activity.backers]);
  if (activity.claimers > 0) counts.push(["presale_claim", activity.claimers]);
  return counts;
}

/**
 * A tape line after the name, around the coin's symbol (the component links
 * it): `sold $25 of ORBIT`, `bought 100 SUI of NOVA`, `backed HALO with
 * $150`, `claimed ORBIT`: what happened, in the asset it happened in.
 */
export function tapeParts(event: Pick<HomeTapeEvent, "kind" | "quote">): Readonly<{ before: string; after: string }> {
  const amount = event.quote ? amountText(event.quote) : null;
  switch (event.kind) {
    case "trade_buy":
      return { before: amount ? `bought ${amount} of` : "bought", after: "" };
    case "trade_sell":
      return { before: amount ? `sold ${amount} of` : "sold", after: "" };
    case "presale_commit":
      return { before: "backed", after: amount ? `with ${amount}` : "" };
    case "presale_claim":
      return { before: "claimed", after: "" };
  }
}

/** Compact dollars that never round a positive amount to `$0`: `$1.2K`, `$435`, `$0.05`, `$0.0₆1`. */
function dollars(value: number): string {
  return value > 0 && value < 1 ? readableUsd(numberDecimal(value)) : short(value);
}

/**
 * The window's volume in dollars: everything bought and sold (a presale's
 * commitments), `$1.2K`; `$370+` where the indexer left a row unpriced;
 * null without a dollar figure at all.
 */
export function volumeText(activity: Pick<HomeActivity, "bought" | "sold" | "committed">): string | null {
  const amounts = [...activity.bought, ...activity.sold, ...activity.committed];
  if (amounts.length === 0) return "$0";
  const priced = amounts.filter((amount) => amount.usd !== null);
  if (priced.length === 0) return null;
  const total = priced.reduce((sum, amount) => sum + Number(amount.usd), 0);
  const complete = amounts.every((amount) => amount.usd !== null && amount.usd_complete);
  return `${dollars(total)}${complete ? "" : "+"}`;
}

/** A USD amount for a tight figure, as volumes read: `$1.2K`, `$821`, `$0.42`. */
export function compactUsdText(usd: string): string {
  return dollars(Number(usd));
}

export function volumeLabel(window: HomeWindow, text: string | null, scope?: HomeActivity["scope"]): string {
  if (text === null) return `${window} volume unavailable`;
  const partial = text.endsWith("+");
  const coverage = scope === "followed" ? "followed trades" : scope ? "tracked trades" : null;
  const detail = [partial ? "partial" : null, coverage].filter(Boolean).join(", ");
  return `${window} volume: ${partial ? text.slice(0, -1) : text}${detail ? ` (${detail})` : ""}`;
}

/** Use the venue total when present. Label the narrower fallback from tracked trades. */
export function marketVolume(coin: Pick<HomeCoin, "activity" | "dex_volume">) {
  const { activity, dex_volume: volume } = coin;
  if (volume) {
    const text = volume.usd === null ? null : `${compactUsdText(volume.usd)}${volume.usd_complete ? "" : "+"}`;
    return { text, label: volumeLabel(activity.window, text) };
  }
  const hasAmounts = activity.bought.length + activity.sold.length + activity.committed.length > 0;
  const text = hasAmounts ? volumeText(activity) : null;
  return { text, label: volumeLabel(activity.window, text, activity.scope) };
}

/** A portfolio's value for a tight row: `$1.2K`; null when it is not shown. */
export function portfolioText(value: string | null): string | null {
  return value === null ? null : dollars(Number(value));
}

/**
 * A PnL with its tone; null when unknown. `compact` for a tight row (`+$120`,
 * `−$45`, `+$1.2K`); `full` where the board writes the whole figure, as Home's
 * Top traders do (`+$184,220`, `−$12.40`). Below half a cent it is `$0`.
 */
export function pnlText(pnl: string | null, form: "compact" | "full" = "compact"): Readonly<{ text: string; tone: "up" | "down" | "flat" }> | null {
  if (pnl === null) return null;
  const value = Number(pnl);
  if (Math.abs(value) < 0.005) return { text: "$0", tone: "flat" };
  const text = form === "full" ? bxSigned(value) : `${value > 0 ? "+" : "−"}${dollars(Math.abs(value))}`;
  return { text, tone: value > 0 ? "up" : "down" };
}

/** A share of the supply in basis points as the row writes it: `41%`, `0.5%`, `<0.1%`; null without one. */
export function shareText(bps: number | null): string | null {
  if (bps === null) return null;
  if (bps === 0) return "0%";
  if (bps < 10) return "<0.1%";
  if (bps < 100) return `${(bps / 100).toFixed(1)}%`;
  return `${Math.round(bps / 100)}%`;
}

/** The past tense of a direction: `bought`, `sold`, `backed`, `claimed`. */
export function verbOf(kind: HomeKind, past = true): string {
  switch (kind) {
    case "trade_buy":
      return past ? "bought" : "buy";
    case "trade_sell":
      return past ? "sold" : "sell";
    case "presale_commit":
      return past ? "backed" : "back";
    case "presale_claim":
      return past ? "claimed" : "claim";
  }
}

/** The person's name as a row shows it: the display name, else the callsign; a wallet by its short address. */
export function actorName(actor: FeedItemActor): string {
  return actor.type === "account" ? ((actor.display_name ?? "").trim() || actor.callsign) : actor.short;
}

/** The first name: `Maya` for Maya Park; the callsign without a display name; a wallet's short address. */
export function firstName(actor: FeedItemActor): string {
  const name = actorName(actor);
  return actor.type === "account" ? (name.split(/\s+/)[0] || name) : name;
}

/** `24 followers on Blast`; nothing under 5 (a count that small says nothing useful) or when unknown. */
export function followersText(count: number | null): string | null {
  if (count === null || count < 5) return null;
  return `${count.toLocaleString("en-US")} followers on Blast`;
}

export function windowWord(window: HomeWindow): string {
  return window === "1h" ? "the last hour" : "the last 24h";
}

function people(count: number, word: string): string {
  return `${count.toLocaleString("en-US")} ${word}`;
}

/** Up to two first names and a count of the rest: `Maya, Leo and 2 more`. */
export function namesOf(participants: readonly HomeParticipant[], total: number): string {
  const names = participants.slice(0, 2).map((row) => firstName(row.actor));
  const rest = total - names.length;
  if (names.length === 0) return people(total, total === 1 ? "person" : "people");
  if (rest <= 0) return names.length === 1 ? names[0]! : `${names[0]} and ${names[1]}`;
  return `${names.join(", ")} and ${rest.toLocaleString("en-US")} more`;
}

/**
 * The pool summary in parts, for a card that draws each count's glyph:
 * the counts with their directions (`["trade_buy", "5 bought"]`), then
 * the tail (` in the last 24h · 6 participants`, or the whole line when
 * nothing happened).
 */
export function poolSummaryParts(activity: HomeActivity): Readonly<{ counts: readonly (readonly [HomeKind, string])[]; tail: string }> {
  const window = windowWord(activity.window);
  const n = (value: number) => value.toLocaleString("en-US");
  const counts: (readonly [HomeKind, string])[] = [];
  if (activity.buyers > 0) counts.push(["trade_buy", `${n(activity.buyers)} bought`]);
  if (activity.sellers > 0) counts.push(["trade_sell", `${n(activity.sellers)} sold`]);
  if (activity.backers > 0) counts.push(["presale_commit", `${n(activity.backers)} backed`]);
  if (activity.claimers > 0) counts.push(["presale_claim", `${n(activity.claimers)} claimed`]);
  if (counts.length === 0) return { counts, tail: `No activity in its pool in ${window}` };
  const who = people(activity.participants, activity.participants === 1 ? "participant" : "participants");
  return { counts, tail: ` in ${window} · ${who}` };
}

/**
 * A presale's raise as the card writes it, in the sale's own coin: a USDC
 * sale in dollars (`$184K of $250K`, rounded down while it fills, as every
 * raise figure on Blast), any other quote in that coin (`399K SUI of 400K
 * SUI`). Null when a figure cannot be formed.
 */
export function raiseFigures(coin: Pick<HomeCoin, "quote" | "sale">): Readonly<{ raised: string | null; target: string | null }> {
  if (coin.sale === null) return { raised: null, target: null };
  const quote = { symbol: coin.quote.symbol, decimals: coin.quote.decimals };
  if (quote.symbol.toUpperCase() === "USDC") {
    const raised = exactAtoms(coin.sale.raised, quote.decimals);
    const target = exactAtoms(coin.sale.raise_target, quote.decimals);
    const dollars = (value: ReturnType<typeof exactAtoms>) => (value === null ? null : Number(groupedExact(value, 2).replaceAll(",", "")));
    const raisedUsd = dollars(raised);
    const targetUsd = dollars(target);
    return {
      raised: raisedUsd === null || targetUsd === null ? null : raisedShort(raisedUsd, targetUsd),
      target: targetUsd === null ? null : short(targetUsd),
    };
  }
  return {
    raised: qsRaised(quote, { usd: null, atoms: coin.sale.raised }, { usd: null, atoms: coin.sale.raise_target }),
    target: qs(quote, { usd: null, atoms: coin.sale.raise_target }),
  };
}

/**
 * A sale's raise in full, in the coin it raises (the owner's rule: "show the
 * coin they are raising"): `312,400 USDC`, `91,280.5 SUI`. The raised figure
 * floors, so a raise never reads as its target before it gets there; null
 * when a figure is unreadable.
 */
export function raiseAmounts(coin: Pick<HomeCoin, "quote" | "sale">): Readonly<{ raised: string | null; target: string | null }> {
  if (coin.sale === null) return { raised: null, target: null };
  const amount = (atoms: string, mode: "half-up" | "floor") => {
    const value = exactAtoms(atoms, coin.quote.decimals);
    return value === null ? null : `${groupedExact(value, 2, mode)} ${coin.quote.symbol}`;
  };
  return { raised: amount(coin.sale.raised, "floor"), target: amount(coin.sale.raise_target, "half-up") };
}

/** The lifecycle as the shared status chip tones it. */
export function lifecycleTone(lifecycle: string): "trading" | "open" | "funded" | "pending" | "cancelled" {
  switch (lifecycle) {
    case "migrated":
      return "trading";
    case "open":
    case "funded":
    case "pending":
    case "cancelled":
      return lifecycle;
    default:
      return "pending";
  }
}

/** The market facts, each with an explicit period and an honest absence (nothing, never 0). */
export type MarketFacts = Readonly<{
  price: string | null;
  /** `+12.5%` over 24 hours; null without a price a day ago. */
  change: Readonly<{ text: string; up: boolean }> | null;
  holders: string | null;
  fdv: string | null;
  age: string | null;
}>;

export function marketFacts(coin: HomeCoin, nowMs: number): MarketFacts {
  const price = coin.price_usd === null ? null : `$${readablePrice(coin.price_usd)}`;
  const change = coin.change_24h_bps === null ? null : { text: signPct(coin.change_24h_bps / 100), up: coin.change_24h_bps >= 0 };
  return {
    price,
    change,
    holders: coin.holders === null ? null : coin.holders.toLocaleString("en-US"),
    fdv: coin.fdv_usd === null ? null : readableUsd(coin.fdv_usd),
    age: coin.launched_ms === null ? null : ageText(coin.launched_ms, nowMs),
  };
}

/** `Launched 2h ago`, `Launched 3d ago`. */
export function ageText(launchedMs: number, nowMs: number): string {
  const text = ago(launchedMs, nowMs);
  return text === "now" ? "Launched just now" : `Launched ${text} ago`;
}

/** The event line of the thread: what was spent or received, and the coin the other way. */
export function eventLine(event: HomeEvent, coin: CoinWords): string {
  const quote = event.quote === null ? null : amountText(event.quote);
  const tokens = tokensText(event.tokens, coin);
  switch (event.kind) {
    case "trade_buy":
      return tradeLine("Spent", quote, tokens, coin, "Bought");
    case "trade_sell":
      return tokens && quote ? `${tokens} → ${quote}` : quote ? `Sold for ${quote}` : `Sold ${tokens ?? coin.symbol}`;
    case "presale_commit":
      return quote ? `Committed ${quote}` : "Committed";
    case "presale_claim":
      return claimLine(event, tokens);
  }
}

function tradeLine(verb: string, quote: string | null, tokens: string | null, coin: CoinWords, bare: string): string {
  if (quote && tokens) return `${quote} → ${tokens}`;
  if (quote) return `${verb} ${quote}`;
  return `${bare} ${tokens ?? coin.symbol}`;
}

function claimLine(event: HomeEvent, tokens: string | null): string {
  const refund = event.refund === null || event.quote === null || !/[1-9]/.test(event.refund) ? null : amountText({ ...event.quote, atoms: event.refund });
  if (tokens) return `Claimed ${tokens}${refund ? ` and ${refund} back` : ""}`;
  return refund ? `Refunded ${refund}` : "Claimed";
}

/**
 * An event as one sentence, the verb first and both legs after it:
 * `Bought $250 → 5,000 ORBIT`, `Sold 800 ORBIT → $40`, `Backed with $5`,
 * `Claimed 500 ORBIT`. The thread's one line for a single event, and each
 * row of a disclosure, so a direction is never said twice.
 */
export function eventSentence(event: HomeEvent, coin: CoinWords): string {
  const line = eventLine(event, coin);
  switch (event.kind) {
    case "trade_buy":
      return /^[A-Z]/.test(line) ? line : `Bought ${line}`;
    case "trade_sell":
      return /^[A-Z]/.test(line) ? line : `Sold ${line}`;
    case "presale_commit":
      return line.replace(/^Committed/, "Backed with");
    case "presale_claim":
      return line;
  }
}

/** The event's USD, said as the indexer priced it, with its own time. */
export function eventUsd(event: HomeEvent): string | null {
  return event.quote === null ? null : usdText(event.quote);
}

/** A participant's accessible name: `Maya, you follow, 24 followers on Blast`. */
export function participantLabel(participant: HomeParticipant): string {
  const parts = [actorName(participant.actor)];
  if (participant.actor.type === "address") parts.push("a wallet");
  if (participant.relation === "followed") parts.push("you follow");
  const followers = followersText(participant.followers);
  if (followers) parts.push(followers);
  return parts.join(", ");
}

export { explorerTxUrl, shortAddress, qm };

/** Flatten the newest indexed events, rather than presenting per-person aggregates as transactions. */
export function recentEvents(rows: readonly HomeParticipant[]) {
  return rows.flatMap((participant) => (participant.events ?? []).map((event) => ({ participant, event })))
    .sort((a, b) => b.event.occurred_at_ms - a.event.occurred_at_ms || a.event.activity_id.localeCompare(b.event.activity_id))
    .slice(0, 5);
}

/** A coin's own page: a sale's presale page, a curve coin's launch page; null for a coin with neither. */
export function homeCoinHref(coin: Pick<HomeCoin, "presale_id" | "launch_id" | "coin_type">): string | null {
  if (coin.presale_id !== null) return presaleHref(coin.presale_id);
  return coin.launch_id === null ? null : coinPagePath(coin.coin_type);
}

/** The existing presale identity or a standalone coin’s canonical type. */
export function homeCoinKey(coin: Pick<HomeCoin, "presale_id" | "coin_type">): string {
  return coin.presale_id ?? coin.coin_type;
}
