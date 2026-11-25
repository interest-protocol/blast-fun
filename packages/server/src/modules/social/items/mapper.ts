import { DISPLAY_PRICES } from "@blast/core/modules/social/prices/test-sui.ts";
import { shortAddress } from "@blast/core/lib/format.ts";
import type { ReadableDatabase } from "@blast/core/modules/database/transaction.ts";
import type { SocialConfig } from "@blast/core/modules/social/contracts/config.ts";
import { ITEM_BACKERS_MAX, ITEM_PRICE_MAX_AGE_MS } from "@blast/core/modules/social/contracts/items.ts";
import type {
  FeedItem,
  FeedItemActor,
  FeedItemBacker,
  FeedItemMarket,
  FeedItemPresale,
  FeedItemThrough,
  FeedItemWhy,
} from "@blast/core/modules/social/contracts/items.ts";
import { profilePagePath } from "@blast/core/modules/social/contracts/profiles.ts";
import type { FeedEntry } from "@blast/core/modules/social/read-model/entries.ts";
import { namedWalletsOfSql, TRADE_ENTRY_KINDS } from "@blast/core/modules/social/read-model/naming.ts";
import { compareDecimal, toUsd } from "@blast/core/modules/social/items/decimal.ts";
import { doTheSameDescriptor } from "@blast/core/modules/social/items/do-the-same.ts";
import { SHOWN_PRESALES } from "@blast/core/modules/social/read-model/chain-presales.ts";
import { settledAll } from "@blast/server/lib/settled-all.ts";

/**
 * The item mapper: a page of read-model entries (`personEntriesOf`,
 * `presalePostEntriesOf`) becomes public item payloads in one step, with a
 * fixed number of reads (presales with their prices, identities, whys,
 * reactions, through counts, and the named backers of the page's presale
 * posts) whatever the page size. The naming decision is the entry's
 * `namedAccountId`, taken as given; this module never re-derives it (the
 * backers read applies the same rule as a set, `namedWalletsOfSql`).
 */

/** What a mapping depends on besides the entries: the clock and the tuning values of this read. */
export type ItemContext = Readonly<{ nowMs: number; config: SocialConfig }>;

type PresaleRow = {
  presale_id: string; coin_type?: string;
  symbol: string;
  name: string;
  icon_url: string;
  lifecycle: string;
  decimals: number;
  venue: string;
  start_ms: string;
  end_ms: string;
  raise_target: string;
  raised: string;
  participants: string;
  quote_type: string;
  quote_symbol: string;
  quote_decimals: number;
  /** What buyers paid (claims: kept quote ÷ tokens) in whole Quote per whole sale token; null before a claim. */
  presale_price_quote: string | null;
  quote_usd: string | null;
  quote_usd_as_of_ms: string | null;
  sale_usd: string | null;
  sale_usd_as_of_ms: string | null;
  /** R3-23: Blast checked who is behind the sale; false without a `social_sale_trust` row. */
  verified_team?: boolean;
};

type IdentityRow = {
  account_id: string;
  callsign: string | null;
  display_name: string | null;
  avatar_url: string | null;
  x_handle: string | null;
  verified: boolean;
};

/** Everything the page's entries refer to, read once per page. */
export type ItemLookups = Readonly<{
  presales: ReadonlyMap<string, PresaleRow>;
  identities: ReadonlyMap<string, IdentityRow>;
  whys: ReadonlyMap<string, FeedItemWhy>;
  reactions: ReadonlyMap<string, ReadonlyMap<string, number>>;
  through: ReadonlyMap<string, FeedItemThrough>;
  /** Named backers per presale, the largest first (only presales with a lifecycle or milestone entry on the page). */
  backers: ReadonlyMap<string, readonly FeedItemBacker[]>;
}>;

const TRADE_KINDS: ReadonlySet<string> = new Set<string>(TRADE_ENTRY_KINDS);
const NO_THROUGH: FeedItemThrough = Object.freeze({ people: 0, volume_usd: "0.00" });

/** `0x` + the first 4 + `…` + the last 4 hex characters of an address (the shell's `shortAddress`). */
export { shortAddress };

/** A lifecycle or milestone entry: a post the presale makes, which shows its named backers. */
function isPresaleNewsEntry(entry: FeedEntry): boolean {
  return entry.presaleId !== null && (entry.source === "lifecycle" || entry.source === "milestone");
}

/**
 * Whether the entry is big now: a commit at or above `big_commit_usd`, or a
 * trade at or above `big_trade_usd`, of a presale. A null USD is never big.
 */
