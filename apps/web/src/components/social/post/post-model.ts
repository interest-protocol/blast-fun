import { atomsValue, qm, qs, quoteOf, quoteUsd, readsInCoin } from "@blast/core/web/format.ts";
import { postIdOf } from "@blast/core/web/contracts/item-routes.ts";
import type { FeedItem, FeedItemBacker, FeedItemPresale } from "@blast/core/web/contracts/items.ts";
import { WHY_WINDOW_MS } from "@blast/core/modules/social/whys/validate.ts";

import { whyNowLine, type CoinMoves } from "./coin-moves-model";
import {
  decimal,
  durationWords,
  explorerTxUrl,
  multiple,
  pct1,
  px,
  qty,
  short,
  usd0,
  venueName,
  walletHue,
} from "./post-format";

/**
 * A feed item as the canonical post card shows it (FEATURE-MAP §3): which
 * lead, header, body and call to action, with every string already in the
 * design's words and formats. Pure, so each variant is tested without a DOM.
 * User text (display names, the why) stays as given: the card renders it as
 * text, never as markup or a link.
 */

export type PostLead =
  | Readonly<{ kind: "account"; callsign: string; name: string; avatarUrl: string | null; path: string }>
  | Readonly<{ kind: "presale"; presale: FeedItemPresale }>
  | Readonly<{ kind: "wallet"; short: string; hue: number }>;

export type PostHeader =
  | Readonly<{ kind: "account"; name: string; callsign: string; verified: boolean; path: string; own: boolean }>
  | Readonly<{ kind: "presale"; presale: FeedItemPresale }>
  | Readonly<{ kind: "wallet"; short: string; address: string }>;

/** The action chip of an action line (`.act`). */
export type PostChip = "blast" | "claim" | "call" | "buy" | "sell";

/** A buy's move since: the coin's price now against the trade's (`· now +10.5%`). */
export type PostNow = Readonly<{ text: string; up: boolean }>;

export type PostBody =
  | Readonly<{
      kind: "action";
      chip: PostChip;
      amount: string | null;
      presale: FeedItemPresale | null;
      tail: string | null;
      /** Trades only (R3-83): a buy's move since the trade, null when under 0.1 % or unknown. */
      now?: PostNow | null;
      /** Trades only (R3-83): `Big buy` on a large unnamed buy. */
      tag?: "big-buy" | null;
    }>
  | Readonly<{ kind: "news"; headline: string; sub: string | null; closesAtMs?: number }>;

/** A call's result card (`.callc`, §3.4). Its sparkline is the coin since launch (R3-20), read by the card itself. */
export type PostCall = Readonly<{
  presale: FeedItemPresale;
  /** The current formatted price, or null when it is not fresh. */
  price: string | null;
  /** "4.2×", or null without a result. */
  result: string | null;
  up: boolean;
}>;

export type PostCta =
  | Readonly<{ kind: "commit"; label: "Blast" }>
  | Readonly<{ kind: "view"; label: "View presale"; presaleId: string }>
  /** R3-83: a buy's "Buy too" opens the swap, USDC for the coin. */
  | Readonly<{ kind: "buy"; label: "Buy too"; presale: FeedItemPresale }>
  /** R3-83: a sell's "View coin" opens the coin (its sale until the market sheet, R3-81, exists). */
  | Readonly<{ kind: "coin"; label: "View coin"; presaleId: string }>;

export type PostView = Readonly<{
  entryId: string;
  /** `/p/<post id>`. */
  postId: string;
  lead: PostLead;
  /** "Big blast" on an anonymous big commit. */
  context: "big-blast" | null;
  /** R3-83: the line above a buy saying why its coin is worth a look now (`Top gainer today · +32.6%`), or null. */
  whyNow: string | null;
  header: PostHeader;
  /** The meta word before the time: "Presale" on a presale's own post. */
  occurredAtMs: number;
  /** The transaction on the explorer; null when the item has no digest. */
  txUrl: string | null;
  body: PostBody;
  why: string | null;
  /** The why's id, for the controls that act on it (delete, report); null without one. */
  whyId: string | null;
  call: PostCall | null;
  /** The presale's named backers (lifecycle and milestone posts), and its participant count. */
  backers: Readonly<{ presaleId: string; list: readonly FeedItemBacker[]; participants: number }> | null;
  rockets: number;
  /** "6 blasted too · $3.1K"; null when nobody acted through the post. */
  through: Readonly<{ people: number; volume: string }> | null;
  /** What the through line says the people did: `blasted too`, or `bought too` on a trade (R3-83). */
  throughWord: "blasted too" | "bought too";
  cta: PostCta | null;
  /** The author a signed-in viewer may follow from the post (a named author, not the viewer). */
  followCallsign: string | null;
}>;

