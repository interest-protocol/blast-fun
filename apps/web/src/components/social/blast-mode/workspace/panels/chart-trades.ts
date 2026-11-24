import type { HomeEvent, HomeParticipant } from "@blast/core/web/contracts/home.ts";
import type { PlacedObservation } from "./chart-visual";
import type { FeedItem } from "@blast/core/web/contracts/items.ts";
import type { HomeChartTrade } from "@blast/core/web/contracts/coin-market.ts";

export type TradeGroup = "kol" | "top" | "following";
export type TradeFilters = Readonly<{
  groups: Readonly<Record<TradeGroup, boolean>>;
  buy: boolean;
  sell: boolean;
  posts: boolean;
}>;
export const DEFAULT_TRADE_FILTERS: TradeFilters = {
  groups: { kol: true, top: true, following: true }, buy: true, sell: true, posts: true,
};
/** Why a trade is on the chart: a social group, the viewer's own trade, or a big trade (#534 reads). */
export type ChartGroup = TradeGroup | "mine" | "big";
export type ChartTrade = Readonly<{
  actor: HomeParticipant["actor"];
  event: HomeEvent;
  groups: readonly ChartGroup[];
  pnlRank: number | null;
  thesis?: FeedItem;
}>;
export type ChartPost = Readonly<{
  actor: NonNullable<FeedItem["actor"]>;
  post: FeedItem;
  groups: readonly TradeGroup[];
  pnlRank: number | null;
}>;
export type ChartAnnotation = ChartTrade | ChartPost;
export const annotationTime = (item: ChartAnnotation) => "event" in item ? item.event.occurred_at_ms : item.post.occurred_at_ms;
export const annotationId = (item: ChartAnnotation) => "event" in item ? item.event.entry_id : item.post.entry_id;

function actorGroups(callsign: string, filters: TradeFilters, kols: ReadonlySet<string>, ranks: ReadonlyMap<string, number>, follows: (callsign: string) => boolean | undefined) {
  const groups: TradeGroup[] = [];
  if (filters.groups.kol && kols.has(callsign)) groups.push("kol");
  if (filters.groups.top && ranks.has(callsign)) groups.push("top");
  if (filters.groups.following && follows(callsign) === true) groups.push("following");
  return groups;
}

/** Public events only; overlapping social groups never duplicate a trade. */
export function filterChartTrades(
  participants: readonly HomeParticipant[], filters: TradeFilters,
  kols: ReadonlySet<string>, ranks: ReadonlyMap<string, number>,
  follows: (callsign: string) => boolean | undefined,
): readonly ChartTrade[] {
  const seen = new Set<string>();
  return participants.flatMap(({ actor, events }) => {
    if (actor.type !== "account") return [];
    const groups = actorGroups(actor.callsign, filters, kols, ranks, follows);
    if (!groups.length) return [];
    return (events ?? []).flatMap(event => {
      const selected = (event.kind === "trade_buy" && filters.buy) || (event.kind === "trade_sell" && filters.sell);
      if (!selected || !Number.isFinite(event.occurred_at_ms) || seen.has(event.activity_id)) return [];
      seen.add(event.activity_id);
      return [{ actor, event, groups, pnlRank: ranks.get(actor.callsign) ?? null }];
    });
  }).sort((a, b) => a.event.occurred_at_ms - b.event.occurred_at_ms);
}

/** Only the current market's real authored posts; a call never becomes an invented trade. */
export function withChartPosts(trades: readonly ChartTrade[], posts: readonly FeedItem[], presaleId: string | null, filters: TradeFilters, kols: ReadonlySet<string>, ranks: ReadonlyMap<string, number>, follows: (callsign: string) => boolean | undefined): readonly ChartAnnotation[] {
  if (!filters.posts || !presaleId) return trades;
  const result = new Map<string, ChartAnnotation>(trades.map(trade => [trade.event.entry_id, trade]));
  for (const post of posts) {
    if (!eligibleChartPost(post, presaleId, filters)) continue;
    const groups = actorGroups(post.actor.callsign, filters, kols, ranks, follows);
    if (!groups.length) continue;
    const linked = result.get(post.entry_id);
    if (linked && "event" in linked) {
      if (linked.actor.type === "account" && linked.actor.callsign === post.actor.callsign && linked.event.kind === post.kind) result.set(post.entry_id, { ...linked, thesis: post });
    } else result.set(post.entry_id, { actor: post.actor, post, groups, pnlRank: ranks.get(post.actor.callsign) ?? null });
  }
  return [...result.values()].sort((a,b) => annotationTime(a) - annotationTime(b));
}

