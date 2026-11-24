import { bpsPercent } from "@blast/core/lib/bps.ts";
import { ago, signPct } from "@blast/core/web/format.ts";
import { coinPagePath } from "@blast/core/modules/launchpad-coin/page-key.ts";
import type { DiscoveryResponse, DiscoveryRow } from "@blast/core/modules/launchpad-discovery/rows.ts";
import { blastV1Coin } from "@blast/core/modules/social/portfolio/core-coins.ts";
import { DISCOVERY_PRESALE_GOAL_FRACTION, discoveryFreshness, discoveryRelevance, discoveryVolume, tradingRelevance } from "@blast/core/modules/social/discovery/relevance.ts";
import { HAPPENING_LAST_HOUR_MS, type HappeningCurve, type SocialHappeningResponse } from "@blast/core/web/contracts/happening.ts";
import type { HomeCoin } from "@blast/core/web/contracts/home.ts";
import type { FeedItemPresale } from "@blast/core/web/contracts/items.ts";
import { saleLifecycleAt } from "@blast/core/web/contracts/presales.ts";

import { ALMOST_GRADUATED_BPS } from "#web/components/launchpad/discovery/discovery-model.ts";

import { pageOf } from "../bonding/bonding-client.ts";
import { shortCoinType } from "../coins/coin-display.ts";
import { presaleHref } from "../feed-ui/shell-bridge-model.ts";
import { homeCoinHref, marketVolume } from "./home-model.ts";

export type MixedDiscoveryEntry = Readonly<{
  key: string;
  coinType?: string;
  symbol: string;
  name: string;
  iconUrl: string | null;
  verified?: boolean;
  legacy?: boolean;
  href: string;
  stage: "Trading" | "Bonding" | "Graduating" | "Presale";
  figure: string | null;
  detail: string;
  change?: Readonly<{ text: string; tone: "up" | "down" | "flat" }>;
}>;

type RankedEntry = MixedDiscoveryEntry & Readonly<{ score: number; time: number; featured?: boolean }>;

function compareEntries(a: RankedEntry, b: RankedEntry): number {
  return b.score - a.score || b.time - a.time || a.key.localeCompare(b.key);
}

export function mixedDiscoveryEntries({ market, closest, fresh, happening, now }: Readonly<{
  market: readonly HomeCoin[];
  closest?: DiscoveryResponse;
  fresh?: DiscoveryResponse;
  happening: SocialHappeningResponse | null;
  now: number;
}>): readonly MixedDiscoveryEntry[] {
  const trading = market.flatMap(coin => tradingEntry(coin, now) ?? []);
  const tradingTypes = new Set(market.map(({ coin_type }) => coin_type));
  const curves = bondingEntries(closest, fresh, happening?.active_curves ?? [], tradingTypes, now);
  const sales = (happening?.recent_presales ?? []).flatMap(({ presale, last_commit_ms, backers_1h, committed_1h }) => {
    if (presale.coin_type && (tradingTypes.has(presale.coin_type) || curves.some(curve => curve.coinType === presale.coin_type))) return [];
    if (presale.end_ms <= now || last_commit_ms <= now - HAPPENING_LAST_HOUR_MS || last_commit_ms > now) return [];
    if (saleLifecycleAt(presale.lifecycle, presale.start_ms, now) !== "open") return [];
    return [presaleEntry(presale, last_commit_ms, now, backers_1h ?? 1, committed_1h)];
  }).sort((a, b) => b.time - a.time || compareEntries(a, b));

  // Preserve a place for the leading funded curve and the latest backed live sale.
  const featured = [...curves.filter(entry => entry.featured), ...sales.slice(0, 1)];
  const seen = new Set<string>();
  const selected = [...featured, ...[...trading, ...curves, ...sales].sort(compareEntries)].filter(entry => {
    if (seen.has(entry.key)) return false;
    seen.add(entry.key);
    return true;
  }).slice(0, 10).sort(compareEntries);
  // Relevance earns the presale slots. Within those slots, show the latest confirmed commitments first.
  const selectedSales = selected.filter(entry => entry.stage === "Presale").sort((a, b) => b.time - a.time || compareEntries(a, b)).values();
  return selected.map(entry => entry.stage === "Presale" ? selectedSales.next().value ?? entry : entry);
}

