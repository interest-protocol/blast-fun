import { z } from "zod";
import { shortAddress } from "@blast/core/lib/format.ts";
import type { FeedItemActor } from "@blast/core/modules/social/contracts/items.ts";
import { toUsd } from "@blast/core/modules/social/items/decimal.ts";

import {
  HOME_KINDS,
  HOME_PREVIEW_ROWS,
  type HomeActivity,
  type HomeAmount,
  type HomeKind,
  type HomeParticipant,
  type HomeSide,
  type HomeWindow,
} from "@blast/core/modules/social/contracts/home.ts";
import { SOCIAL_TRADE_BASE_COINS } from "@blast/core/modules/social/contracts/trades.ts";
import { profilePagePath } from "@blast/core/modules/social/contracts/profiles.ts";
import type { GroupedRow, SideRow } from "@blast/server/modules/social/home/sql.ts";

/**
 * From grouped rows to the contract's shapes, with no arithmetic the
 * database did not do: the sums arrive exact (`numeric` as text) and are
 * only labelled here. Pure, so every rule is unit-tested without a database:
 * which quote asset a sum is in, which direction a kind is, how the counts
 * of a window are told, and which rows the preview keeps.
 */

/** A public identity row (`social_account_identities`). */
export type IdentityRow = Readonly<{
  account_id: string;
  callsign: string | null;
  display_name: string | null;
  avatar_url: string | null;
  x_handle: string | null;
  verified: boolean;
}>;

const homeKindSchema = z.enum(HOME_KINDS);

export function isHomeKind(kind: string): kind is HomeKind {
  return homeKindSchema.safeParse(kind).success;
}

/**
 * The quote asset of a sum: the sale's quote when it is the sale's (symbol
 * and decimals from the view), SUI or USDC by their canonical types, else an
 * asset the web cannot name (symbol and decimals null, atoms still exact).
 */
export function quoteAssetOf(
  quoteType: string,
  sale: Readonly<{ sale_quote: string; sale_quote_symbol: string; sale_quote_decimals: number }>,
): Readonly<{ symbol: string | null; decimals: number | null }> {
  if (quoteType === sale.sale_quote) return { symbol: sale.sale_quote_symbol, decimals: sale.sale_quote_decimals };
  if (quoteType === SOCIAL_TRADE_BASE_COINS.sui) return { symbol: "SUI", decimals: 9 };
  if (quoteType === SOCIAL_TRADE_BASE_COINS.usdc) return { symbol: "USDC", decimals: 6 };
  return { symbol: null, decimals: null };
}

/** One sum row as an amount. */
export function amountOf(row: SideRow): HomeAmount {
  const asset = quoteAssetOf(row.quote_type, row);
  return {
    quote_type: row.quote_type,
    quote_symbol: asset.symbol,
    quote_decimals: asset.decimals,
    atoms: row.atoms,
    usd: row.usd === null ? null : toUsd(row.usd),
    usd_complete: Number(row.unpriced) === 0,
  };
}

/** The sale's quote first, then the others by type, so a card's first figure is the sale's own coin. */
function byAsset(sale: string, a: HomeAmount, b: HomeAmount): number {
  if (a.quote_type === sale) return -1;
  if (b.quote_type === sale) return 1;
  return a.quote_type < b.quote_type ? -1 : a.quote_type > b.quote_type ? 1 : 0;
}

function addAtoms(a: string | null, b: string | null): string | null {
  if (a === null) return b;
  if (b === null) return a;
  return (BigInt(a) + BigInt(b)).toString();
}

/** The side rows of one direction as a `HomeSide`: one amount per quote asset, exact. */
export function sideOf(rows: readonly SideRow[]): HomeSide | null {
  if (rows.length === 0) return null;
  const sale = rows[0]!.sale_quote;
  const amounts = rows.map(amountOf).sort((a, b) => byAsset(sale, a, b));
  let tokens: string | null = null;
  for (const row of rows) tokens = addAtoms(tokens, row.tokens);
  return {
    count: rows.reduce((sum, row) => sum + Number(row.n), 0),
    amounts,
    tokens,
    latest_ms: Math.max(...rows.map((row) => Number(row.latest_ms))),
  };
}

