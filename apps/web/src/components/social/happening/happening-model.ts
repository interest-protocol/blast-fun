import { exactDecimal, groupedExact } from "@blast/core/web/exact-amount.ts";
import {
  NOT_OPEN_YET,
  fillPercent,
  fundWord,
  multiple,
  opensAt,
  px,
  qs,
  qsRaised,
  qty,
  quoteOf,
  raisedShort,
  readsInCoin,
  shortQty,
  timeLeft,
  times2,
  usd,
} from "@blast/core/web/format.ts";
import { short } from "@blast/core/lib/compact-dollars.ts";
import type { HappeningPresale, HappeningTapeEvent, SocialHappeningResponse } from "@blast/core/web/contracts/happening.ts";
import type { FeedItemPresale } from "@blast/core/web/contracts/items.ts";

import { utc, venueName } from "../post/post-format";
import { quoteUsd } from "@blast/core/web/format.ts";
import { saleLifecycleAt } from "@blast/core/web/contracts/presales.ts";

/**
 * Home's live column, ticker and recap as plain values (FEATURE-MAP §5, §16,
 * §17): every string the design draws, built from the public happening read.
 * Pure; the components only lay these out.
 */

/** The tape shows four rows; the rest of the read waits to slide in. */
export const TAPE_ROWS = 4;
/** "Fastest filling" shows only when at least this many presales are open (§5.2). */
export const FASTEST_MIN = 2;

/** A presale's raised and target in USD and its fill percentage. */
export function raiseOf(presale: FeedItemPresale): Readonly<{ raised: number | null; target: number | null; pct: number }> {
  const raised = quoteUsd(presale, presale.raised);
  const target = quoteUsd(presale, presale.raise_target);
  const pct = fillPercent(Number(presale.raised), Number(presale.raise_target));
  return { raised, target, pct };
}

/** "312 people" and "$48.2K" of the live line (one: "1 person", an OA-13 addition). */
export function liveLine(lastHour: SocialHappeningResponse["last_hour"]): Readonly<{ people: string; usd: string }> {
  return {
    people: `${lastHour.wallets.toLocaleString("en-US")} ${lastHour.wallets === 1 ? "person" : "people"}`,
    usd: short(Number(lastHour.usd)),
  };
}

export type TapeWho = Readonly<{
  /** The row's name: the display name (or callsign), or the short address. */
  name: string;
  /** The ticker's name: the first word of the display name, or the short address. */
  firstName: string;
  callsign: string | null;
  avatarUrl: string | null;
  /** The short address, for the wallet gradient. */
  short: string | null;
}>;

export function tapeWho(event: HappeningTapeEvent): TapeWho {
  const actor = event.actor;
  if (actor.type === "account") {
    const name = actor.display_name ?? actor.callsign;
    return { name, firstName: name.split(" ")[0] || name, callsign: actor.callsign, avatarUrl: actor.avatar_url, short: null };
  }
  return { name: actor.short, firstName: actor.short, callsign: null, avatarUrl: null, short: actor.short };
}

/**
 * What the row says after the name: "blasted **$757** into TIDE", "claimed
 * **1.24M** LUMN", a refund "claimed **$250** back from HLCN" (OA-13: the
 * design draws token claims only), "bought **$757** DEEP" / "sold …" while
 * trading is visible.
 */
export function tapeAction(event: HappeningTapeEvent): Readonly<{ verb: string; amount: string; rest: string }> {
  // The gate's tape reads every commit in dollars (`usd(e.usd)`). R3-40: a refund is in the sale's own coin
  // (whole units, exactly), so a SUI refund reads in SUI, never its SUI units as dollars.
  const coin = event.quote_symbol !== null && event.quote_symbol.toUpperCase() !== "USDC" ? event.quote_symbol : null;
  const inCoin = (units: string | null) => {
    const value = exactDecimal(units);
    return coin === null || value === null ? null : `${groupedExact(value, 2)} ${coin}`;
  };
  switch (event.kind) {
    case "presale_claim":
      if (event.tokens !== null) return { verb: "claimed", amount: qty(Number(event.tokens)), rest: event.symbol };
      return { verb: "claimed", amount: inCoin(event.refund ?? "0") ?? usd(Number(event.refund ?? 0)), rest: `back from ${event.symbol}` };
    case "trade_buy":
      return { verb: "bought", amount: usd(Number(event.usd ?? 0)), rest: event.symbol };
    case "trade_sell":
      return { verb: "sold", amount: usd(Number(event.usd ?? 0)), rest: event.symbol };
    default:
      return { verb: "blasted", amount: event.usd === null ? "some" : usd(Number(event.usd)), rest: `into ${event.symbol}` };
  }
}

