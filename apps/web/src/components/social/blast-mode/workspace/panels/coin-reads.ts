import { WorkspaceDataUnavailable } from "../live-read";
import { coinMarketHistory, type MarketCoinHistory } from "./coin-market-history";
import { tradeCoinHistory, type TradeCoinHistory } from "./trade-coin-history";
import { createPresaleReads } from "./presale-reads";
import type { ProjectMetadata } from "./ProjectLinks";
import { normalizeStructTag } from "@mysten/sui/utils";
import { coreCoin } from "@blast/core/modules/social/portfolio/core-coins.ts";
import {
  HOME_DEFAULT_QUERY,
  type HomeActivity,
  type HomeCoin,
  type HomeDiscussionPage,
  type HomeThreadPage,
  type HomeTopHolders,
} from "@blast/core/web/contracts/home.ts";
import type {
  SocialPriceHistory,
  PriceWindow,
  PriceTier,
} from "@blast/core/web/contracts/prices.ts";
import { PRICE_MAX_POINTS, PRICE_TIERS } from "@blast/core/web/contracts/prices.ts";
import type { CandleInterval } from "@blast/core/modules/launchpad-contract/venue-history.ts";
import { chartRequest, type ChartRequest } from "#web/components/launchpad/chart/chart-model.ts";
import {
  fetchHomeCoins,
  fetchHomeDiscussion,
  fetchHomePage,
  fetchHomeThread,
} from "#web/components/social/coin-home/home-client.ts";
import { fetchTradeCoins } from "#web/components/social/coins/swap-client.ts";
import { fetchPrices } from "#web/components/social/prices/price-client.ts";
import type { PanelSetup } from "@blast/core/modules/social/blast-workspace/setup.ts";
import {
  readChart,
  type ChartSource,
} from "#web/components/launchpad/chart/chart-client.ts";
import type { MigratedChart } from "@blast/core/modules/launchpad-contract/venue-history.ts";
import type { MarketDataDependencies } from "@blast/core/modules/read-routing/market-data.ts";

export type CoinAsset = Pick<
  PanelSetup,
  "chain" | "network" | "coin_type" | "presale_id"
>;
export type CoinRecord = Readonly<{
  coin_type: string;
  symbol: string;
  name: string;
  decimals: number | null;
  price_usd: string | null;
  price_as_of_ms?: number | null;
  presale_id?: string | null;
  icon_url?: string | null;
  /** Blast checked who is behind the coin's sale; absent or false for every other coin. */
  verified_team?: boolean;
  change_24h_bps?: number | null;
  fdv_usd?: string | null;
  holders?: number | null;
  holders_as_of_ms?: number | null;
  /** When the list that supplied `holders` was read, when it is not this read. */
  holders_read_ms?: number | null;
  lifecycle?: string;
  /** Where a migrated sale's coin trades (`cetus`, `bluefin`), as Discover rows carry it; absent from the coin search. */
  venue?: string | null;
  /** The biggest holders Discover rows already carry; the panel never reads them separately for the header. */
  top_holders?: HomeTopHolders | null;
  /** The window's activity Discover rows already carry (buyer count, newest participants), for "who's buying". */
  activity?: HomeActivity | null;
}>;
export type NativeCoinChart = Readonly<{
  kind: "native";
  coin_type: string;
  source: ChartSource;
  chart: MigratedChart;
  request?: ChartRequest;
}>;
export type CoinHistory = SocialPriceHistory | NativeCoinChart | MarketCoinHistory | TradeCoinHistory;
export type CoinReads = Readonly<{
  links?: (asset: CoinAsset, signal: AbortSignal) => Promise<ProjectMetadata | null>;
  posts?: (asset:CoinAsset,cursor:string|null,signal:AbortSignal)=>Promise<HomeDiscussionPage|null>;
  coin: (asset: CoinAsset, signal: AbortSignal) => Promise<CoinRecord | null>;
  chart: (
    asset: CoinAsset,
    window: PriceWindow,
    signal: AbortSignal,
    interval?: CandleInterval,
  ) => Promise<CoinHistory | null>;
  holders: (
    asset: CoinAsset,
    signal: AbortSignal,
  ) => Promise<HomeTopHolders | null>;
  activity: (
    asset: CoinAsset,
    signal: AbortSignal,
  ) => Promise<HomeThreadPage | null>;
}>;