/**
 * One direction summed across sales (a trader's figure): the rows of one
 * kind from several coins, each asset merged exactly (`totalsOf`), the
 * counts and tokens added, the latest time kept. Null for no rows.
 */
export function sideAcross(rows: readonly SideRow[]): HomeSide | null {
  if (rows.length === 0) return null;
  let tokens: string | null = null;
  for (const row of rows) tokens = addAtoms(tokens, row.tokens);
  return {
    count: rows.reduce((sum, row) => sum + Number(row.n), 0),
    amounts: totalsOf(rows),
    tokens,
    latest_ms: Math.max(...rows.map((row) => Number(row.latest_ms))),
  };
}

/** The actor a grouped row shows: the named account's identity when it has a callsign, else the wallet. */
export function actorOf(row: Pick<GroupedRow, "account_id" | "wallet">, identities: ReadonlyMap<string, IdentityRow>): FeedItemActor {
  const identity = row.account_id === null ? undefined : identities.get(row.account_id);
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
  return { type: "address", address: row.wallet, short: shortAddress(row.wallet) };
}

export type ParticipantInputs = Readonly<{
  grouped: GroupedRow;
  sides: readonly SideRow[];
  identities: ReadonlyMap<string, IdentityRow>;
  /** Followers on Blast per account id; an account absent here has an unknown count (null), never 0. */
  followers: ReadonlyMap<string, number>;
}>;

/** One participant from its grouped row and its side rows. */
export function participantOf(input: ParticipantInputs): HomeParticipant {
  const { grouped, sides, identities, followers } = input;
  const actor = actorOf(grouped, identities);
  const byKind = (kind: HomeKind) => sideOf(sides.filter((row) => row.kind === kind));
  const latestKind = isHomeKind(grouped.latest_kind) ? grouped.latest_kind : "trade_buy";
  return {
    key: actor.type === "account" ? `c:${actor.callsign}` : `w:${actor.address}`,
    actor,
    followers: actor.type === "account" && grouped.account_id !== null ? (followers.get(grouped.account_id) ?? null) : null,
    buys: byKind("trade_buy"),
    sells: byKind("trade_sell"),
    commits: byKind("presale_commit"),
    claims: byKind("presale_claim"),
    latest_ms: Number(grouped.latest_ms),
    latest_kind: latestKind,
    events_total: Number(grouped.events_total),
  };
}

/** What a window holds for one sale, as the counts statement yields it. */
export type WindowCountsRow = Readonly<{
  sale: string;
  participants: string;
  events: string;
  buyers: string;
  sellers: string;
  backers: string;
  claimers: string;
  latest_ms: string | null;
  /** The window's priced dollars, every direction, two places (`0.00` when nothing was priced). */
  volume_usd: string;
}>;

/** The totals of one direction across a sale: the side rows summed per quote asset. */
export function totalsOf(rows: readonly SideRow[]): readonly HomeAmount[] {
  if (rows.length === 0) return [];
  const sale = rows[0]!.sale_quote;
  const byType = new Map<string, { row: SideRow; atoms: bigint; usd: string | null; unpriced: number }>();
  for (const row of rows) {
    const current = byType.get(row.quote_type);
    if (!current) {
      byType.set(row.quote_type, { row, atoms: BigInt(row.atoms), usd: row.usd, unpriced: Number(row.unpriced) });
      continue;
    }
    current.atoms += BigInt(row.atoms);
    current.unpriced += Number(row.unpriced);
    current.usd = current.usd === null ? row.usd : row.usd === null ? current.usd : addDecimal(current.usd, row.usd);
  }
  return [...byType.values()]
    .map(({ row, atoms, usd, unpriced }) => amountOf({ ...row, atoms: atoms.toString(), usd, unpriced: String(unpriced) }))
    .sort((a, b) => byAsset(sale, a, b));
}

/**
 * A holder's share of the supply in basis points, floored; null without a
 * positive supply, or when the balance is above it: a supply below what is
 * held is wrong, so the share is unknown, never above 100 %.
 */
export function shareBps(balance: string, supply: string | null): number | null {
  if (supply === null || !/^\d+$/.test(supply) || !/^\d+$/.test(balance) || BigInt(supply) === 0n || BigInt(balance) > BigInt(supply)) return null;
  return Number((BigInt(balance) * 10_000n) / BigInt(supply));
}

