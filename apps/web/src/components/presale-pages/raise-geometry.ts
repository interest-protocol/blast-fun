import { quoteOf, readsInCoin, shortAddress } from "@blast/core/web/format.ts";
import type { SocialPresaleDetail, SocialPresalePerson, SocialPresaleViewerEntry } from "@blast/core/web/contracts/presales.ts";

import { gatePixel } from "#web/components/charts/spark-model.ts";

import { n, saleMoney, saleShort, type QuoteSource } from "@blast/core/modules/presale/presentation.ts";

/**
 * The raise chart's geometry (FEATURE-MAP §10.3, the gate's `raiseChart`):
 * pure, so what the chart library is given is tested once. The chart is
 * 220 px tall with 24 px above the plot and 26 below it; the x axis runs
 * from the sale's open to now (while open) or its end, the y axis from 0 to
 * the larger of 112% of the target and 106% of what was raised (however
 * small: a test sale's 0.02 SUI fills the plot as $250K does). Heights are
 * in the sale's own coin (R3-40): dollars for a USDC sale, the quote atoms
 * over the decimals for a SUI sale.
 */

export type ChartOverlays = Readonly<{ mine: boolean; following: boolean; big: boolean; thesis: boolean }>;

export type ChartMark = Readonly<{
  t: number;
  /** The commit in dollars, for every sale (the gate's `usd(p.b.usd)`; a SUI commit's at its own time): its tooltip and its rank. */
  usd: number;
  who: string;
  person: Pick<SocialPresalePerson, "avatar_url"> & Partial<Pick<SocialPresalePerson, "callsign">> | null;
  why: string | null;
  kind: "mine" | "following" | "big" | "thesis";
  /** Who wins when markers would overlap (OA-24): 0 the viewer, 1 someone they follow, 2 anyone else. */
  rank: 0 | 1 | 2;
}>;

export const RAISE_CHART_HEIGHT = 220;
export const RAISE_PAD_TOP = 24;
export const RAISE_PAD_BOTTOM = 26;

/** A raise point as the read answers it: `[ms, usd, atoms]` (R3-40 added the atoms). */
export type RaiseSample = readonly [number, string, string?];

/**
 * R3-40: a point's height in the sale's own coin — its dollars for a USDC
 * sale, its quote atoms over the decimals for a SUI sale. Geometry only: the
 * figures the chart prints come from `saleMoney` / `saleShort`, exactly.
 */
export function pointValue(sale: QuoteSource, point: RaiseSample): number {
  if (!readsInCoin(quoteOf(sale))) return n(point[1]);
  return n(point[2]) / 10 ** sale.quote_decimals;
}

/** The raised total at `t` from the downsampled series (the last point at or before it), in the sale's unit (dollars without one). */
export function raisedAt(points: readonly RaiseSample[], t: number, sale?: QuoteSource): number {
  let value = 0;
  for (const point of points) {
    if (point[0] > t) break;
    value = sale ? pointValue(sale, point) : n(point[1]);
  }
  return value;
}

/** A marker's circle on the chart: its centre and radius. */
export type MarkSpot = Readonly<{ x: number; y: number; r: number }>;

/** The "now" dot's radius as the placement counts it (the dot itself is drawn at 4.5). */
const NOW_R = 6;
/** The air every marker keeps from the ones already placed. */
const MARK_GAP = 4;

/**
 * Markers never pile up (OA-24, the gate's `raiseChart`): the viewer's own
 * commits first, then people they follow, then everyone else, the biggest
 * commit first within each; each is kept only if it clears every marker
 * already placed, and the "now" dot while the sale is open, by its radius plus
 * theirs plus 4. What is kept comes back in its original (time) order.
 */
export function unpiledMarks<M extends MarkSpot & Readonly<{ rank: number; usd: number }>>(marks: readonly M[], now: Readonly<{ x: number; y: number }> | null): M[] {
  const placed: MarkSpot[] = now ? [{ x: now.x, y: now.y, r: NOW_R }] : [];
  const kept = new Set<M>();
  const byPriority = [...marks].sort((a, b) => a.rank - b.rank || b.usd - a.usd);
  for (const mark of byPriority) {
    if (placed.some((spot) => Math.hypot(spot.x - mark.x, spot.y - mark.y) < spot.r + mark.r + MARK_GAP)) continue;
    placed.push(mark);
    kept.add(mark);
  }
  return marks.filter((mark) => kept.has(mark));
}