const ACTION_KINDS = new Set(["presale_commit", "presale_claim", "trade_buy", "trade_sell"]);

/**
 * A Quote amount: a SUI sale's in SUI (R3-40, the gate's `qm`: `25 SUI`);
 * any other sale's in dollars (`$400,000`; an unpriced USDC quote at $1),
 * else in Quote units: `400,000 WAL`.
 */
function quoteAmount(atoms: string, presale: FeedItemPresale): string | null {
  if (readsInCoin(quoteOf(presale))) return qm(quoteOf(presale), { usd: null, atoms });
  const dollars = quoteUsd(presale, atoms);
  if (dollars !== null) return usd0(dollars);
  const amount = atomsValue(atoms, presale.quote_decimals);
  return amount === null ? null : `${Math.round(amount).toLocaleString("en-US")} ${presale.quote_symbol}`;
}

/**
 * The item's amount: a commit to a SUI sale in SUI (R3-40, the gate's
 * `qm(s, p.q)`) unless `inCoin` is off, else its dollars, whole (`amounts.usd`,
 * two places, or an unpriced USDC quote at $1), else its Quote amount with the symbol.
 */
function itemAmount(item: FeedItem, inCoin = true): string | null {
  const coin = item.amounts?.quote_symbol && item.amounts.quote_decimals !== null
    ? { symbol: item.amounts.quote_symbol, decimals: item.amounts.quote_decimals }
    : null;
  if (inCoin && readsInCoin(coin) && item.kind.startsWith("presale_")) return qm(coin, { usd: null, atoms: item.amounts!.quote });
  const dollars = decimal(item.amounts?.usd);
  if (dollars !== null) return usd0(dollars);
  const amounts = item.amounts;
  if (!amounts) return null;
  const quote = { quote_symbol: amounts.quote_symbol ?? "", quote_decimals: amounts.quote_decimals, quote_usd: null };
  const fallback = quoteUsd(quote, amounts.quote);
  if (fallback !== null) return usd0(fallback);
  const amount = atomsValue(amounts.quote, amounts.quote_decimals);
  return amount !== null && amounts.quote_symbol ? `${Math.round(amount).toLocaleString("en-US")} ${amounts.quote_symbol}` : null;
}

function tokens(item: FeedItem): number | null {
  return atomsValue(item.amounts?.tokens, item.presale?.decimals);
}

function isZero(atoms: string | null | undefined): boolean {
  return atoms === null || atoms === undefined || /^0+$/.test(atoms);
}

function claimBody(item: FeedItem): PostBody {
  const presale = item.presale;
  const market = presale?.market ?? null;
  const claimed = tokens(item);
  const price = decimal(market?.price_usd);
  if (claimed !== null && claimed > 0) {
    return { kind: "action", chip: "claim", amount: qty(claimed), presale, tail: price === null ? null : `worth ${short(claimed * price)} now` };
  }
  // A refund-only claim (a cancelled sale): the refund in dollars, or in SUI for a SUI sale (R3-40).
  const refund = isZero(item.amounts?.quote_refund) || !presale ? null : quoteAmount(item.amounts!.quote_refund!, presale);
  const coin = presale !== null && readsInCoin(quoteOf(presale));
  return { kind: "action", chip: "claim", amount: coin ? refund : itemAmount(item) ?? refund, presale, tail: "refund" };
}

function tradeBody(item: FeedItem): PostBody {
  const presale = item.presale;
  const market = presale?.market ?? null;
  const traded = tokens(item);
  const dollars = decimal(item.amounts?.usd);
  const price = traded && dollars !== null ? dollars / traded : null;
  const buy = item.kind === "trade_buy";
  return {
    kind: "action",
    chip: buy ? "buy" : "sell",
    amount: itemAmount(item),
    presale,
    tail: price === null ? null : `at ${px(price)}`,
    now: buy ? moveSince(price, decimal(market?.price_usd)) : null,
    tag: buy && item.big && item.actor?.type === "address" ? "big-buy" : null,
  };
}