function presaleEntry(sale: FeedItemPresale, committedAt: number, now: number, backers: number, committed: string | undefined): RankedEntry {
  const target = BigInt(sale.raise_target);
  const funded = target > 0n ? BigInt(sale.raised) * 10_000n / target : null;
  const age = ago(committedAt, now);
  return {
    key: sale.coin_type ?? sale.presale_id,
    coinType: sale.coin_type,
    symbol: sale.symbol,
    name: sale.name,
    iconUrl: sale.icon_url,
    verified: sale.verified_team,
    href: presaleHref(sale.presale_id),
    stage: "Presale",
    figure: funded === null ? null : `${bpsPercent(funded)} funded`,
    detail: age === "now" ? "Just backed" : `Backed ${age} ago`,
    time: committedAt,
    score: discoveryRelevance({
      participants: backers,
      activity: target > 0n && committed ? Number(committed) / Number(target) / DISCOVERY_PRESALE_GOAL_FRACTION : 0,
      freshness: discoveryFreshness(committedAt, now),
      context: Number(funded ?? 0n) / 10_000,
    }),
  };
}

function tradingSignals(coin: HomeCoin) {
  const { activity, dex_volume: dexVolume } = coin;
  const dexUsd = Number(dexVolume?.usd) || 0;
  const trackedUsd = [...activity.bought, ...activity.sold].reduce((total, amount) => total + Number(amount.usd), 0);
  const tradeOnly = activity.backers === 0 && activity.claimers === 0;
  const traders = Math.max(tradeOnly ? activity.participants : 0, activity.buyers, activity.sellers);
  const lastTradeMs = tradeOnly && traders > 0 ? activity.latest_ms : null;
  return { dexUsd, volumeUsd: dexUsd || trackedUsd, traders, lastTradeMs };
}

function discoveryPriceChange(bps: number | null | undefined): MixedDiscoveryEntry["change"] {
  if (bps == null) return undefined;
  const tone = bps === 0 ? "flat" : bps > 0 ? "up" : "down";
  return { text: bps === 0 ? "0%" : signPct(bps / 100), tone };
}

function tradingEntry(coin: HomeCoin, now: number): RankedEntry | null {
  const { activity, dex_volume: dexVolume } = coin;
  if (activity.window !== "1h") return null;
  const { dexUsd, volumeUsd, traders, lastTradeMs } = tradingSignals(coin);
  const bps = coin.price_usd === null ? null : coin.mobile_market?.change_1h_bps;
  const score = tradingRelevance({ volumeUsd, traders, lastTradeMs, now, changeBps: bps });
  if (score === 0) return null;
  const figure = volumeUsd > 0 ? marketVolume({ dex_volume: dexUsd ? dexVolume : undefined, activity: { ...activity, committed: [] } }).text : null;

  const legacy = blastV1Coin(coin.coin_type);
  const volume = dexUsd ? "1h volume" : "1h tracked volume";
  const participation = `${traders} trader${traders === 1 ? "" : "s"} in 1h`;
  return {
    key: coin.coin_type,
    coinType: coin.coin_type,
    symbol: coin.symbol,
    name: legacy?.name ?? coin.name,
    iconUrl: coin.icon_url,
    verified: legacy?.verifiedTeam ?? coin.verified_team,
    legacy: Boolean(legacy),
    href: homeCoinHref(coin) ?? coinPagePath(coin.coin_type),
    stage: "Trading",
    figure,
    detail: figure === null ? participation : figure.endsWith("+") ? `${volume} · partial` : volume,
    change: discoveryPriceChange(bps),
    time: lastTradeMs ?? 0,
    score,
  };
}