/** One loaded Discover page and when it was read: the list behind a standalone coin's market facts. */
export type ListedPage = Readonly<{ coins: readonly HomeCoin[]; window: string; read_ms: number }>;
type Listed = Readonly<{ coin: HomeCoin; read_ms: number }>;

/** The newest 24 h Discover page that lists the coin, so its volume window matches the header's label. */
function listedCoin(pages: readonly ListedPage[], asset: CoinAsset): Listed | undefined {
  for (const page of [...pages].sort((a, b) => b.read_ms - a.read_ms)) {
    if (page.window !== "24h") continue;
    const coin = page.coins.find((item) => sameCoin(item.coin_type, asset));
    if (coin) return { coin, read_ms: page.read_ms };
  }
  return undefined;
}

/**
 * The catalog's identity and live price beside only the list facts that do not move with price:
 * holders, the window's activity and the top holders, plus the time the list was read. FDV and
 * the 24 h move are priced, so they stay only when the list priced the coin exactly as the catalog
 * does now; otherwise they would sit beside a price they were not computed from. The 24 h move also
 * slides with its window, so it stays only while the list is at most `LISTED_MOVE_MAX_AGE_MS` old.
 */
function withMarket(
  coin: { readonly usd_price: string | null; readonly icon_url?: string | null } & Omit<CoinRecord, "price_usd">,
  listed: Listed | undefined,
  now: number,
): CoinRecord {
  const list = listed?.coin;
  const samePrice = list?.price_usd != null && coin.usd_price != null && Number(list.price_usd) === Number(coin.usd_price);
  const recentMove = samePrice && listed !== undefined && now - listed.read_ms <= LISTED_MOVE_MAX_AGE_MS;
  return {
    ...coin,
    icon_url: coin.icon_url ?? list?.icon_url ?? null,
    price_usd: coin.usd_price,
    price_as_of_ms: null,
    ...(listed && list && {
      lifecycle: list.lifecycle,
      venue: list.venue,
      holders: list.holders,
      holders_as_of_ms: list.holders_as_of_ms,
      holders_read_ms: listed.read_ms,
      activity: list.activity,
      top_holders: list.top_holders,
    }),
    ...(samePrice && { fdv_usd: list.fdv_usd }),
    ...(recentMove && list && { change_24h_bps: list.change_24h_bps }),
  };
}

function sameCoin(type: string, asset: CoinAsset) {
  try {
    return normalizeStructTag(type) === asset.coin_type;
  } catch {
    return false;
  }
}

/** How old a Discover read may be for its 24 h move to stand beside a live price. */
const LISTED_MOVE_MAX_AGE_MS = 120_000;

