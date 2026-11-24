import { bxUsd, fillPercent, px, qm, readsInCoin, timeLeft, usd0, utc, venueName } from "@blast/core/lib/format.ts";
import { PORTFOLIO_PRICE_MAX_AGE_MS } from "@blast/core/modules/social/contracts/portfolio.ts";
import { saleLifecycleAt } from "@blast/core/modules/social/contracts/presales.ts";
import { vestingDurationText } from "@blast/core/modules/social/contracts/vesting.ts";
import type { NotificationActor, NotificationKind, NotificationPresale, SocialNotification } from "@blast/core/modules/social/contracts/notifications.ts";

/**
 * A notification's words (canonical UI §13, copy verbatim where the design
 * shows it), built at read time from the stored row (`data`: the figures as
 * of the event) and the current sale and account. Pure: `nowMs` is the
 * reader's clock.
 */

const DAY = 86_400_000;
const HOUR = 3_600_000;
const MINUTE = 60_000;
/** A month for vesting figures: a year over twelve. */
const MONTH = (365.25 * DAY) / 12;

export type NotificationRow = Readonly<{
  id: string;
  kind: NotificationKind;
  presale_id: string;
  occurred_at_ms: string | number;
  data: Readonly<Record<string, unknown>>;
  read: boolean;
  /** The sale (`chain_read_v1.presales`), null when the view has no row for it. */
  sale_name: string | null;
  sale_symbol: string | null;
  sale_icon_url: string | null;
  sale_token?: string;
  quote_decimals: number | null;
  /** R3-40: the sale's quote (`USDC`, `SUI`): a SUI sale's amounts read in SUI. */
  quote_symbol?: string | null;
  lifecycle: string | null;
  start_ms: string | null;
  end_ms: string | null;
  raise_target: string | null;
  total_commitments: string | null;
  venue: string | null;
  /** The followed account (`follow` only). */
  callsign: string | null;
  display_name: string | null;
  avatar_url: string | null;
  x_handle: string | null;
  /** The account's active why on the entry (`follow` only). */
  why: string | null;
  /** The sale coin's latest USD price and when it was observed (`call_up` only). */
  price_usd?: string | null;
  price_as_of_ms?: string | null;
}>;

const grouped = (value: number) => Math.round(value).toLocaleString("en-US");

/** Quote atoms in dollars (USDC ≈ 1 USD), or null when either part is missing. */
function quoteUsd(atoms: unknown, decimals: number | null): number | null {
  if (typeof atoms !== "string" || !/^[0-9]{1,40}$/.test(atoms) || decimals === null) return null;
  return Number(atoms) / 10 ** decimals;
}

/** The row's quote as the formatters take it, or null without one. */
function quoteOfRow(row: NotificationRow) {
  return row.quote_symbol && row.quote_decimals !== null ? { symbol: row.quote_symbol, decimals: row.quote_decimals } : null;
}

/**
 * R3-40: the viewer's own quote atoms (`c`) — whole dollars for a USDC sale
 * (`$100`, as before), the coin for a SUI sale (`125 SUI`, the gate's `qm`,
 * exact: the row holds no dollar figure for it, and its SUI units are not
 * dollars) — or null when missing or zero.
 */
function saleAmount(row: NotificationRow, atoms: unknown): string | null {
  const quote = quoteOfRow(row);
  if (readsInCoin(quote)) {
    if (typeof atoms !== "string" || !/^[0-9]{1,40}$/.test(atoms) || /^0+$/.test(atoms)) return null;
    return qm(quote, { usd: null, atoms });
  }
  const dollars = quoteUsd(atoms, row.quote_decimals);
  return dollars !== null && dollars > 0 ? usd0(dollars) : null;
}

/** Time left in words, rounded down: `6 hours`, `2 days`, `14 minutes`. */
export function timeLeftWords(ms: number): string {
  if (ms >= 2 * DAY) return `${Math.floor(ms / DAY)} days`;
  if (ms >= 2 * HOUR) return `${Math.floor(ms / HOUR)} hours`;
  if (ms >= HOUR) return "1 hour";
  if (ms >= 2 * MINUTE) return `${Math.floor(ms / MINUTE)} minutes`;
  return "1 minute";
}