type CurveCoin = Pick<DiscoveryRow, "coinType" | "name" | "symbol" | "iconUrl" | "lifecycle" | "progressBps" | "createdAtMs" | "verifiedTeam">;

function curveDetail(active: HappeningCurve | undefined, featured: boolean, nearGraduation: boolean, age: string): string {
  if (active) return `${active.participants} wallet${active.participants === 1 ? "" : "s"} in 1h`;
  if (featured) return nearGraduation ? "Closest to graduation" : "Leading curve";
  if (nearGraduation) return "Near graduation";
  return age === "now" ? "Just launched" : `Launched ${age} ago`;
}

function curveEntry(row: CurveCoin, active: HappeningCurve | undefined, featured: boolean, now: number): RankedEntry | null {
  const progressBps = row.progressBps ?? 0;
  const recentlyLaunched = row.lifecycle === "live" && progressBps > 0 && row.createdAtMs >= now - HAPPENING_LAST_HOUR_MS && row.createdAtMs <= now;
  const nearGraduation = progressBps >= ALMOST_GRADUATED_BPS;
  if (!featured && !nearGraduation && !recentlyLaunched && !active) return null;
  const symbol = row.symbol || row.name || shortCoinType(row.coinType);
  const freshness = active ? discoveryFreshness(active.last_action_ms, now) : 0.3 * discoveryFreshness(recentlyLaunched ? row.createdAtMs : null, now);
  return {
    key: row.coinType,
    coinType: row.coinType,
    symbol,
    name: row.name || symbol,
    iconUrl: row.iconUrl,
    verified: row.verifiedTeam,
    href: coinPagePath(row.coinType),
    stage: row.lifecycle === "migration_ready" ? "Graduating" : "Bonding",
    figure: row.progressBps === null ? null : `${bpsPercent(progressBps)}${nearGraduation ? "" : " of target"}`,
    detail: curveDetail(active, featured, nearGraduation, ago(row.createdAtMs, now)),
    time: active?.last_action_ms ?? row.createdAtMs,
    featured,
    score: discoveryRelevance({
      participants: active?.participants ?? 0,
      activity: discoveryVolume(Number(active?.volume_usd ?? 0)),
      freshness,
      context: progressBps / 10_000,
    }),
  };
}

function bondingEntries(closest: DiscoveryResponse | undefined, fresh: DiscoveryResponse | undefined, activeCurves: readonly HappeningCurve[], trading: ReadonlySet<string>, now: number): RankedEntry[] {
  const eligible = (row: CurveCoin) => !trading.has(row.coinType) && (row.lifecycle === "live" || row.lifecycle === "migration_ready");
  const leaders = pageOf(closest)?.rows ?? [];
  const leader = leaders.find(row => eligible(row) && (row.progressBps ?? 0) > 0);
  const live = new Map(activeCurves.filter(row => row.last_action_ms > now - HAPPENING_LAST_HOUR_MS && row.last_action_ms <= now).map(row => [row.coin_type, row]));
  const rows = new Map<string, CurveCoin>([...leaders, ...(pageOf(fresh)?.rows ?? [])].map(row => [row.coinType, row]));
  for (const curve of live.values()) {
    if (rows.has(curve.coin_type)) continue;
    rows.set(curve.coin_type, {
      coinType: curve.coin_type, symbol: curve.symbol, name: curve.name, iconUrl: curve.icon_url,
      lifecycle: "live", createdAtMs: curve.created_ms, progressBps: null, verifiedTeam: curve.verified_team ? true : undefined,
    });
  }
  return [...rows.values()].filter(eligible).flatMap(row => curveEntry(row, live.get(row.coinType), row.coinType === leader?.coinType, now) ?? []);
}