function eligibleChartPost(post: FeedItem, presaleId: string, filters: TradeFilters): post is FeedItem & { actor: Extract<NonNullable<FeedItem["actor"]>, { type: "account" }> } {
  return post.presale?.presale_id === presaleId && post.actor?.type === "account"
    && Number.isFinite(post.occurred_at_ms) && !!(post.why || post.call)
    && !(post.kind === "trade_buy" && !filters.buy) && !(post.kind === "trade_sell" && !filters.sell);
}

/** Fixed time buckets keep neighboring touch targets apart; details retain exact timestamps. */
export function groupChartTrades<T extends ChartAnnotation>(trades: readonly T[], start: number, end: number, width: number, targetSize = 44, projectTime?: (at: number) => number | null) {
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return [];
  const bins = Math.max(1, Math.floor(width / targetSize));
  const groups = new Map<number, T[]>();
  for (const trade of trades) {
    const at = annotationTime(trade);
    if (at < start || at > end) continue;
    const ratio = projectTime ? projectTime(at) : end === start ? .5 : (at - start) / (end - start);
    if (ratio === null || ratio < 0 || ratio > 1) continue;
    const index = Math.min(bins - 1, Math.floor(ratio * bins));
    const bucket = groups.get(index) ?? [];
    bucket.push(trade);
    groups.set(index, bucket);
  }
  return [...groups].map(([index, events]) => ({ index, left: (index + 0.5) / bins * 100, trades: events }));
}

/** Chart context only: never infer an execution price or bridge a missing/source segment. */
export function chartTradeY(segments: readonly (readonly PlacedObservation[])[], left: number): number | null {
  const x = left * 10;
  for (const segment of segments) {
    if (!segment.length || x < segment[0]!.x || x > segment.at(-1)!.x) continue;
    for (let i = 0; i < segment.length; i++) {
      const point = segment[i]!;
      if (point.x === x) return point.y / 3;
      const next = segment[i + 1];
      if (next && point.x < x && x < next.x) {
        return (point.y + (next.y - point.y) * (x - point.x) / (next.x - point.x)) / 3;
      }
    }
  }
  return null;
}

/** A chart-trades read row as a chart annotation: the same marker and details as a social trade. */
export function chartTradeAnnotation(trade: HomeChartTrade, group: "mine" | "big", quote: Readonly<{ type: string; symbol: string; decimals: number }> | null): ChartTrade {
  return {
    actor: trade.actor,
    groups: [group],
    pnlRank: null,
    event: {
      activity_id: trade.entry_id.replace(/^a:/, ""),
      entry_id: trade.entry_id,
      kind: trade.side === "buy" ? "trade_buy" : "trade_sell",
      occurred_at_ms: trade.timestamp_ms,
      digest: trade.digest,
      quote: { quote_type: quote?.type ?? "", quote_symbol: quote?.symbol ?? null, quote_decimals: quote?.decimals ?? null, atoms: trade.quote_atoms, usd: trade.usd, usd_complete: trade.usd !== null },
      tokens: trade.coin_atoms,
      refund: null,
      has_why: false,
    },
  };
}

/** One marker per trade: a social trade that is also the viewer's own or a big trade keeps every reason. */
export function mergeChartAnnotations(base: readonly ChartAnnotation[], extra: readonly ChartTrade[]): readonly ChartAnnotation[] {
  const result = new Map<string, ChartAnnotation>(base.map(item => [annotationId(item), item]));
  for (const trade of extra) {
    const existing = result.get(trade.event.entry_id);
    if (existing && "event" in existing) result.set(trade.event.entry_id, { ...existing, groups: [...new Set([...existing.groups, ...trade.groups])] });
    else if (!existing) result.set(trade.event.entry_id, trade);
  }
  return [...result.values()].sort((a, b) => annotationTime(a) - annotationTime(b));
}