function actionBody(item: FeedItem): PostBody {
  const presale = item.presale;
  const market = presale?.market ?? null;
  switch (item.kind) {
    case "presale_commit": {
      if (item.call) {
        const entry = decimal(market?.presale_price_usd);
        return { kind: "action", chip: "call", amount: null, presale, tail: entry === null ? null : `backed at ${px(entry)}` };
      }
      // The gate's `bigcommit` (an anonymous wallet's big commit) reads in dollars for every sale: `usd(p.usd)`.
      const bigBlast = item.big && item.actor?.type === "address";
      return { kind: "action", chip: "blast", amount: itemAmount(item, !bigBlast), presale, tail: null };
    }
    case "presale_claim":
      return claimBody(item);
    default:
      return tradeBody(item);
  }
}

/**
 * oa41's `· now +10.5%` after a buy's price: the coin's price now (the item's
 * `presale.market.price_usd`, fresh or null) against the trade's, shown from
 * 0.1 % either way; null below that or without both prices. A sell has none.
 */
function moveSince(at: number | null, now: number | null): PostNow | null {
  if (at === null || now === null || at <= 0) return null;
  const pct = (now / at - 1) * 100;
  return Math.abs(pct) >= 0.1 ? { text: pct1(pct), up: pct >= 0 } : null;
}

const TRADE_KINDS = new Set(["trade_buy", "trade_sell"]);

function openedNews(presale: FeedItemPresale): PostBody {
  const headline = `${presale.name} is open`;
  const closesAtMs = presale.end_ms;
  if (readsInCoin(quoteOf(presale))) {
    const target = qs(quoteOf(presale), { usd: null, atoms: presale.raise_target });
    return { kind: "news", headline, sub: target === null ? null : `Raising ${target}.`, closesAtMs };
  }
  const goal = quoteUsd(presale, presale.raise_target);
  return {
    kind: "news",
    headline,
    sub: goal === null ? null : `Raising ${short(goal)} in ${presale.quote_symbol}.`,
    closesAtMs,
  };
}

function fundedNews(presale: FeedItemPresale): PostBody {
  const name = presale.name;
  const venue = venueName(presale.venue);
  const raised = Number(presale.raised);
  const target = Number(presale.raise_target);
  const over = target > 0 ? raised / target : 0;
  if (over >= 1.005) {
    return { kind: "news", headline: `${name} is funded`, sub: `${over.toFixed(2)}× oversubscribed. Claims open when the pool launches.` };
  }
  const total = quoteAmount(presale.raised, presale);
  return {
    kind: "news",
    headline: `${name} is funded`,
    sub: total
      ? `${total} from ${presale.participants.toLocaleString("en-US")} people. Trading opens on ${venue} when the pool launches.`
      : `Trading opens on ${venue} when the pool launches.`,
  };
}

/** A presale's own post: its headline and line in the design's words (FEATURE-MAP §3.8). */
function newsBody(item: FeedItem, presale: FeedItemPresale): PostBody | null {
  const name = presale.name;
  const venue = venueName(presale.venue);
  const raised = Number(presale.raised);
  const target = Number(presale.raise_target);
  const value = decimal(item.milestone_value);
  switch (item.kind) {
    case "presale_opened":
      return openedNews(presale);
    case "presale_funded":
      return fundedNews(presale);
    case "presale_migrated": {
      const result = marketMultiple(presale.market);
      return {
        kind: "news",
        headline: `${name} is trading on ${venue}`,
        sub: result === null
          ? "Backers can claim their tokens."
          : `It now trades at ${multiple(result)} the presale price. Backers can claim their tokens.`,
      };
    }
    case "presale_cancelled":
      return {
        kind: "news",
        headline: `${name} was cancelled`,
        // A sale that met its target but never launched is cancelled at its liquidity deadline.
        sub: target > 0 && raised >= target
          ? "It did not launch in time. Everyone can claim a full refund."
          : "The target was missed. Everyone can claim a full refund.",
      };
    case "milestone_participants": {
      if (value === null) return null;
      const people = value.toLocaleString("en-US");
      const left = presale.end_ms - item.occurred_at_ms;
      return {
        kind: "news",
        headline: `${people} people are in`,
        sub: left > 0 ? `${name} passed ${people} backers with ${durationWords(left)} left.` : `${name} passed ${people} backers.`,
      };
    }
    case "milestone_raise": {
      const amount = quoteAmount(presale.raise_target, presale);
      return {
        kind: "news",
        headline: "Raise target reached",
        sub: `${name} passed ${amount ?? "its target"}. Extra commitments come back pro rata at claim.`,
      };
    }
    case "milestone_holders": {
      if (value === null) return null;
      const holders = value.toLocaleString("en-US");
      return { kind: "news", headline: `${holders} holders`, sub: `${name} passed ${holders} holders.` };
    }
    default:
      return null;
  }
}