/** One point of the drawn line: a time and the total raised by then. */
export type RaisePoint = Readonly<{ t: number; v: number }>;

export type RaiseGeometry = Readonly<{
  /** The sale's coin, the unit of every height (R3-40). */
  quote: QuoteSource;
  /** The x axis: the sale's open, and now (open) or its end. */
  t0: number;
  t1: number;
  /** The y axis tops out here. */
  maxV: number;
  target: number;
  total: number;
  open: boolean;
  /**
   * The line as the gate draws it: from zero at the open, through every
   * point, flat to the right edge at the total (`M0 Y(0) … L W Y(total)`).
   */
  line: readonly RaisePoint[];
  /** The "now" dot (the last point) while the sale is open, else null. */
  now: RaisePoint | null;
}>;

export function raiseGeometry(detail: SocialPresaleDetail, nowMs: number): RaiseGeometry {
  const sale = detail.presale;
  const points = detail.raise.points;
  const quote: QuoteSource = { quote_symbol: sale.quote_symbol, quote_decimals: sale.quote_decimals };
  const target = readsInCoin(quoteOf(sale)) ? n(sale.target_atoms) / 10 ** sale.quote_decimals : n(sale.target_usd);
  const open = sale.phase === "open";
  const t0 = sale.opened_ms ?? sale.start_ms;
  const t1 = open ? Math.max(nowMs, points.at(-1)?.[0] ?? t0) : sale.end_ms;
  const last = points.at(-1);
  const total = last ? pointValue(quote, last) : 0;
  return {
    quote,
    t0,
    t1,
    // No floor but for a sale with neither a target nor a raise (the gate's has none).
    maxV: Math.max(target * 1.12, total * 1.06) || 1,
    target,
    total,
    open,
    line: [{ t: t0, v: 0 }, ...points.map((point) => ({ t: point[0], v: pointValue(quote, point) })), { t: t1, v: total }],
    now: open && last ? { t: last[0], v: pointValue(quote, last) } : null,
  };
}

/**
 * The words the chart prints, in the sale's own coin (R3-40, the gate's `qm`
 * and `qs`): its accessible name, `Total raised over time: 99,970 SUI of
 * 100,000 SUI`, and the target line's label, `Target 100K SUI`.
 */
export function raiseLabels(detail: SocialPresaleDetail): Readonly<{ label: string; target: string }> {
  const sale = detail.presale;
  const final = detail.raise.points.at(-1);
  return {
    label: `Total raised over time: ${saleMoney(sale, final?.[1] ?? "0", final?.[2] ?? "0")} of ${saleMoney(sale, sale.target_usd, sale.target_atoms)}`,
    target: `Target ${saleShort(sale, sale.target_usd, sale.target_atoms)}`,
  };
}

/**
 * The pixel position of a time and an amount in a chart `width` wide (the
 * gate's `X` and `Y`). It is the scale recharts derives from the plot's axes
 * (x over `[t0, t1]` across the full width, y over `[0, maxV]` between the
 * paddings), so what is placed with it sits on the drawn line.
 */
export function raiseScale(geometry: RaiseGeometry, width: number, height = RAISE_CHART_HEIGHT) {
  const { t0, t1, maxV } = geometry;
  return {
    x: (t: number) => ((t - t0) / Math.max(1, t1 - t0)) * width,
    y: (v: number) => height - RAISE_PAD_BOTTOM - (v / maxV) * (height - RAISE_PAD_TOP - RAISE_PAD_BOTTOM),
  };
}

/**
 * The line as the chart is given it at `width`: every vertex but the first
 * moved by at most 0.05 px onto the tenth of a pixel the gate writes
 * (`toFixed(1)`), so the drawn edge falls on the gate's pixels.
 */
