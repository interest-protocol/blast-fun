import { bpsPercent } from "@blast/core/lib/bps.ts";
import { ago, signPct } from "@blast/core/web/format.ts";
import { coinPagePath } from "@blast/core/modules/launchpad-coin/page-key.ts";
import type { DiscoveryResponse, DiscoveryRow } from "@blast/core/modules/launchpad-discovery/rows.ts";
import { blastV1Coin } from "@blast/core/modules/social/portfolio/core-coins.ts";
import { HAPPENING_LAST_HOUR_MS, type SocialHappeningResponse } from "@blast/core/web/contracts/happening.ts";
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

export function mixedDiscoveryEntries({ market, closest, fresh, happening, now }: Readonly<{
  market: readonly HomeCoin[];
  closest?: DiscoveryResponse;
  fresh?: DiscoveryResponse;
  happening: SocialHappeningResponse | null;
  now: number;
}>): readonly MixedDiscoveryEntry[] {
  const trading = market.map(tradingEntry).filter(entry => entry !== null);
  const tradingTypes = new Set(market.map(({ coin_type }) => coin_type));
  const curves = bondingEntries(closest, fresh, tradingTypes, now);
  const sales = (happening?.recent_presales ?? []).flatMap(({ presale, last_commit_ms }) => {
    if (presale.coin_type && tradingTypes.has(presale.coin_type)) return [];
    if (presale.end_ms <= now || last_commit_ms < now - HAPPENING_LAST_HOUR_MS) return [];
    if (saleLifecycleAt(presale.lifecycle, presale.start_ms, now) !== "open") return [];
    return [presaleEntry(presale, last_commit_ms, now)];
  });

  const first = [trading[0], curves[0], sales[0], trading[1], curves[1], sales[1]];
  const seen = new Set<string>();
  return [...first, ...trading, ...curves, ...sales].filter((entry): entry is MixedDiscoveryEntry => {
    if (!entry || seen.has(entry.key)) return false;
    seen.add(entry.key);
    return true;
  }).slice(0, 10);
}

function presaleEntry(sale: FeedItemPresale, committedAt: number, now: number): MixedDiscoveryEntry {
  const target = BigInt(sale.raise_target);
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
    figure: target > 0n ? `${bpsPercent(BigInt(sale.raised) * 10_000n / target)} funded` : null,
    detail: age === "now" ? "Just backed" : `Backed ${age} ago`,
  };
}

function tradingVolume(coin: HomeCoin): string | null {
  const { activity, dex_volume: dexVolume } = coin;
  if (activity.window !== "1h") return null;
  if (dexVolume) return Number(dexVolume.usd) > 0 ? marketVolume(coin).text : null;
  const hasTrade = [...activity.bought, ...activity.sold].some(amount => Number(amount.usd) > 0);
  return hasTrade ? marketVolume({ ...coin, activity: { ...activity, committed: [] } }).text : null;
}

function tradingEntry(coin: HomeCoin): MixedDiscoveryEntry | null {
  const figure = tradingVolume(coin);
  const bps = coin.price_usd === null ? null : coin.mobile_market?.change_1h_bps;
  if (!figure && !bps) return null;

  const legacy = blastV1Coin(coin.coin_type);
  const volume = coin.dex_volume ? "1h volume" : "1h tracked volume";
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
    detail: figure === null ? "" : figure.endsWith("+") ? `${volume} · partial` : volume,
    change: bps == null ? undefined : { text: bps === 0 ? "0%" : signPct(bps / 100), tone: bps > 0 ? "up" : bps < 0 ? "down" : "flat" },
  };
}

function bondingEntries(closest: DiscoveryResponse | undefined, fresh: DiscoveryResponse | undefined, trading: ReadonlySet<string>, now: number): MixedDiscoveryEntry[] {
  const eligible = (row: DiscoveryRow) => !trading.has(row.coinType) && (row.lifecycle === "live" || row.lifecycle === "migration_ready");
  const near = (pageOf(closest)?.rows ?? []).filter(row => eligible(row) && (row.progressBps ?? 0) >= ALMOST_GRADUATED_BPS);
  const leader = near[0];
  const rising = (pageOf(fresh)?.rows ?? [])
    .filter(row => eligible(row) && row.coinType !== leader?.coinType && row.lifecycle === "live"
      && row.createdAtMs >= now - HAPPENING_LAST_HOUR_MS && row.createdAtMs <= now && (row.progressBps ?? 0) > 0)
    .sort((a, b) => (b.progressBps ?? 0) - (a.progressBps ?? 0) || b.createdAtMs - a.createdAtMs);
  const recentRows = new Set(rising);
  return [leader, rising[0], ...near.slice(1), ...rising.slice(1)].flatMap((row): MixedDiscoveryEntry[] => {
    if (!row) return [];
    const symbol = row.symbol || row.name || shortCoinType(row.coinType);
    const age = ago(row.createdAtMs, now);
    const progress = bpsPercent(row.progressBps ?? 0);
    const recentlyLaunched = recentRows.has(row);
    const detail = row === leader
      ? "Closest to graduation"
      : recentlyLaunched ? age === "now" ? "Just launched" : `Launched ${age} ago` : "Near graduation";
    return [{
      key: row.coinType,
      coinType: row.coinType,
      symbol,
      name: row.name || symbol,
      iconUrl: row.iconUrl,
      verified: row.verifiedTeam,
      href: coinPagePath(row.coinType),
      stage: row.lifecycle === "migration_ready" ? "Graduating" : "Bonding",
      figure: recentlyLaunched ? `${progress} of target` : progress,
      detail,
    }];
  });
}
