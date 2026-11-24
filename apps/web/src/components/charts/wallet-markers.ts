import type { ChartCandlePage } from "#web/components/launchpad/chart/chart-model.ts";
import { candleBucketStart } from "@blast/core/modules/launchpad-contract/venue-history.ts";
import { chartTimestamp } from "./tradingview-model.ts";
import { WALLET_LABELS, type WalletLabel } from "#web/components/launchpad/activity/wallet-labels.ts";

const orderedLabels = Object.keys(WALLET_LABELS) as WalletLabel[];
type Counts = { trades: number; labels: Map<WalletLabel, number>; wallets: Map<string, number> };

const emptyCounts = (): Counts => ({ trades: 0, labels: new Map(), wallets: new Map() });

function rememberWallet(wallets: Map<string, number>, address: string, timestampMs: number) {
  wallets.set(address, Math.max(wallets.get(address) ?? timestampMs, timestampMs));
}

export type WalletChartTrade = Readonly<{
  cursor: string;
  address: string;
  timestampMs: number;
  poolKey: string;
  side: "buy" | "sell";
  labels: readonly WalletLabel[];
}>;

export type WalletRipple = Readonly<{ cursor: string; receivedAt: number; markerKey: string }>;

export function walletMarkerKey(poolKey: string, side: WalletChartTrade["side"], bucket: number) {
  return `${poolKey}:${side}:${bucket}`;
}

/** Only trades with an actual candle in this source can place a marker. */
export function walletMarkers(
  trades: readonly WalletChartTrade[],
  page: ChartCandlePage,
  pointAt: (bucket: number) => number,
) {
  const byTime = new Map<number, { buy: Counts; sell: Counts }>();
  const buckets = new Map(page.candles.map(candle => [candle.bucketStart, candle]));
  for (const trade of trades) {
    if (trade.poolKey !== page.poolKey || !trade.labels.length) continue;
    const bucket = candleBucketStart(page.interval, trade.timestampMs);
    if (!buckets.has(bucket)) continue;
    const group = byTime.get(bucket) ?? { buy: emptyCounts(), sell: emptyCounts() };
    const counts = group[trade.side];
    counts.trades++;
    rememberWallet(counts.wallets, trade.address, trade.timestampMs);
    for (const label of trade.labels) counts.labels.set(label, (counts.labels.get(label) ?? 0) + 1);
    byTime.set(bucket, group);
  }
  return [...byTime].sort(([a], [b]) => a - b).flatMap(([bucket, group]) =>
    (["buy", "sell"] as const).flatMap((side) => {
      const { trades: count, labels: counts, wallets } = group[side];
      if (!counts.size) return [];
      const labels = orderedLabels.filter((key) => counts.has(key));
      const description = labels.map((key) => {
        const count = counts.get(key)!;
        return `${count} ${WALLET_LABELS[key].name} ${side}${count === 1 ? "" : "s"}`;
      }).join(", ");
      return [{
        key: walletMarkerKey(page.poolKey, side, bucket),
        time: chartTimestamp(pointAt(bucket)), side, count, labels, wallets, candle: buckets.get(bucket)!,
        description: `${new Date(bucket).toISOString()} · ${page.source === "curve" ? "Bonding curve" : page.venue} · ${description}`,
      }];
    })
  );
}

type WalletMarker = ReturnType<typeof walletMarkers>[number];
export type PlottedWalletMarker = WalletMarker & { seriesIndex: number; price: number };
type Point = { x: number; y: number };
type Group = { side: "buy" | "sell"; slot: number; count: number; labels: Set<WalletLabel>; points: (Point & { key: string })[]; details: string[]; wallets: Map<string, number> };

const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value));

/** Badges share a column only across sides. Their dots stay on the actual price series. */
export function walletMarkerBadges<T extends WalletMarker>(
  markers: readonly T[], width: number, height: number, rem: number,
  coordinate: (marker: T) => Point | null,
  touch = false,
) {
  const badgeHeight = touch ? Math.max(44, 2.75 * rem) : Math.max(24, 1.5 * rem);
  const slots = Math.max(1, Math.floor(width / Math.max(6.5 * rem, badgeHeight + 2)));
  const slotWidth = width / slots;
  const gap = .375 * rem;
  const groups = new Map<string, Group>();
  if (height < 2 * badgeHeight + gap || width < Math.max(6 * rem, badgeHeight + 2)) return [];
  for (const mark of markers) {
    const point = coordinate(mark);
    if (!point || point.x < 0 || point.x >= width || point.y < 0 || point.y >= height) continue;
    const slot = Math.floor(point.x / slotWidth);
    const key = mark.side + slot;
    const group: Group = groups.get(key) ?? { side: mark.side, slot, count: 0, labels: new Set(), points: [], details: [], wallets: new Map() };
    group.count += mark.count;
    mark.labels.forEach(label => group.labels.add(label));
    group.points.push({ ...point, key: mark.key });
    group.details.push(mark.description);
    mark.wallets.forEach((timestampMs, address) => rememberWallet(group.wallets, address, timestampMs));
    groups.set(key, group);
  }
  const badges = [...groups.values()].map(group => {
    // Anchor buys below the lowest marked wick and sells above the highest.
    const anchor = group.points.reduce((best, point) => (group.side === "buy" ? point.y > best.y : point.y < best.y) ? point : best);
    const labels = orderedLabels.filter(label => group.labels.has(label));
    const glyphWidth = (1.5 + labels.length * 1.25 + (group.count > 1 ? 2.5 : 0)) * .75 * rem;
    const badgeWidth = Math.max(badgeHeight, glyphWidth);
    const left = clamp(anchor.x - badgeWidth / 2, group.slot * slotWidth + 1, (group.slot + 1) * slotWidth - badgeWidth - 1);
    const below = anchor.y + gap, above = anchor.y - gap - badgeHeight;
    const preferBelow = group.side === "buy" ? below + badgeHeight <= height : above < 0;
    const top = clamp(preferBelow ? below : above, 0, height - badgeHeight);
    return { ...group, labels, left, top, badgeWidth, badgeHeight, anchor };
  });
  const buys = new Map(badges.filter(badge => badge.side === "buy").map(badge => [badge.slot, badge]));
  for (const sell of badges) {
    const buy = buys.get(sell.slot);
    if (sell.side !== "sell" || !buy || Math.abs(buy.top - sell.top) >= badgeHeight + 2) continue;
    const lower = Math.max(sell.anchor.y, buy.anchor.y);
    const upper = Math.min(sell.anchor.y, buy.anchor.y);
    if (upper < badgeHeight + gap && lower + gap + 2 * badgeHeight + 2 <= height) {
      sell.top = lower + gap;
      buy.top = sell.top + badgeHeight + 2;
    } else if (lower + badgeHeight + gap > height && upper - gap >= 2 * badgeHeight + 2) {
      buy.top = upper - gap - badgeHeight;
      sell.top = buy.top - badgeHeight - 2;
    } else {
      const split = clamp((upper + lower) / 2, badgeHeight + 1, height - badgeHeight - 1);
      sell.top = split - badgeHeight - 1;
      buy.top = split + 1;
    }
  }
  return badges;
}