export function isBigEntry(entry: FeedEntry, config: SocialConfig): boolean {
  if (entry.source !== "activity" || entry.presaleId === null || entry.usdValue === null) return false;
  if (entry.kind === "presale_commit") return compareDecimal(entry.usdValue, config.big_commit_usd) >= 0;
  if (TRADE_KINDS.has(entry.kind)) return compareDecimal(entry.usdValue, config.big_trade_usd) >= 0;
  return false;
}

/** A presale post: every lifecycle and milestone entry and every big entry, of a presale. */
export function isPresalePostEntry(entry: FeedEntry, config: SocialConfig): boolean {
  if (entry.presaleId === null) return false;
  return entry.source === "lifecycle" || entry.source === "milestone" || isBigEntry(entry, config);
}

/**
 * The item's actor, or `undefined` when the entry must not be shown at all.
 * A named entry shows its account; an unnamed presale post shows its wallet
 * address only; lifecycle and milestone posts have none. An unnamed entry
 * that is not a presale post is never shown: the selections never return
 * one, and the mapper drops it rather than expose an unnamed wallet.
 */
function actorOf(entry: FeedEntry, presalePost: boolean, lookups: ItemLookups): FeedItemActor | null | undefined {
  const identity = entry.namedAccountId === null ? undefined : lookups.identities.get(entry.namedAccountId);
  if (identity?.callsign) {
    return {
      type: "account",
      callsign: identity.callsign,
      display_name: identity.display_name,
      avatar_url: identity.avatar_url,
      x_handle: identity.x_handle,
      verified: identity.verified === true,
      path: profilePagePath(identity.callsign),
    };
  }
  if (entry.actor === null) return entry.source === "activity" ? undefined : null;
  // A named account without a callsign yet has no profile to show: its wallet stands in.
  if (entry.namedAccountId !== null || presalePost) {
    return { type: "address", address: entry.actor, short: shortAddress(entry.actor) };
  }
  return undefined;
}

/** A price observed at `asOfMs`, if it is fresh at `nowMs` (spec AC-112); else null. */
function freshPrice(price: string | null, asOfMs: string | null, nowMs: number): number | null {
  if (price === null || asOfMs === null) return null;
  const age = nowMs - Number(asOfMs);
  const value = Number(price);
  return age <= ITEM_PRICE_MAX_AGE_MS && Number.isFinite(value) && value > 0 ? value : null;
}

/** A positive number as a plain decimal string with at most `places` fraction digits, trailing zeros trimmed. */
function decimalText(value: number, places: number): string {
  const fixed = value.toFixed(places);
  return fixed.includes(".") ? fixed.replace(/\.?0+$/, "") : fixed;
}

/**
 * A migrated presale's market (OA-9): the presale price in USD, the coin's
 * fresh price and their ratio. Display values: computed in float64, which
 * keeps far more precision than the 12 fraction digits and the four-place
 * multiple shown.
 */
function marketOf(row: PresaleRow, nowMs: number): FeedItemMarket | null {
  if (row.lifecycle !== "migrated") return null;
  const quoteUsd = freshPrice(row.quote_usd, row.quote_usd_as_of_ms, nowMs);
  const saleUsd = freshPrice(row.sale_usd, row.sale_usd_as_of_ms, nowMs);
  const presaleQuote = row.presale_price_quote === null ? null : Number(row.presale_price_quote);
  const presaleUsd = quoteUsd !== null && presaleQuote !== null && presaleQuote > 0 ? presaleQuote * quoteUsd : null;
  return {
    presale_price_usd: presaleUsd === null ? null : decimalText(presaleUsd, 12),
    price_usd: saleUsd === null ? null : decimalText(saleUsd, 12),
    price_as_of_ms: saleUsd === null ? null : Number(row.sale_usd_as_of_ms),
    multiple: presaleUsd === null || saleUsd === null ? null : (saleUsd / presaleUsd).toFixed(4),
  };
}