/**
 * Price now over the presale price, divided here as the prototype divides
 * (`now / price`, then one place): 0.0013 over 0.002 reads 0.6×, as drawn.
 * Without both prices, the payload's own `multiple`.
 */
function marketMultiple(market: FeedItemPresale["market"] | undefined): number | null {
  const now = decimal(market?.price_usd);
  const entry = decimal(market?.presale_price_usd);
  if (now !== null && entry !== null && entry > 0) return now / entry;
  return decimal(market?.multiple);
}

function callCard(item: FeedItem): PostCall | null {
  const presale = item.presale;
  if (!item.call || !presale) return null;
  const market = presale.market;
  const price = decimal(market?.price_usd);
  const result = marketMultiple(market);
  return {
    presale,
    price: price === null ? null : px(price),
    result: result === null ? null : multiple(result),
    up: result === null || result >= 1,
  };
}

function postIdentity(actor: FeedItem["actor"], presale: FeedItem["presale"], viewerCallsign: string | null): Readonly<{ lead: PostLead; header: PostHeader }> {
  let lead: PostLead;
  let header: PostHeader;
  if (actor?.type === "account") {
    const name = actor.display_name ?? actor.callsign;
    lead = { kind: "account", callsign: actor.callsign, name, avatarUrl: actor.avatar_url, path: actor.path };
    header = { kind: "account", name, callsign: actor.callsign, verified: actor.verified, path: actor.path, own: actor.callsign === viewerCallsign };
  } else if (actor?.type === "address") {
    lead = { kind: "wallet", short: actor.short, hue: walletHue(actor.short) };
    header = { kind: "wallet", short: actor.short, address: actor.address };
  } else {
    lead = { kind: "presale", presale: presale! };
    header = { kind: "presale", presale: presale! };
  }

  return { lead, header };
}

function postCta(item: FeedItem, own: boolean): PostCta | null {
  const presale = item.presale;
  const trade = TRADE_KINDS.has(item.kind);
  const descriptor = item.do_the_same;
  let cta: PostCta | null = null;
  if (!own && trade && presale && presale.lifecycle === "migrated") {
    // oa41's `ctaFor`: a sell shows its coin, a buy the same buy (the item's own descriptor still says the sale, T-005).
    cta = item.kind === "trade_sell" ? { kind: "coin", label: "View coin", presaleId: presale.presale_id } : { kind: "buy", label: "Buy too", presale };
  } else if (!own && descriptor && presale) {
    cta = descriptor.enabled && descriptor.kind === "commit"
      ? { kind: "commit", label: "Blast" }
      : { kind: "view", label: "View presale", presaleId: presale.presale_id };
  }
  return cta;
}

function postBody(item: FeedItem): PostBody | null {
  const actor = item.actor;
  const presale = item.presale;
  if (ACTION_KINDS.has(item.kind)) {
    if (!actor) return null;
    return actionBody(item);
  }
  if (!presale) return null;
  return newsBody(item, presale);
}

/**
 * The post of `item` for the viewer with `viewerCallsign` (null for a
 * visitor), or null for an item the card does not show (a kind it does not
 * know, or a presale post whose presale is not indexed yet).
 */
export function postView(item: FeedItem, viewerCallsign: string | null, moves: CoinMoves | null = null): PostView | null {
  const actor = item.actor;
  const presale = item.presale;
  const body = postBody(item);
  if (!body) return null;

  const { lead, header } = postIdentity(actor, presale, viewerCallsign);
  const own = header.kind === "account" && header.own;
  const trade = TRADE_KINDS.has(item.kind);
  const cta = postCta(item, own);
  const volume = decimal(item.through.volume_usd) ?? 0;
  const backers = item.backers && presale ? { presaleId: presale.presale_id, list: item.backers, participants: presale.participants } : null;

  return {
    entryId: item.entry_id,
    postId: postIdOf(item.entry_id),
    lead,
    context: actor?.type === "address" && item.big && item.kind === "presale_commit" ? "big-blast" : null,
    whyNow: item.kind === "trade_buy" && presale ? whyNowLine(presale.presale_id, moves) : null,
    header,
    occurredAtMs: item.occurred_at_ms,
    txUrl: explorerTxUrl(item.digest),
    body,
    why: item.why?.text ?? null,
    whyId: item.why?.why_id ?? null,
    call: callCard(item),
    backers: backers && backers.list.length > 0 ? backers : null,
    rockets: item.reactions.rocket ?? 0,
    // A trade's through line counts the buys made through it (a trade intent's attributions), never commits.
    through: item.through.people > 0 ? { people: item.through.people, volume: short(volume) } : null,
    throughWord: trade ? "bought too" : "blasted too",
    cta,
    followCallsign: actor?.type === "account" && !own ? actor.callsign : null,
  };
}