export function raiseData(geometry: RaiseGeometry, width: number, height = RAISE_CHART_HEIGHT): RaisePoint[] {
  const { t0, t1, maxV } = geometry;
  const span = Math.max(1, t1 - t0);
  const plot = height - RAISE_PAD_TOP - RAISE_PAD_BOTTOM;
  const scale = raiseScale(geometry, width, height);
  return geometry.line.map((point, index) =>
    index === 0
      ? point
      : { t: t0 + (gatePixel(scale.x(point.t)) / width) * span, v: ((height - RAISE_PAD_BOTTOM - gatePixel(scale.y(point.v))) / plot) * maxV },
  );
}

/**
 * The markers drawn in a chart `width` wide: each on the line at the total
 * raised by its time, with the radius it is drawn at (13 for an avatar, 5
 * for a ring), thinned by `unpiledMarks` around the "now" dot.
 */
export function placeMarks<M extends Readonly<{ mark: ChartMark; r: number }>>(
  geometry: RaiseGeometry,
  points: readonly RaiseSample[],
  width: number,
  items: readonly M[],
  height = RAISE_CHART_HEIGHT,
): (M & MarkSpot & Readonly<{ rank: number; usd: number }>)[] {
  const scale = raiseScale(geometry, width, height);
  return unpiledMarks(
    items.map((item) => ({ ...item, rank: item.mark.rank, usd: item.mark.usd, x: scale.x(item.mark.t), y: scale.y(raisedAt(points, item.mark.t, geometry.quote)) })),
    geometry.now ? { x: scale.x(geometry.now.t), y: scale.y(geometry.now.v) } : null,
  );
}

function followedChartMarks(following: SocialPresaleViewerEntry["following"]): ChartMark[] {
  return following.flatMap((row) => row.commits.map(([t, value]) => ({
    t, usd: n(value), who: (row.account.display_name ?? row.account.callsign).split(" ")[0]!,
    person: row.account, why: row.why, kind: "following" as const, rank: 1 as const,
  })));
}

function publicChartMark(marker: SocialPresaleDetail["raise"]["markers"][number], big: boolean, rank: ChartMark["rank"]): ChartMark {
  return {
    t: marker.t, usd: n(marker.commit_usd),
    who: marker.account ? (marker.account.display_name ?? marker.account.callsign).split(" ")[0]! : shortAddress(marker.wallet),
    person: marker.account, why: marker.why, kind: big ? "big" : "thesis", rank,
  };
}

/**
 * The commits the overlays pick for the sale page's chart, oldest first, each
 * once: the viewer's own (`mine`), those of people they follow
 * (`following`), and the sale's named markers that are big (`big`, $5,000 or
 * more) or carry a thesis (`thesis`), ranked so the viewer's win, then
 * their follows'. The markers read and rank in dollars for every sale, the
 * gate's `usd(p.b.usd)` (a SUI commit's at its own time).
 */
export function saleChartMarks(
  input: Readonly<{
    detail: SocialPresaleDetail;
    viewerEntry: SocialPresaleViewerEntry | null;
    overlays: ChartOverlays;
    me: Pick<SocialPresalePerson, "avatar_url"> | null;
    viewerCallsign: string | null;
  }>,
): ChartMark[] {
  const { detail, viewerEntry, overlays, me, viewerCallsign } = input;
  const out: ChartMark[] = [];
  const seen = new Set<string>();
  const followed = new Set(viewerEntry?.following.map((row) => row.account.callsign) ?? []);
  const rankOf = (callsign: string | null | undefined): ChartMark["rank"] =>
    callsign && callsign === viewerCallsign ? 0 : callsign && followed.has(callsign) ? 1 : 2;
  const add = (mark: ChartMark) => {
    const key = `${mark.t}:${mark.who}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(mark);
  };
  if (overlays.mine) {
    for (const [t, value] of viewerEntry?.mine?.commits ?? []) add({ t, usd: n(value), who: "You", person: me ? { ...me, callsign: viewerCallsign ?? undefined } : null, why: null, kind: "mine", rank: 0 });
  }
  if (overlays.following) {
    for (const mark of followedChartMarks(viewerEntry?.following ?? [])) add(mark);
  }
  for (const marker of detail.raise.markers) {
    const big = n(marker.commit_usd) >= 5_000;
    if ((overlays.big && big) || (overlays.thesis && marker.why)) {
      add(publicChartMark(marker, big, rankOf(marker.account?.callsign)));
    }
  }
  return out.sort((a, b) => a.t - b.t);
}