function presaleChip(row: PresaleRow | undefined, nowMs: number): FeedItemPresale | null {
  if (!row) return null;
  const quoteUsd = freshPrice(row.quote_usd, row.quote_usd_as_of_ms, nowMs);
  return {
    presale_id: row.presale_id,
    coin_type: row.coin_type,
    symbol: row.symbol,
    name: row.name,
    icon_url: row.icon_url,
    lifecycle: row.lifecycle,
    decimals: row.decimals,
    venue: row.venue,
    start_ms: Number(row.start_ms),
    end_ms: Number(row.end_ms),
    raise_target: row.raise_target,
    raised: row.raised,
    participants: Number(row.participants),
    quote_symbol: row.quote_symbol,
    quote_decimals: row.quote_decimals,
    quote_usd: quoteUsd === null ? null : decimalText(quoteUsd, 12),
    market: marketOf(row, nowMs),
    ...(row.verified_team === true ? { verified_team: true } : {}),
  };
}

function itemAmounts(entry: FeedEntry, presale: PresaleRow | undefined): FeedItem["amounts"] {
  const inPresaleQuote = presale !== undefined && entry.quoteType === presale.quote_type;
  return entry.source === "activity" && entry.quoteAmount !== null
    ? {
      quote: entry.quoteAmount,
      quote_symbol: inPresaleQuote ? presale.quote_symbol : null,
      quote_decimals: inPresaleQuote ? presale.quote_decimals : null,
      usd: entry.usdValue === null ? null : toUsd(entry.usdValue),
      tokens: entry.coinAmount,
      quote_refund: entry.quoteRefund,
    }
    : null;
}

/** One entry's item from the page's lookups, or null when the entry must not be shown. Pure. */
export function buildItem(entry: FeedEntry, lookups: ItemLookups, context: ItemContext): FeedItem | null {
  const { config, nowMs } = context;
  const big = isBigEntry(entry, config);
  const presalePost = isPresalePostEntry(entry, config);
  const actor = actorOf(entry, presalePost, lookups);
  if (actor === undefined) return null;
  const presale = entry.presaleId === null ? undefined : lookups.presales.get(entry.presaleId);
  const counts = lookups.reactions.get(entry.entryId);
  return {
    entry_id: entry.entryId,
    kind: entry.kind,
    occurred_at_ms: entry.occurredAtMs,
    presale: presaleChip(presale, nowMs),
    actor,
    amounts: itemAmounts(entry, presale),
    digest: entry.digest,
    milestone_value: entry.source === "milestone" ? entry.milestoneValue : null,
    presale_post: presalePost,
    big,
    why: lookups.whys.get(entry.entryId) ?? null,
    reactions: Object.fromEntries(config.reactions.map((key) => [key, counts?.get(key) ?? 0])),
    through: lookups.through.get(entry.entryId) ?? NO_THROUGH,
    do_the_same: doTheSameDescriptor(
      entry.kind,
      presale
        ? { presale_id: presale.presale_id, lifecycle: presale.lifecycle, start_ms: Number(presale.start_ms), end_ms: Number(presale.end_ms) }
        : null,
      nowMs,
    ),
    call: entry.kind === "presale_commit" && actor?.type === "account" && presale?.lifecycle === "migrated",
    backers: isPresaleNewsEntry(entry) && presale ? (lookups.backers.get(presale.presale_id) ?? []) : null,
  };
}

/**
 * The page's presales with the latest prices of their Quote and sale coins
 * (`chain_read_v1.prices`, keyed by the same normalized types). The presale
 * price of a migrated sale is what its buyers paid: the quote they kept in
 * (commitment − refund) over the tokens they claimed, scaled by both
 * decimals (whole Quote per whole sale token). Claims are pro rata, so every
 * claim has that price and a sample of 50 (the positions' primary key walk)
 * is exact up to rounding; the sale lists and profile calls use the same
 * rule. Null before the first claim. (blast-infra's view does not carry the
 * contract's `token_allocation`.)
 */
