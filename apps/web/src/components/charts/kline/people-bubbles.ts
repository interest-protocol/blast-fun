import { shortAddress } from "@blast/core/lib/format.ts";
import { isActivityTrade, type ActivityRow } from "@blast/core/modules/launchpad-contract/activity.ts";
import { traderProfilesSchema, type TraderProfile } from "@blast/core/modules/social/contracts/trader-profiles.ts";
import { tradeWalletLabels, WALLET_LABELS, type WalletLabel } from "#web/components/launchpad/activity/wallet-labels.ts";
import { shiftDecimal } from "#web/components/launchpad/coin/coin-format.ts";
import type { Bar } from "./kline-model.ts";

/** One trade by one wallet: when, which way, its USD size when known, and its wallet tags. `id` is the activity row's position, unique per event. */
export type PersonTrade = Readonly<{ id: string; address: string; timestampMs: number; side: "buy" | "sell"; usd: number | null; labels: readonly WalletLabel[] }>;

/** One wallet on one bar: everything it bought and sold there. `bought`/`sold` are USD, null when a trade's size is unknown. */
export type Person = Readonly<{
  address: string;
  bar: number;
  /** Net side, the ring's colour: a wallet that bought at least as much as it sold is a buyer. */
  side: "buy" | "sell";
  /** The bar's high, low and close (shown unit): the bubble sits clear of what the chart draws, the candle or the line. */
  high: number;
  low: number;
  close: number;
  bought: number | null;
  sold: number | null;
  buys: number;
  sells: number;
  labels: readonly WalletLabel[];
  own: boolean;
  lastMs: number;
  /** Every trade the wallet made on the bar, newest first. */
  trades: readonly PersonTrade[];
}>;

/** Trades from the activity rows, sized in USD (the indexer's figure, else quote × the quote's USD price). */
export function personTrades(rows: readonly ActivityRow[], deployer: string | null, quoteDecimals: number | null, quoteUsd: string | null): PersonTrade[] {
  return rows.flatMap((row): PersonTrade[] => {
    if (!row.actor || !isActivityTrade(row)) return [];
    const quote = row.amounts.quote;
    let usd: number | null = null;
    if (row.volumeUsd !== undefined) usd = Number(row.volumeUsd);
    else if (quote !== undefined && quoteDecimals !== null && quoteUsd !== null) usd = Number(shiftDecimal(quote.toString(), -quoteDecimals)) * Number(quoteUsd);
    const side = row.kind === "curve_buy" || row.kind === "venue_buy" ? "buy" : "sell";
    return [{ id: row.position, address: row.actor, timestampMs: row.timestampMs, side, usd: usd !== null && Number.isFinite(usd) ? usd : null, labels: tradeWalletLabels(row, deployer) }];
  });
}

const LABEL_ORDER = Object.keys(WALLET_LABELS) as WalletLabel[];
/** Bubbles drawn at most, newest visible first; the viewer's own always stay. */
export const MAX_PEOPLE = 200;

/** The bar each trade fell in (the newest bar starting at or before it), or null before the first bar. */
function barIndex(bars: readonly Bar[], timestampMs: number): number | null {
  let low = 0, high = bars.length - 1, found = -1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if (bars[middle]!.timestamp <= timestampMs) { found = middle; low = middle + 1; } else high = middle - 1;
  }
  return found < 0 ? null : found;
}

/** A wallet that both bought and sold on a bar: sizes decide when both are known, otherwise the count of trades does. */
function netSide({ bought, sold, buys, sells }: Readonly<{ bought: number | null; sold: number | null; buys: number; sells: number }>): Person["side"] {
  if (!buys || !sells) return buys ? "buy" : "sell";
  const boughtMore = bought !== null && sold !== null ? bought >= sold : buys >= sells;
  return boughtMore ? "buy" : "sell";
}

const addUsd = (total: number | null, usd: number | null) => total === null || usd === null ? null : total + usd;