/** How far ahead an unlock is: `3 months`, `2 weeks`, `5 days`, `4 hours`. */
export function untilWords(ms: number): string {
  if (ms >= 60 * DAY) return `${Math.round(ms / MONTH)} months`;
  if (ms >= 14 * DAY) return `${Math.round(ms / (7 * DAY))} weeks`;
  if (ms >= 2 * DAY) return `${Math.round(ms / DAY)} days`;
  if (ms >= 2 * HOUR) return `${Math.round(ms / HOUR)} hours`;
  if (ms >= HOUR) return "1 hour";
  if (ms >= 2 * MINUTE) return `${Math.round(ms / MINUTE)} minutes`;
  return ms >= MINUTE ? "1 minute" : "less than a minute";
}

/** The venue's name, or null without one. */
function venueOf(venue: string | null): string | null {
  return venue ? venueName(venue) : null;
}

/** `1.25×`: up to two places, trailing zeros dropped. */
function multiple(value: number): string {
  return `${String(Number(value.toFixed(2)))}×`;
}

function first(name: string | null, callsign: string | null): string {
  const word = name?.trim().split(/\s+/)[0];
  return word || (callsign ? `@${callsign}` : "Someone you follow");
}

/** The sale's state now, for a line with nothing else to say. */
function saleStatus(row: NotificationRow, nowMs: number): string {
  const raised = Number(row.total_commitments ?? 0);
  const target = Number(row.raise_target ?? 0);
  const end = Number(row.end_ms ?? 0);
  switch (saleLifecycleAt(row.lifecycle ?? "", Number(row.start_ms ?? 0), nowMs)) {
    case "open":
      return end > nowMs ? `${fillPercent(raised, target)}% filled · ${timeLeft(end - nowMs)} left` : `${fillPercent(raised, target)}% filled`;
    case "pending":
      return row.start_ms ? `Opens ${utc(Number(row.start_ms))}` : "Opening soon";
    case "funded":
      return "Funded";
    case "migrated":
      return "Trading";
    case "cancelled":
      return "Cancelled";
    default:
      return "";
  }
}

type NotificationLines = Readonly<{ title: string; sub: string }>;

function fillLines(row: NotificationRow, name: string, youHave: string | null): NotificationLines {
  const data = row.data;
  const value = Number(data.v);
  const title = data.m === "filled" ? `${name} is ${value}% filled` : `${name} passed ${grouped(value)} backers`;
  const end = Number(row.end_ms ?? 0);
  const left = end > Number(row.occurred_at_ms) ? `${timeLeftWords(end - Number(row.occurred_at_ms))} remained when sent` : null;
  const filled = data.m !== "filled" && Number.isFinite(Number(data.pct)) ? `${Number(data.pct)}% filled` : null;
  return { title, sub: [youHave ?? filled, left].filter(Boolean).join(" · ") };
}

function followLines(row: NotificationRow, name: string, nowMs: number): NotificationLines {
  const usd = typeof row.data.usd === "string" && row.data.usd !== "" ? Number(row.data.usd) : null;
  const who = first(row.display_name, row.callsign);
  // Dollars at the commit's own time, shared with the tape and ticker's grammar (R3-05).
  const title = usd !== null && Number.isFinite(usd) ? `${who} blasted ${bxUsd(usd)} into ${name}` : `${who} blasted into ${name}`;
  return { title, sub: row.why ? `“${row.why}”` : saleStatus(row, nowMs) };
}

function fundedLines(row: NotificationRow, name: string): NotificationLines {
  const raised = Number(row.total_commitments ?? 0);
  const target = Number(row.raise_target ?? 0);
  const venue = venueOf(row.venue);
  const ratio = target > 0 ? raised / target : 0;
  const trading = venue ? `trading opens on ${venue}` : "trading opens soon";
  return {
    title: `${name} is funded`,
    sub: ratio >= 1.005 ? `${multiple(ratio)} oversubscribed · ${trading}` : trading.charAt(0).toUpperCase() + trading.slice(1),
  };
}