/**
 * The faces of a facepile (§3.5): the backers the viewer follows first, then
 * the rest, at most six, never twice; and the line under them. `followed` is
 * the viewer state's followed backers of the presale (count and the largest
 * few), null for a visitor or while unknown.
 */
export function facepile(
  backers: Readonly<{ list: readonly FeedItemBacker[]; participants: number }>,
  followed: Readonly<{ count: number; accounts: readonly FeedItemBacker[] }> | null,
): Readonly<{ faces: readonly FeedItemBacker[]; followed: number; others: number }> {
  const first = followed?.accounts ?? [];
  const seen = new Set(first.map((backer) => backer.callsign));
  const faces = [...first, ...backers.list.filter((backer) => !seen.has(backer.callsign))].slice(0, 6);
  const followedCount = followed?.count ?? 0;
  return { faces, followed: followedCount, others: Math.max(0, backers.participants - followedCount) };
}

/** The person kinds whose author may explain them (the why route's named items). */
const WHY_KINDS = new Set(["presale_commit", "presale_claim", "trade_buy", "trade_sell"]);

/**
 * Whether the viewer may add a why to `item` now (T-021): their own named
 * item, inside the 24 hours after it, with no why yet. The server decides
 * the rest (a removed why, three records); its refusal shows in the box.
 */
export function canAddWhy(item: FeedItem, viewerCallsign: string | null, nowMs: number): boolean {
  return (
    viewerCallsign !== null &&
    item.actor?.type === "account" &&
    item.actor.callsign === viewerCallsign &&
    WHY_KINDS.has(item.kind) &&
    item.why === null &&
    nowMs <= item.occurred_at_ms + WHY_WINDOW_MS
  );
}

/** The why box's label: the commit dialog's question for buying in, plain words otherwise. */
export function whyPrompt(kind: string): string {
  return kind === "presale_commit" || kind === "trade_buy" ? "Why are you in?" : "Your why";
}

/**
 * OA-24: on phones the footer's "6 blasted too" is hidden and the post's
 * social proof is its own line under it instead — "6 blasted too through this
 * post · $3.1K", or "through you" on the viewer's own post. Null when nobody
 * acted through the post.
 */
export function phoneThroughLine(post: PostView): string | null {
  if (!post.through) return null;
  return `${post.through.people.toLocaleString("en-US")} ${post.throughWord} through ${ownPost(post) ? "you" : "this post"} · ${post.through.volume}`;
}

/** Whether the post is the viewer's own (its named actor is the viewer). */
function ownPost(post: PostView): boolean {
  return post.header.kind === "account" && post.header.own;
}

/** One item of the More menu (§3.7); `PostMenu` renders each in the design's row. */
export type PostMenuItemKind = "copy-link" | "transaction" | "report-why" | "delete-why";

/**
 * The More menu's items (§3.7), in the design's order: "Copy link to post",
 * then "View transaction on <explorer>" when the post has a transaction, then
 * the one destructive item a post with a why offers — "Report post" on
 * someone else's post (the design's own condition, `why && !own`) or "Delete
 * this why" on one's own (T-022, an OA-13 addition: the design draws no
 * control for the author's retraction, and the menu is where a post's other
 * actions live). A visitor sees the report item and its tap goes through the
 * sign-in gate (§0.3); nobody is a visitor to their own post, so the two
 * never appear together.
 */
export function postMenuItems(post: PostView): readonly PostMenuItemKind[] {
  const items: PostMenuItemKind[] = ["copy-link"];
  if (post.txUrl) items.push("transaction");
  if (post.whyId) items.push(ownPost(post) ? "delete-why" : "report-why");
  return items;
}

/**
 * The count a rocket shows: the item's public count, less the viewer's
 * rocket it already includes (as first read), plus the viewer's rocket now.
 */
export function rocketCount(publicCount: number, mineAtRead: boolean, mineNow: boolean): number {
  return Math.max(0, publicCount - (mineAtRead ? 1 : 0) + (mineNow ? 1 : 0));
}

/** "Rocket, 41" (or "Rocket" at zero): the button's accessible name. */
export function rocketLabel(count: number): string {
  return count > 0 ? `Rocket, ${count.toLocaleString("en-US")}` : "Rocket";
}