/** One person per wallet per bar. `own` holds the viewer's wallets, lowercased. */
export function barPeople(trades: readonly PersonTrade[], bars: readonly Bar[], own: ReadonlySet<string>): Person[] {
  type Held = { address: string; index: number; bought: number | null; sold: number | null; buys: number; sells: number; labels: Set<WalletLabel>; lastMs: number; trades: PersonTrade[] };
  const held = new Map<string, Held>();
  for (const trade of trades) {
    const index = barIndex(bars, trade.timestampMs);
    if (index === null) continue;
    const key = `${index}:${trade.address}`;
    const person = held.get(key) ?? { address: trade.address, index, bought: 0, sold: 0, buys: 0, sells: 0, labels: new Set(), lastMs: trade.timestampMs, trades: [] };
    if (trade.side === "buy") { person.buys++; person.bought = addUsd(person.bought, trade.usd); } else { person.sells++; person.sold = addUsd(person.sold, trade.usd); }
    person.trades.push(trade);
    for (const label of trade.labels) person.labels.add(label);
    person.lastMs = Math.max(person.lastMs, trade.timestampMs);
    held.set(key, person);
  }
  const people = [...held.values()].map((person): Person => {
    const bar = bars[person.index]!;
    const side = netSide(person);
    return {
      address: person.address, bar: bar.timestamp, side, high: bar.high, low: bar.low, close: bar.close,
      bought: person.buys ? person.bought : null, sold: person.sells ? person.sold : null, buys: person.buys, sells: person.sells,
      labels: LABEL_ORDER.filter((label) => person.labels.has(label)), own: own.has(person.address.toLowerCase()), lastMs: person.lastMs,
      trades: [...person.trades].sort((a, b) => b.timestampMs - a.timestampMs),
    };
  }).sort((a, b) => b.lastMs - a.lastMs);
  // Own first, then newest; the layout keeps the visible ones up to MAX_PEOPLE.
  return [...people.filter((person) => person.own), ...people.filter((person) => !person.own)];
}

/** A bar on screen: its x, and the y of its high (`top`) and low (`bottom`), in px. */
export type BarSpan = Readonly<{ x: number; top: number; bottom: number }>;
type Placed = Readonly<{ person: Person; point: BarSpan }>;
export type Bubble =
  | Readonly<{ kind: "person"; key: string; person: Person; x: number; y: number }>
  | Readonly<{ kind: "more"; key: string; people: readonly Person[]; x: number; y: number }>;

/** Bubbles one column holds before the rest fold into "+N". */
export const STACK_LIMIT = 3;
/** Empty space between a bubble's edge and the price it floats over, in bubbles: one bubble height. */
const GAP = 1;
/** Px of the ring drawn around each bubble. */
export const RING = 2;
/** Px from a bubble's centre to the price it floats over: the gap, the ring and half the bubble. */
const clearance = (size: number) => size * GAP + RING + size / 2;
/** Px above the highest price the chart keeps free, so one bubble and its gap fit over the top bar. */
export const bubbleHeadroom = (size: number) => Math.ceil(clearance(size) + size / 2) + 4;

/** What the chart draws under the bubbles: candles (each bar's high to low), or the line through the closes. */
export type DrawnPrice = Readonly<{
  /** Px at the top of the price pane kept clear for the study legends. */
  topInset?: number;
  /** The bars on screen, in px: candles' high and low, or the line's points (top and bottom both the close). */
  spans?: readonly BarSpan[];
  /** Half a drawn candle's width in px, so a wide candle beside a column counts as under it. */
  halfBar?: number;
  /** The spans are points on one line: the line between them counts too, not only the points. */
  line?: boolean;
}>;

/**
 * Where each bubble goes. Bubbles `size` px wide share a column when their bars are
 * closer than that (zoomed out); a column shows up to `STACK_LIMIT` people, the
 * viewer's own first and always, then tagged wallets, then the newest, and folds the
 * rest into one "+N". Every column floats one bubble height (`GAP`) over the highest
 * price drawn under it, its own bars' and any of `drawn.spans` within reach (on a line,
 * the line itself), and stacks up from there; a column with no room above goes the
 * same gap under the lowest price instead. Nothing goes above `drawn.topInset` px,
 * where the study legends sit.
 */