/** The row's accessible name: "Theo Park, who you follow, blasted $757 TIDE" or "A wallet blasted $108 TIDE". */
export function tapeLabel(event: HappeningTapeEvent, relation: "Following" | "Follows you" | null): string {
  const who = tapeWho(event);
  const name = who.callsign === null ? "A wallet" : `${who.name}${relation === "Following" ? ", who you follow," : relation ? ", who follows you," : ""}`;
  const action = tapeAction(event);
  return `${name} ${action.verb} ${action.amount} ${event.symbol}`;
}

/** Events of `next` that `shown` does not have yet, oldest first: the order they slide in. */
export function arrivals(shown: readonly HappeningTapeEvent[], next: readonly HappeningTapeEvent[]): HappeningTapeEvent[] {
  const known = new Set(shown.map((event) => event.activity_id));
  const newest = shown[0]?.occurred_at_ms ?? Number.NEGATIVE_INFINITY;
  return next.filter((event) => !known.has(event.activity_id) && event.occurred_at_ms >= newest).reverse();
}

/** How long apart queued events slide in: spread over the poll, between 1.2 s and 4 s apart. */
export function dripGapMs(queued: number, pollMs: number): number {
  return Math.min(4_000, Math.max(1_200, Math.floor(pollMs / Math.max(1, queued + 1))));
}

/** "Fastest filling": the open presales, when at least two are; empty otherwise. */
export function fastestRows(read: Pick<SocialHappeningResponse, "fastest">): readonly HappeningPresale[] {
  return read.fastest.length >= FASTEST_MIN ? read.fastest : [];
}

/** "99% · 1m 16s left". */
export function fillLine(presale: FeedItemPresale, nowMs: number): string {
  return `${raiseOf(presale).pct}% · ${timeLeft(presale.end_ms - nowMs)} left`;
}

/** "Oct 14, 18:00 UTC · in 11d 0h". */
export function soonLine(presale: FeedItemPresale, nowMs: number): string {
  if (opensAt(presale.start_ms) === null) return NOT_OPEN_YET;
  return `${utc(presale.start_ms)} · in ${timeLeft(presale.start_ms - nowMs)}`;
}

/** "Luca, Mira, Ana backed this" (first names). */
export function backedTitle(names: readonly (string | null)[]): string {
  return `${names.map((name) => (name ?? "").split(" ")[0]).filter(Boolean).join(", ")} backed this`;
}

export type RecapStatus = "open" | "funded" | "trading" | "upcoming" | "closed" | "cancelled";

/** The status chip's word and tone (the `.status` tones: open/trading up, funded info, upcoming warn). */
export const RECAP_STATUS_LABEL: Readonly<Record<RecapStatus, string>> = { open: "Open", funded: "Funded", trading: "Trading", upcoming: "Upcoming", closed: "Closed", cancelled: "Cancelled" };

export type RecapSlide = Readonly<{
  id: string;
  presale: FeedItemPresale;
  status: RecapStatus;
  /** Line 1 after the chip, desktop: "closes in 1m 16s", "1.25× oversubscribed" ("1.00× subscribed" at target), "on Cetus", "opens Oct 14, 18:00 UTC". */
  when: string;
  /** Phones put the trading multiple before "on Cetus": "4.2× · on Cetus". */
  whenMultiple: Readonly<{ text: string; precise: string; tone: "up" | "down" }> | null;
  /** Line 2 parts, "·"-separated; `phone` replaces `desk` on phones. */
  sub: readonly Readonly<{ desk: string; phone?: string; venuePrefix?: string }>[];
  /** The metric column (hidden on phones): a bar and a figure, or a figure over a caption. */
  metric: Readonly<{ figure: string; caption: string | null; bar: number | null; tone: "up" | "down" | null }> | null;
  cta: "blast" | "view" | "notify";
  /** Whether line 2 ends with the viewer's followed backers ("3 you follow"). */
  pile: boolean;
}>;