const PRESALES_SQL = `SELECT p.presale_id, p.sale_token AS coin_type, coalesce(p.sale_symbol,'') AS symbol, coalesce(p.sale_name,'') AS name, coalesce(p.sale_icon_url,'') AS icon_url, p.lifecycle,
    p.sale_decimals AS decimals, p.venue, p.start_ms, p.end_ms, p.raise_target::text AS raise_target,
    p.total_commitments::text AS raised, p.participants, p.quote_type, p.quote_symbol, p.quote_decimals,
    trim_scale(round((claims.paid * power(10::numeric, p.sale_decimals))
      / NULLIF(claims.tokens * power(10::numeric, p.quote_decimals), 0), 18))::text AS presale_price_quote,
    quote_price.usd_price::text AS quote_usd, quote_price.as_of_ms AS quote_usd_as_of_ms,
    sale_price.usd_price::text AS sale_usd, sale_price.as_of_ms AS sale_usd_as_of_ms,
    coalesce(trust.verified_team, false) AS verified_team
  FROM ${SHOWN_PRESALES} p
  LEFT JOIN social_sale_trust trust ON trust.presale_id = p.presale_id
  LEFT JOIN ${DISPLAY_PRICES} quote_price ON quote_price.coin_type = p.quote_type
  LEFT JOIN ${DISPLAY_PRICES} sale_price ON sale_price.coin_type = p.sale_token
  LEFT JOIN LATERAL (
    SELECT sum(c.commitment - COALESCE(c.claimed_quote_refund, 0)) AS paid, sum(c.claimed_tokens) AS tokens
    FROM (
      SELECT pp.commitment, pp.claimed_quote_refund, pp.claimed_tokens
      FROM chain_read_v1.presale_positions pp
      WHERE p.lifecycle = 'migrated' AND pp.presale_id = p.presale_id AND pp.claim_digest IS NOT NULL AND pp.claimed_tokens > 0
      ORDER BY pp.presale_id, pp.wallet
      LIMIT 50
    ) c
  ) claims ON TRUE
  WHERE p.presale_id = ANY($1::text[])`;

const IDENTITIES_SQL = `SELECT account_id, callsign, display_name, avatar_url, x_handle, verified
  FROM social_account_identities
  WHERE account_id = ANY($1::uuid[])`;

/**
 * The named backers of each presale: accounts the naming rule names for at
 * least one of its commits, with the USD of those commits, the largest first
 * (then the latest, then the callsign), at most `ITEM_BACKERS_MAX` each. The
 * commits are found by presale (the activity log's presale-and-time path).
 */
// The presale's commits (an index-only scan where blast-infra keeps the
// covering index the record asks for) hash-joined to the owners of their
// actors, both materialized so the planner cannot fall back to a loop over
// wallets. Only the commits' actors are named (`namedWalletsOfSql`, by
// address), never every linked wallet, so the cost follows the presales'
// backers rather than the accounts. The identities are read for the kept
// ranks only, one key lookup each (`OFFSET 0` keeps the planner from hashing
// the whole identities view).
export const BACKERS_SQL = `SELECT backers.* FROM (
  WITH commits AS MATERIALIZED (
    SELECT e.presale_id, e.actor, e.usd_value, e.occurred_at_ms
    FROM social_feed_entries e
    WHERE e.source = 'activity' AND e.kind = 'presale_commit' AND e.presale_id = ANY($1::text[])
  ), named AS MATERIALIZED (
    ${namedWalletsOfSql("ARRAY(SELECT DISTINCT c.actor FROM commits c)")}
  )
  SELECT ranked.presale_id, ranked.rank, ranked.usd::text AS usd, i.callsign, i.display_name, i.avatar_url, i.verified
  FROM (
    SELECT backed.presale_id, backed.account_id, backed.usd,
      row_number() OVER (PARTITION BY backed.presale_id ORDER BY backed.usd DESC NULLS LAST, backed.last_ms DESC, backed.account_id) AS rank
    FROM (
      SELECT c.presale_id, n.account_id, sum(c.usd_value) AS usd, max(c.occurred_at_ms) AS last_ms
      FROM commits c
      JOIN named n ON n.address = c.actor AND n.named_from_ms <= c.occurred_at_ms
      GROUP BY c.presale_id, n.account_id
    ) backed
  ) ranked
  CROSS JOIN LATERAL (
    SELECT ii.callsign, ii.display_name, ii.avatar_url, ii.verified
    FROM social_account_identities ii WHERE ii.account_id = ranked.account_id
    OFFSET 0
  ) i
  WHERE ranked.rank <= ${ITEM_BACKERS_MAX} AND i.callsign IS NOT NULL
  ) backers
  ORDER BY backers.presale_id, backers.rank`;

const WHYS_SQL = `SELECT entry_id, why_id, text
  FROM social_whys
  WHERE entry_id = ANY($1::text[]) AND state = 'active'`;

const REACTIONS_SQL = `SELECT entry_id, reaction, count(*)::int AS count
  FROM social_reactions
  WHERE entry_id = ANY($1::text[]) AND reaction = ANY($2::text[])
  GROUP BY entry_id, reaction`;

const THROUGH_SQL = `SELECT entry_id, count(DISTINCT actor_account_id)::int AS people, coalesce(sum(usd_value), 0)::text AS volume_usd
  FROM social_attributions
  WHERE entry_id = ANY($1::text[]) AND voided_at IS NULL
  GROUP BY entry_id`;