export function layoutBubbles(people: readonly Person[], place: (person: Person) => BarSpan | null, width: number, height: number, size: number, drawn: DrawnPrice = {}): Bubble[] {
  if (width <= 0 || height <= 0 || size <= 0) return [];
  const visible: Placed[] = [];
  for (const person of people) {
    const point = place(person);
    if (point && [point.x, point.top, point.bottom].every(Number.isFinite) && point.x >= 0 && point.x < width) visible.push({ person, point });
  }
  // People arrive own first, then newest: keep the viewer's own and the newest visible ones.
  const ownCount = visible.filter((placed) => placed.person.own).length;
  const kept = visible.slice(0, Math.max(ownCount, MAX_PEOPLE));
  // Columns at least one bubble apart: a new one starts once a person sits `size` px past the last one's start.
  const row = [...kept].sort((a, b) => a.point.x - b.point.x);
  const bubbles: Bubble[] = [];
  let left = -Infinity;
  let column: Placed[] = [];
  const flush = () => {
    if (!column.length) return;
    const stack = stackColumn(column, height, size, left, drawn);
    left = stack[0]!.x;
    bubbles.push(...stack);
  };
  for (const placed of row) {
    if (column.length && placed.point.x - column[0]!.point.x >= size) { flush(); column = []; }
    column.push(placed);
  }
  flush();
  return bubbles;
}

/** One column's bubbles: the ranked people that fit, then a "+N" for the rest. */
function stackColumn(placed: readonly Placed[], height: number, size: number, previousX: number, { topInset = 0, spans = [], halfBar = 0, line = false }: DrawnPrice): Bubble[] {
  const ranked = [...placed].sort((a, b) => Number(b.person.own) - Number(a.person.own) || b.person.labels.length - a.person.labels.length || b.person.lastMs - a.person.lastMs);
  const own = ranked.filter((entry) => entry.person.own).length;
  const room = Math.max(own, ranked.length > STACK_LIMIT ? STACK_LIMIT - 1 : STACK_LIMIT);
  const shown = ranked.slice(0, room);
  const folded = ranked.slice(room).map((entry) => entry.person);
  const slots = shown.length + (folded.length ? 1 : 0);
  // Centred on the people shown, but never closer than one bubble to the column before.
  const x = Math.max(shown.reduce((sum, entry) => sum + entry.point.x, 0) / shown.length, previousX + size);
  // Every price the bubbles could cover: the column's own bars, and whatever is drawn under the bubble or its ring.
  const under = [...placed.map((entry) => entry.point), ...drawnUnder(spans, x, size / 2 + RING, halfBar, line)];
  const ceiling = Math.min(...under.map((span) => span.top));
  const floor = Math.max(...under.map((span) => span.bottom));
  const step = size * .8, stack = (slots - 1) * step;
  const top = Math.min(topInset, height / 2) + size / 2, bottom = Math.max(top, height - size / 2);
  // Over the price first, stacking up; under it, stacking down, when the top bar leaves no room;
  // otherwise from the top edge down, so the bubbles still never pile on one spot. A bar dragged
  // off the plot anchors at the edge it left by.
  const above = Math.min(ceiling - clearance(size), bottom), below = Math.max(floor + clearance(size), top);
  let at = (slot: number) => clamp(top + stack - slot * step, top, bottom);
  if (above - stack >= top) at = (slot) => above - slot * step;
  else if (below + stack <= bottom) at = (slot) => below + slot * step;
  const bubbles: Bubble[] = shown.map(({ person }, slot) => ({ kind: "person", key: `${person.bar}:${person.address}`, person, x, y: at(slot) }));
  if (folded.length) bubbles.push({ kind: "more", key: `more:${placed[0]!.person.bar}`, people: folded, x, y: at(shown.length) });
  return bubbles;
}

const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));