/** Existing public routes only. A bounded Discover miss is unavailable, never proof of absence. */
export function createCoinReads(
  cached: () => readonly ListedPage[] = () => [],
  now: () => number = Date.now,
): CoinReads {
  return {
    links: async (asset, signal) => (await createPresaleReads().detail(asset, signal))?.presale.metadata ?? null,
    posts: (asset,cursor,signal) => asset.network === "mainnet" && asset.presale_id ? fetchHomeDiscussion(asset.presale_id,cursor,signal) : Promise.resolve(null),
    async coin(asset, signal) {
      if (asset.network !== "mainnet") return null;
      if (asset.presale_id) {
        const page = await fetchHomeCoins([asset.presale_id], "24h", signal);
        return (
          page.coins.find((coin) => sameCoin(coin.coin_type, asset)) ?? null
        );
      }
      const known = listedCoin(cached(), asset);
      let metadataFailure: unknown;
      const metadata = await fetchTradeCoins(
        { q: asset.coin_type },
        signal,
      ).catch((error) => {
        if (signal.aborted) throw error;
        metadataFailure = error;
        return { coins: [] };
      });
      const coin = metadata.coins.find(
        (coin) => sameCoin(coin.coin_type, asset) && !coin.in_presale,
      );
      if (coin?.presale_id) {
        const page = await fetchHomeCoins([coin.presale_id], "24h", signal);
        return page.coins.find((item) => sameCoin(item.coin_type, asset)) ??
          withMarket(coin, known, now());
      }
      if (coin) return withMarket(coin, known, now());
      const page = await fetchHomePage(
        { ...HOME_DEFAULT_QUERY, sort: "newest", limit: 50 },
        null,
        signal,
      );
      const discovered = page.coins.find((coin) => sameCoin(coin.coin_type, asset));
      if (discovered) return discovered;
      if (metadataFailure) throw metadataFailure;
      if (!known) return null;
      const { coin_type, symbol, name, decimals, presale_id, verified_team } = known.coin;
      return withMarket({ coin_type, symbol, name, decimals, presale_id, verified_team, usd_price: null }, known, now());
    },
    async chart(asset, window, signal, interval) {
      if (asset.network !== "mainnet") throw new WorkspaceDataUnavailable("This network has no price history source.");
      const executions = await tradeCoinHistory(asset, window, signal, interval);
      // Quiet ranges retain the observed-price line; they cannot invent trade candles or volume.
      if (executions && (executions.page.status !== "available" || executions.page.candles.length > 0)) return executions;
      // Curated ecosystem coins are never Blast launches, so the market service has no candles for them.
      const market = coreCoin(asset.coin_type) ? null : await coinMarketHistory(asset, window, signal, interval);
      if (market) return market;
      if (window === "launch" && !asset.presale_id) throw new WorkspaceDataUnavailable("All-time coverage is unavailable for this asset.");
      const page = await fetchPrices(
        {
          ...(asset.presale_id
            ? { presales: [asset.presale_id] }
            : { coins: [asset.coin_type] }),
          window,
          points: PRICE_MAX_POINTS,
          ...(interval && PRICE_TIERS.includes(interval as PriceTier) ? { interval: interval as PriceTier } : {}),
        },
        signal,
      );
      if (!page) throw new Error("Price history could not load");
      return (
        page.prices.find((price) => sameCoin(price.coin_type, asset)) ?? null
      );
    },
    async holders(asset, signal) {
      if (asset.network !== "mainnet" || !asset.presale_id) return null;
      const page = await fetchHomeCoins([asset.presale_id], "24h", signal, 100);
      return (
        page.coins.find((coin) => sameCoin(coin.coin_type, asset))
          ?.top_holders ?? null
      );
    },
    async activity(asset, signal) {
      if (asset.network !== "mainnet" || !asset.presale_id) return null;
      const page = await fetchHomeThread(asset.presale_id, "24h", null, signal, { exactTradeUsd: true });
      return page.presale_id === asset.presale_id ? page : null;
    },
  };
}

/** A caller must already possess the canonical asset's pool binding; discovery never guesses one. */
export function nativeCoinChartReader(
  binding: Readonly<{
    asset: CoinAsset;
    source: ChartSource;
    dependencies: MarketDataDependencies;
    now: () => number;
  }>,
): (...args: Parameters<CoinReads["chart"]>) => Promise<NativeCoinChart | null> {
  return async (asset, window, signal, interval = "1m") => {
    if (
      signal.aborted ||
      asset.chain !== binding.asset.chain ||
      asset.network !== binding.asset.network ||
      !sameCoin(binding.asset.coin_type, asset)
    )
      return null;
    const controls = { interval, range: window === "launch" ? "all" as const : window };
    const now = binding.now();
    const chart = await readChart(
      binding.source,
      controls,
      binding.dependencies,
      now,
    );
    if (signal.aborted) return null;
    if (
      [chart.curve, chart.venue].some(
        (section) =>
          section &&
          (section.state === "available" || section.state === "stale") &&
          section.provenance.network !== asset.network,
      )
    )
      throw new Error("Pool provenance does not match the selected network");
    return {
      kind: "native",
      coin_type: asset.coin_type,
      source: binding.source,
      chart,
      request: chartRequest(controls, now),
    };
  };
}