type BackerRow = {
  presale_id: string;
  usd: string | null;
  callsign: string;
  display_name: string | null;
  avatar_url: string | null;
  verified: boolean;
};

/** The page's lookups, in six reads that do not depend on the page size. */
export async function readItemLookups(db: ReadableDatabase, entries: readonly FeedEntry[], config: SocialConfig): Promise<ItemLookups> {
  const entryIds = [...new Set(entries.map((entry) => entry.entryId))];
  const presaleIds = [...new Set(entries.flatMap((entry) => (entry.presaleId === null ? [] : [entry.presaleId])))];
  const accountIds = [...new Set(entries.flatMap((entry) => (entry.namedAccountId === null ? [] : [entry.namedAccountId])))];
  const newsPresaleIds = [...new Set(entries.flatMap((entry) => (isPresaleNewsEntry(entry) ? [entry.presaleId!] : [])))];
  const [presales, identities, whys, reactions, through, backers] = await settledAll([
    presaleIds.length ? db.read<PresaleRow>(PRESALES_SQL, [presaleIds]) : null,
    accountIds.length ? db.read<IdentityRow>(IDENTITIES_SQL, [accountIds]) : null,
    db.read<{ entry_id: string; why_id: string; text: string }>(WHYS_SQL, [entryIds]),
    db.read<{ entry_id: string; reaction: string; count: number }>(REACTIONS_SQL, [entryIds, [...config.reactions]]),
    db.read<{ entry_id: string; people: number; volume_usd: string }>(THROUGH_SQL, [entryIds]),
    newsPresaleIds.length ? db.read<BackerRow>(BACKERS_SQL, [newsPresaleIds]) : null,
  ]);
  const backersByPresale = new Map<string, FeedItemBacker[]>();
  for (const row of backers?.rows ?? []) {
    const list = backersByPresale.get(row.presale_id) ?? [];
    list.push({
      callsign: row.callsign,
      display_name: row.display_name,
      avatar_url: row.avatar_url,
      verified: row.verified === true,
      path: profilePagePath(row.callsign),
      usd: row.usd === null ? null : toUsd(row.usd),
    });
    backersByPresale.set(row.presale_id, list);
  }
  const reactionCounts = new Map<string, Map<string, number>>();
  for (const row of reactions.rows) {
    const counts = reactionCounts.get(row.entry_id) ?? new Map<string, number>();
    counts.set(row.reaction, row.count);
    reactionCounts.set(row.entry_id, counts);
  }
  return {
    presales: new Map((presales?.rows ?? []).map((row) => [row.presale_id, row])),
    identities: new Map((identities?.rows ?? []).map((row) => [row.account_id, row])),
    whys: new Map(whys.rows.map((row) => [row.entry_id, { why_id: row.why_id, text: row.text }])),
    reactions: reactionCounts,
    through: new Map(through.rows.map((row) => [row.entry_id, { people: row.people, volume_usd: toUsd(row.volume_usd) }])),
    backers: backersByPresale,
  };
}

/**
 * The public items of a page of entries, in the entries' order. Pass the
 * same `config` the selection used (one `getSocialConfig()` per request), so
 * `big` and `presale_post` agree with what was selected; `nowMs` decides
 * whether an open sale still takes commits. An entry that must not be shown
 * (unnamed and not a presale post) is dropped, so page with
 * `nextItemCursor(entries, limit)`, not with the items.
 */
export async function toItems(db: ReadableDatabase, entries: readonly FeedEntry[], context: ItemContext): Promise<FeedItem[]> {
  if (entries.length === 0) return [];
  const lookups = await readItemLookups(db, entries, context.config);
  return entries.flatMap((entry) => {
    const item = buildItem(entry, lookups, context);
    return item ? [item] : [];
  });
}

/**
 * The post chips of these presales (`FeedItemPresale`), keyed by presale id,
 * in one read: Home's right column and recap (UI-05) show the same presale
 * fields as a post. `nowMs` decides price freshness.
 */
export async function readPresaleChips(db: ReadableDatabase, presaleIds: readonly string[], nowMs: number): Promise<Map<string, FeedItemPresale>> {
  if (presaleIds.length === 0) return new Map();
  const { rows } = await db.read<PresaleRow>(PRESALES_SQL, [[...new Set(presaleIds)]]);
  return new Map(rows.map((row) => [row.presale_id, presaleChip(row, nowMs)!]));
}