/**
 * What is drawn within `reach` px either side of `x`. Candles count when their body
 * (`halfBar` px either side of the bar) reaches in. A line counts its points in reach
 * and where it crosses either edge, so a steep segment from a bar just outside still
 * counts: a straight segment is highest and lowest at its ends. `spans` run left to right.
 */
function drawnUnder(spans: readonly BarSpan[], x: number, reach: number, halfBar: number, line: boolean): BarSpan[] {
  const body = line ? 0 : halfBar, from = x - reach - body, to = x + reach + body;
  const inside = spans.filter((span) => span.x >= from && span.x <= to);
  if (!line) return inside;
  const crossings = spans.slice(1).flatMap((next, index) => {
    const last = spans[index]!;
    return [from, to].filter((edge) => last.x < edge && edge < next.x).map((edge) => {
      const share = (edge - last.x) / (next.x - last.x);
      return { x: edge, top: last.top + (next.top - last.top) * share, bottom: last.bottom + (next.bottom - last.bottom) * share };
    });
  });
  return [...inside, ...crossings];
}

/** Who a wallet is on the chart: its Blast profile, or an anonymous circle and short address. */
export function personIdentity(address: string, profile: TraderProfile | null | undefined) {
  return profile
    ? { anonymous: false as const, name: `@${profile.callsign}`, callsign: profile.callsign, avatarUrl: profile.avatarUrl }
    : { anonymous: true as const, name: shortAddress(address), callsign: null, avatarUrl: null };
}

/**
 * A press from a real mouse, which follows the bubble's link. Touch and keyboard open its card instead,
 * and so do screen readers, which press as a 1 x 1 mouse with no pressure.
 */
export function mousePress(press: Readonly<{ pointerType: string; width: number; height: number; pressure: number; buttons: number }>): boolean {
  return press.pointerType === "mouse" && !(press.width <= 1 && press.height <= 1 && press.pressure === 0 && press.buttons === 0);
}

/** A profile the lookup returned for a wallet, true from `sinceMs` (the earliest trade it was asked about) on. */
export type SeenProfile = Readonly<{ profile: TraderProfile; sinceMs: number }>;

/**
 * Folds trader-profile answers (keyed `address:timestampMs`) into what is known per
 * wallet. A profile counts from the earliest trade time it was returned for, so an
 * older trade is never credited to a profile linked after it. Returns `seen` itself
 * when nothing changed.
 */
export function rememberProfiles(seen: ReadonlyMap<string, SeenProfile>, answers: readonly unknown[]): ReadonlyMap<string, SeenProfile> {
  let next: Map<string, SeenProfile> | null = null;
  for (const answer of answers) {
    const parsed = traderProfilesSchema.safeParse(answer);
    if (!parsed.success) continue;
    for (const [key, profile] of Object.entries(parsed.data)) {
      const split = key.lastIndexOf(":");
      const address = key.slice(0, split).toLowerCase();
      const sinceMs = Number(key.slice(split + 1));
      if (!profile || split < 0 || !Number.isSafeInteger(sinceMs)) continue;
      const merged = mergeProfile((next ?? seen).get(address), profile, sinceMs);
      if (!merged) continue;
      next ??= new Map(seen);
      next.set(address, merged);
    }
  }
  return next ?? seen;
}

/** What a new answer changes for one wallet, or null when it adds nothing. A changed profile (new avatar, new callsign) replaces the old one from its own time. */
function mergeProfile(known: SeenProfile | undefined, profile: TraderProfile, sinceMs: number): SeenProfile | null {
  const same = known?.profile.callsign === profile.callsign;
  if (known && same && known.sinceMs <= sinceMs && known.profile.avatarUrl === profile.avatarUrl) return null;
  return { profile, sinceMs: known && same ? Math.min(known.sinceMs, sinceMs) : sinceMs };
}

/** The profile to show for a wallet's trade at `timestampMs`, if one is known for that time. */
export function profileAt(seen: ReadonlyMap<string, SeenProfile>, address: string, timestampMs: number): TraderProfile | null {
  const known = seen.get(address.toLowerCase());
  return known && timestampMs >= known.sinceMs ? known.profile : null;
}