function soonLines(row: NotificationRow, name: string, youHave: string | null, nowMs: number): NotificationLines {
  if (row.data.at === "closes") {
    const status = row.lifecycle === "open" ? `${fillPercent(Number(row.total_commitments ?? 0), Number(row.raise_target ?? 0))}% filled` : saleStatus(row, nowMs);
    return { title: `Last hour for ${name}`, sub: [youHave, status].filter(Boolean).join(" · ") };
  }
  return {
    // A pending sale's start is 0 until it opens (blast-infra T-034).
    title: Number(row.start_ms) > 0 ? `${name} opens ${utc(Number(row.start_ms))}` : `${name} opens soon`,
    sub: "You asked to be notified",
  };
}

function unlockLines(row: NotificationRow, name: string, nowMs: number): NotificationLines {
  // s: first unlock; v: vesting start (older rows have no cliff); e: end.
  const unlock = Number(row.data.s);
  const start = row.data.v === undefined ? unlock : Number(row.data.v);
  const durationMs = Number(row.data.e) - start;
  return {
    title: unlock > nowMs ? `${name} team unlock in ${untilWords(unlock - nowMs)}` : `${name} team tokens are unlocking`,
    sub: Number.isFinite(durationMs) && durationMs > 0 ? `Linear over ${vestingDurationText(durationMs)} from launch` : "View the vesting schedule",
  };
}

function callUpLines(row: NotificationRow, name: string, nowMs: number): NotificationLines {
  // t: the threshold crossed (percent over the entry); e: the entry price; p: the price that crossed it.
  const entry = Number(row.data.e);
  const live = row.price_usd != null && row.price_as_of_ms != null && nowMs - Number(row.price_as_of_ms) <= PORTFOLIO_PRICE_MAX_AGE_MS
    ? Number(row.price_usd)
    : null;
  const called = Number.isFinite(entry) && entry > 0 ? `Called at ${px(entry)}` : null;
  const now = live !== null && Number.isFinite(live) && live > 0 ? `now ${px(live)}` : null;
  return {
    title: `${row.sale_symbol || name} is up ${grouped(Number(row.data.t))}% since your call`,
    sub: [called, now].filter(Boolean).join(" · "),
  };
}

function lines(row: NotificationRow, nowMs: number): NotificationLines {
  const name = row.sale_name ?? "A presale";
  const mine = saleAmount(row, row.data.c);
  const youHave = mine !== null ? `You have ${mine} in` : null;
  switch (row.kind) {
    case "fill": return fillLines(row, name, youHave);
    case "follow": return followLines(row, name, nowMs);
    case "claim":
      if (row.data.refund === true) {
        return { title: `Refunds are open for ${name}`, sub: mine !== null ? `Your ${mine} refund is ready` : "Your refund is ready" };
      }
      return { title: `Claims are open for ${name}`, sub: `Your ${row.sale_symbol ?? "tokens"} are ready` };
    case "funded": return fundedLines(row, name);
    case "soon": return soonLines(row, name, youHave, nowMs);
    case "unlock": return unlockLines(row, name, nowMs);
    case "call_up": return callUpLines(row, name, nowMs);
  }
}

/** The published notification for a stored row. */
export function renderNotification(row: NotificationRow, nowMs: number): SocialNotification {
  const presale: NotificationPresale | null =
    row.sale_name === null
      ? null
      : { presale_id: row.presale_id, coin_type: row.sale_token, name: row.sale_name, symbol: row.sale_symbol ?? "", icon_url: row.sale_icon_url ?? "" };
  const actor: NotificationActor | null =
    row.kind === "follow" && row.callsign
      ? { callsign: row.callsign, display_name: row.display_name, avatar_url: row.avatar_url, verified: row.x_handle !== null }
      : null;
  const { title, sub } = lines(row, nowMs);
  return {
    id: row.id,
    kind: row.kind,
    title,
    sub,
    occurred_at_ms: Number(row.occurred_at_ms),
    read: row.read,
    href: `/presale/${row.presale_id}`,
    presale,
    actor,
  };
}