function tradingRecap(row: HappeningPresale): RecapSlide {
  const presale = row.presale;
  const venue = venueName(presale.venue);
  const market = presale.market;
  const value = market?.multiple ? Number(market.multiple) : null;
  const tone = value === null ? null : value >= 1 ? "up" : "down";
  const priced = market?.presale_price_usd && market.price_usd;
  return {
    id: presale.presale_id, presale, status: "trading", when: `on ${venue}`,
    whenMultiple: value === null ? null : { text: value >= 1_000 ? `${shortQty(value)}×` : multiple(value), precise: `${market!.multiple}×`, tone: tone! },
    sub: priced
      ? [{ desk: `${px(Number(market.presale_price_usd))} → ${px(Number(market.price_usd))}` }, { desk: "since the presale" }]
      : [{ desk: row.launched_ms === null ? `Trading on ${venue}` : `Launched ${utc(row.launched_ms)}`, venuePrefix: row.launched_ms === null ? "Trading on" : undefined }],
    metric: value === null ? null : { figure: multiple(value), caption: "since presale", bar: null, tone }, cta: "view", pile: true,
  };
}

function recapSubscriptionRatio(presale: FeedItemPresale, raised: number | null, target: number | null, coin: boolean): number {
  if (coin) return Number(presale.raise_target) > 0 ? Number(presale.raised) / Number(presale.raise_target) : 1;
  return target ? (raised ?? 0) / target : 1;
}

/** One recap slide (§16) for `row` at `nowMs`. */
export function recapSlide(row: HappeningPresale, nowMs: number): RecapSlide {
  const presale = row.presale;
  const { raised, target, pct } = raiseOf(presale);
  // R3-40: a SUI sale's raise reads in SUI, from its atoms (`qs`, `qsRaised`); a USDC sale's as before.
  const quote = quoteOf(presale);
  const coin = readsInCoin(quote);
  const atoms = { raised: { usd: null, atoms: presale.raised }, target: { usd: null, atoms: presale.raise_target } };
  const money = (value: number | null) => (value === null ? "—" : short(value));
  const targetMoney = coin ? qs(quote, atoms.target) ?? "—" : money(target);
  // R3-06: a raise still filling rounds down ("$398K of $400K", never "$399K" for 398,600).
  const raisedMoney = coin
    ? qsRaised(quote, atoms.raised, atoms.target) ?? "—"
    : raised === null || target === null ? money(raised) : raisedShort(raised, target);
  const backers = `${presale.participants.toLocaleString("en-US")} backers`;
  const venue = venueName(presale.venue);
  // A sale scheduled to open later is upcoming until its start (#588).
  const lifecycle = saleLifecycleAt(presale.lifecycle, presale.start_ms, nowMs);
  if (lifecycle === "cancelled" || lifecycle === "closed" || (lifecycle === "open" && presale.end_ms <= nowMs)) {
    return {
      id: presale.presale_id, presale, status: lifecycle === "cancelled" ? "cancelled" : "closed", when: "", whenMultiple: null,
      sub: [{ desk: `${raisedMoney} of ${targetMoney}` }, { desk: backers }],
      metric: null, cta: "view", pile: false,
    };
  }
  if (lifecycle === "open") {
    return {
      id: presale.presale_id, presale, status: "open", when: `closes in ${timeLeft(presale.end_ms - nowMs)}`, whenMultiple: null,
      sub: [{ desk: `${raisedMoney} of ${targetMoney}`, phone: `${pct}% of ${targetMoney}` }, { desk: backers }],
      metric: { figure: `${pct}%`, caption: null, bar: Math.min(100, pct), tone: null }, cta: "blast", pile: true,
    };
  }
  if (lifecycle === "funded") {
    // The ratio from the atoms, so it needs no price (one sale, one unit).
    const ratio = recapSubscriptionRatio(presale, raised, target, coin);
    const times = times2(ratio);
    // OA-24: a sale that just met its target is "1.00× subscribed", as Blast mode says it; above it, "oversubscribed".
    const word = fundWord(ratio, 1);
    return {
      id: presale.presale_id, presale, status: "funded", when: `${times} ${word}`, whenMultiple: null,
      sub: [{ desk: `${raisedMoney} from ${backers}` }, { desk: `Trading opens on ${venue}`, venuePrefix: "Trading opens on" }],
      metric: { figure: times, caption: word, bar: null, tone: null }, cta: "view", pile: true,
    };
  }
  if (lifecycle === "migrated") return tradingRecap(row);
  return {
    id: presale.presale_id, presale, status: "upcoming",
    // OA-13: no opening time before the sale is shared on chain (start 0).
    when: opensAt(presale.start_ms) === null ? "not open yet" : `opens ${utc(presale.start_ms)}`, whenMultiple: null,
    sub: [{ desk: `Target ${targetMoney}` }, { desk: `${row.interested.toLocaleString("en-US")} interested` }],
    metric: opensAt(presale.start_ms) === null
      ? null
      : { figure: timeLeft(presale.start_ms - nowMs), caption: "to go", bar: null, tone: null },
    cta: "notify", pile: false,
  };
}