/** Two PostgreSQL decimals (`digits[.digits]`) added exactly, as text. */
export function addDecimal(a: string, b: string): string {
  const [ai, af = ""] = a.split(".");
  const [bi, bf = ""] = b.split(".");
  const scale = Math.max(af.length, bf.length);
  const sum = BigInt(ai! + af.padEnd(scale, "0")) + BigInt(bi! + bf.padEnd(scale, "0"));
  const text = sum.toString().padStart(scale + 1, "0");
  return scale === 0 ? text : `${text.slice(0, -scale)}.${text.slice(-scale)}`;
}

export function activityOf(
  input: Readonly<{
    scope: HomeActivity["scope"];
    window: HomeWindow;
    fromMs: number;
    toMs: number;
    counts: WindowCountsRow | undefined;
    sides: readonly SideRow[];
    preview: readonly HomeParticipant[];
  }>,
): HomeActivity {
  const { counts, sides } = input;
  const kind = (name: HomeKind) => sides.filter((row) => row.kind === name);
  return {
    scope: input.scope,
    window: input.window,
    from_ms: input.fromMs,
    to_ms: input.toMs,
    participants: Number(counts?.participants ?? 0),
    events: Number(counts?.events ?? 0),
    buyers: Number(counts?.buyers ?? 0),
    sellers: Number(counts?.sellers ?? 0),
    backers: Number(counts?.backers ?? 0),
    claimers: Number(counts?.claimers ?? 0),
    bought: totalsOf(kind("trade_buy")),
    sold: totalsOf(kind("trade_sell")),
    committed: totalsOf(kind("presale_commit")),
    latest_ms: counts?.latest_ms === null || counts?.latest_ms === undefined ? null : Number(counts.latest_ms),
    preview: input.preview,
  };
}

/** Newest first, then by key (bytewise), so an order is the same on every read. */
export function byRecency(a: HomeParticipant, b: HomeParticipant): number {
  return b.latest_ms - a.latest_ms || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
}

/**
 * The rows a card previews, from the participants newest first: at most
 * `HOME_PREVIEW_ROWS`, and when anyone sold in the window, at least one row
 * that sold (the newest seller), so selling is never hidden by the preview.
 */
export function previewOf(participants: readonly HomeParticipant[], rows = HOME_PREVIEW_ROWS): readonly HomeParticipant[] {
  const ordered = [...participants].sort(byRecency);
  const kept = ordered.slice(0, rows);
  if (kept.some((row) => row.sells !== null)) return kept;
  const seller = ordered.find((row) => row.sells !== null);
  if (!seller) return kept;
  return [...kept.slice(0, Math.max(0, rows - 1)), seller];
}

/** The window's counts per sale from its side rows: distinct identities overall and per direction, events and the latest time. */
export function countsOf(sides: readonly SideRow[]): ReadonlyMap<string, WindowCountsRow> {
  const perSale = new Map<string, { who: Set<string>; byKind: Map<string, Set<string>>; events: number; latest: number; volume: string }>();
  for (const row of sides) {
    const sale = perSale.get(row.sale) ?? { who: new Set(), byKind: new Map(), events: 0, latest: 0, volume: "0.00" };
    sale.who.add(row.who);
    if (row.usd !== null) sale.volume = addDecimal(sale.volume, row.usd);
    const kind = sale.byKind.get(row.kind) ?? new Set<string>();
    kind.add(row.who);
    sale.byKind.set(row.kind, kind);
    sale.events += Number(row.n);
    sale.latest = Math.max(sale.latest, Number(row.latest_ms));
    perSale.set(row.sale, sale);
  }
  const size = (sale: { byKind: Map<string, Set<string>> }, kind: HomeKind) => String(sale.byKind.get(kind)?.size ?? 0);
  return new Map([...perSale].map(([id, sale]) => [id, {
    sale: id,
    participants: String(sale.who.size),
    events: String(sale.events),
    buyers: size(sale, "trade_buy"),
    sellers: size(sale, "trade_sell"),
    backers: size(sale, "presale_commit"),
    claimers: size(sale, "presale_claim"),
    latest_ms: sale.events === 0 ? null : String(sale.latest),
    volume_usd: sale.volume,
  }]));
}
