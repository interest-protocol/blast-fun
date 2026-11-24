"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { type ChartCandlePage, type ChartControls, type SourceState, chartKey, chartRequest, initialChart } from "#web/components/launchpad/chart/chart-model.ts";
import { useCoinChartControls } from "#web/components/launchpad/chart/chart-preferences.ts";
import { ChartView } from "#web/components/launchpad/chart/ChartView.tsx";
import { chartPriceRemaining, publishChartPrice, useChartPrice } from "#web/components/launchpad/chart/chart-live-price.ts";
import { PoolCandleTradeContext } from "#web/components/launchpad/chart/chart-trade-context.ts";
import { useCoinPriceCurrency } from "#web/components/launchpad/chart/CoinPriceCurrency.tsx";
import { shiftDecimal } from "#web/components/launchpad/coin/coin-format.ts";
import { tradeCoinHistory } from "#web/components/social/blast-mode/workspace/panels/trade-coin-history.ts";
import { useAppQueryClient } from "#web/lib/query/provider.tsx";
import { browserGapTimers, hintedGap, NEW_POSTS_MIN_GAP_MS, type FreshnessHint } from "#web/components/social/home/feed-freshness.ts";
import { PRICE_WINDOW_MS } from "@blast/core/web/contracts/prices.ts";
import { candleIntervalMs } from "@blast/core/modules/launchpad-contract/venue-history.ts";
import { compareEventCursors } from "@blast/core/modules/launchpad-contract/cursor.ts";
import type { Provenance } from "@blast/core/modules/launchpad-contract/read.ts";
import { TRADE_CANDLE_LIMIT, type TradeCandlePage } from "@blast/core/web/contracts/trade-candles.ts";
import { exactText } from "@blast/core/web/exact-amount.ts";
import { presaleFreshness } from "./presale-freshness.ts";
import { overlayPoolFills, poolFill } from "./presale-live-candles.ts";
import { usePresaleMarketStream } from "./use-presale-market-stream.ts";
import type { HomeCoinMarket } from "@blast/core/web/contracts/coin-market.ts";
import type { SocialPresaleDetail } from "@blast/core/web/contracts/presales.ts";

const INITIAL_CONTROLS = { range: "24h", interval: "5m" } as const satisfies ChartControls;
const REFRESH_MS = 30_000;
const MAX_LAG_MS = 60_000;
const MAX_LIVE_FILLS = 2_048;

type PoolFills = Readonly<{
  pool: string;
  fills: readonly ReturnType<typeof poolFill>[];
  missingThrough: number;
  fence: number | null;
  delayedThrough: number;
}>;

function candleSection(page: TradeCandlePage, market: Pick<HomeCoinMarket, "quote" | "decimals">, pool: Pick<NonNullable<HomeCoinMarket["pool"]>, "id" | "venue">): SourceState {
  if (page.status === "too_many_trades") return { state: "unavailable", reason: "Choose a shorter range to view complete candle history." };
  if (page.status !== "available" || page.source !== "chain_pool_swaps" || page.pool?.id !== pool.id || page.pool.venue !== pool.venue || page.quote?.coin_type !== market.quote.type) {
    return { state: "unavailable", reason: "unavailable" };
  }
  const { quote, decimals } = market;
  const rawPrice = (price: string) => shiftDecimal(price, quote.decimals - decimals);
  const candles: ChartCandlePage["candles"][number][] = [];
  for (const candle of page.candles) {
    const volume = shiftDecimal(candle.volume, quote.decimals);
    if (volume.includes(".")) return { state: "unavailable", reason: "unavailable" };
    candles.push({
      bucketStart: candle.at_ms,
      open: rawPrice(candle.open),
      high: rawPrice(candle.high),
      low: rawPrice(candle.low),
      close: rawPrice(candle.close),
      volumeQuote: BigInt(volume),
      trades: candle.trades,
    });
  }
  const data: ChartCandlePage = {
    poolKey: `${pool.venue}:${pool.id}`, source: "venue", venue: page.pool.venue,
    interval: page.interval, migration: null, truncated: page.truncated, candles,
  };
  const provenance = {
    source: "replica" as const, network: page.network, deployment: null, checkpoint: page.as_of.checkpoint,
    timestampMs: page.as_of.timestamp_ms, observedAt: page.to_ms, lagMs: page.as_of.lag_ms,
  };
  return provenance.lagMs > MAX_LAG_MS
    ? { state: "stale", data, provenance, reason: "stale" }
    : { state: "available", data, provenance };
}

function coverage(page: TradeCandlePage | undefined) {
  if (!page?.excluded_trades) return { updates: null };
  if (!page.candles.length) return { updates: null, emptyMessage: "No swaps could be priced in this range" };
  const count = page.excluded_trades;
  return { updates: `Couldn’t price ${count} ${count === 1 ? "swap" : "swaps"} in this range.` };
}

function poolMatches(page: TradeCandlePage, poolKey: string, quote: string) {
  return page.source === "chain_pool_swaps" &&
    page.pool != null && `${page.pool.venue}:${page.pool.id}` === poolKey &&
    page.quote?.coin_type === quote;
}

/** Replace complete, bucket-aligned overlap, including the previously open candle. */
function mergeTail(previous: TradeCandlePage, tail: TradeCandlePage): TradeCandlePage | null {
  if (tail.from_ms > previous.to_ms || tail.truncated || previous.excluded_trades || tail.excluded_trades) return null;
  const width = candleIntervalMs(previous.interval);
  const start = previous.window === "launch" ? previous.from_ms : Math.max(0, tail.to_ms - PRICE_WINDOW_MS[previous.window]);
  const from = start - start % width;
  const candles = [
    ...previous.candles.filter((candle) => candle.at_ms >= from && candle.at_ms < tail.from_ms),
    ...tail.candles.filter((candle) => candle.at_ms >= from),
  ];
  return {
    ...previous,
    from_ms: from,
    to_ms: tail.to_ms,
    as_of: tail.as_of,
    prior_close: tail.prior_close,
    candles: candles.slice(-TRADE_CANDLE_LIMIT),
    truncated: candles.length > TRADE_CANDLE_LIMIT || (previous.truncated && from < (candles[0]?.at_ms ?? from)),
  };
}

function confirmedClose(poolKey: string, venue: SourceState, page: TradeCandlePage | undefined, live: PoolFills | undefined, scale: number) {
  if (venue.state !== "available" || live?.pool !== poolKey || live.fence === null || page?.status !== "available" ||
      page.as_of.checkpoint < Math.max(live.fence, live.missingThrough, live.delayedThrough) || page.excluded_trades) return undefined;
  return venue.data.candles.at(-1)?.close ?? (page.prior_close ? shiftDecimal(page.prior_close, scale) : undefined);
}

function usePublishPresaleClose(poolKey: string, close: string | undefined, provenance: Provenance | null, cursor: string | null) {
  useLayoutEffect(() => {
    const remaining = provenance ? chartPriceRemaining(provenance, MAX_LAG_MS, Date.now()) : 0;
    if (!close || !provenance || remaining <= 0) return publishChartPrice(poolKey, null);
    publishChartPrice(poolKey, { price: close, poolKey, cursor, provenance });
    const expires = setTimeout(() => publishChartPrice(poolKey, null), remaining);
    return () => clearTimeout(expires);
  }, [poolKey, close, cursor, provenance]);
  useEffect(() => () => publishChartPrice(poolKey, null), [poolKey]);
}

function presaleVenueState(section: SourceState | null, pending: boolean, error: boolean): SourceState {
  if (section?.state === "available" && error) return { ...section, state: "stale", reason: "unavailable" };
  return section ?? (pending ? { state: "loading" } : { state: "unavailable", reason: "unavailable" });
}

export function PresalePoolChart({ sale, market, pool }: Readonly<{
  sale: SocialPresaleDetail["presale"];
  market: HomeCoinMarket;
  pool: NonNullable<HomeCoinMarket["pool"]>;
}>) {
  const { controls, ready, commit } = useCoinChartControls(true, INITIAL_CONTROLS, false);
  const currency = useCoinPriceCurrency();
  const quoteUsd = currency?.quoteUsd;
  const key = chartKey(controls);
  const window = controls.range === "all" ? "launch" : controls.range === "live" ? "1h" : controls.range;
  const poolKey = `${pool.venue}:${pool.id}`;
  const client = useAppQueryClient();
  const { presale_id: presaleId, sale_token: saleToken, coin_type: coinType } = sale;
  const queryKey = useMemo(() => ["presale-pool-candles", presaleId, saleToken, poolKey, key] as const,
    [presaleId, saleToken, poolKey, key]);
  const queued = useRef<{ key: typeof queryKey; hint: FreshnessHint } | undefined>(undefined);
  const [live, setLive] = useState<PoolFills>();
  const streamFence = useRef<number | null>(null);
  const quoteType = market.quote.type;
  const { data: page, isPending, isFetching, isRefetchError, refetch } = useQuery({
    queryKey,
    async queryFn({ signal }): Promise<TradeCandlePage> {
      const target = queued.current?.key === queryKey ? queued.current : undefined;
      const previous = client.getQueryData<TradeCandlePage>(queryKey);
      const fence = streamFence.current ?? -1;
      const at = target?.hint.trade?.checkpoint ??
        (fence > (previous?.as_of.checkpoint ?? -1) ? fence : undefined);
      const asset = { chain: "sui", network: "mainnet", coin_type: saleToken, presale_id: presaleId } as const;
      const tailRead = at !== undefined && window !== "1h" && previous?.status === "available";
      const history = await tradeCoinHistory(asset, tailRead ? "1h" : window, signal, controls.interval, at);
      let next = history?.page;
      if (tailRead && next?.status === "available" && poolMatches(next, poolKey, quoteType)) {
        next = next.as_of.checkpoint < previous.as_of.checkpoint || next.to_ms < previous.to_ms
          ? previous
          : mergeTail(previous, next) ??
            (await tradeCoinHistory(asset, window, signal, controls.interval, at))?.page;
      } else if (tailRead && next?.status === "too_many_trades") {
        // A range containing the whole tail is over the same limit.
        next = { ...next, window, from_ms: previous.from_ms };
      }
      if (!next || next.status === "unavailable" || !poolMatches(next, poolKey, quoteType) || next.window !== window) {
        throw new Error("Price history couldn’t load.");
      }
      if (!signal.aborted && queued.current === target) queued.current = undefined;
      if (previous && (next.as_of.checkpoint < previous.as_of.checkpoint || next.to_ms < previous.to_ms)) return previous;
      return next;
    },
    enabled: ready,
    staleTime: (query) => (query.state.data?.as_of.checkpoint ?? -1) < (streamFence.current ?? -1) ? 0 : REFRESH_MS,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    retry: 1,
    retryDelay: NEW_POSTS_MIN_GAP_MS,
  }, client);

  usePresaleMarketStream(presaleId, (frame) => {
    if (frame.type !== "presale_pool_swap" || frame.pool_key !== poolKey) return;
    const fill = poolFill(frame);
    const lagMs = Math.max(0, Date.now() - fill.time);
    const delayed = lagMs >= MAX_LAG_MS && fill.checkpoint > (client.getQueryData<TradeCandlePage>(queryKey)?.as_of.checkpoint ?? -1);
    if (delayed) publishChartPrice(poolKey, null);
    setLive((previous) => {
      const same = previous?.pool === poolKey ? previous : undefined;
      const known = same?.fills ?? [];
      const at = known.findLastIndex((seen) => compareEventCursors(seen.cursor, fill.cursor) <= 0);
      if (known[at]?.cursor === fill.cursor) return previous;
      // Every range uses the same recent fills and subtracts its own history checkpoint.
      const fills = [...known.slice(0, at + 1), fill, ...known.slice(at + 1)];
      const expired = fills.length > MAX_LIVE_FILLS ? fills.shift() : undefined;
      return {
        pool: poolKey,
        fills,
        fence: same?.fence ?? streamFence.current,
        missingThrough: Math.max(expired?.checkpoint ?? -1, same?.missingThrough ?? -1),
        delayedThrough: Math.max(delayed ? fill.checkpoint : -1, same?.delayedThrough ?? -1),
      };
    });
  }, (checkpoint) => {
    streamFence.current = checkpoint;
    if (checkpoint === null) {
      setLive((previous) => previous?.pool === poolKey ? { ...previous, fence: null } : previous);
      publishChartPrice(poolKey, null);
      return;
    }
    setLive((previous) => ({
      pool: poolKey,
      fills: previous?.pool === poolKey ? previous.fills : [],
      missingThrough: previous?.pool === poolKey ? previous.missingThrough : -1,
      fence: checkpoint,
      delayedThrough: previous?.pool === poolKey ? previous.delayedThrough : -1,
    }));
    if (!ready || (client.getQueryData<TradeCandlePage>(queryKey)?.as_of.checkpoint ?? -1) >= checkpoint) return;
    const query = { queryKey, exact: true, type: "active" } as const;
    const joined = client.getQueryState(queryKey)?.fetchStatus === "fetching";
    void client.refetchQueries(query, { cancelRefetch: false }).then(() => {
      if (!joined || streamFence.current !== checkpoint) return;
      const covered = client.getQueryData<TradeCandlePage>(queryKey)?.as_of.checkpoint ?? -1;
      if (covered < checkpoint) void client.refetchQueries(query, { cancelRefetch: false });
    });
  });

  useEffect(() => {
    if (!ready) return;
    let active = true;
    const gap = hintedGap(NEW_POSTS_MIN_GAP_MS, browserGapTimers(), refresh);
    function refresh(hint?: FreshnessHint) {
      if (!active || document.hidden) return;
      if (hint?.trade && streamFence.current !== null) return;
      const checkpoint = hint?.trade?.checkpoint;
      const current = client.getQueryData<TradeCandlePage>(queryKey);
      const pending = queued.current?.key === queryKey ? queued.current : undefined;
      const painted = current?.as_of.checkpoint ?? -1;
      if (hint && checkpoint !== undefined && checkpoint > Math.max(painted, pending?.hint.trade?.checkpoint ?? -1)) {
        queued.current = { key: queryKey, hint };
      }
      if (checkpoint !== undefined && (queued.current?.key !== queryKey || (queued.current.hint.trade?.checkpoint ?? -1) <= painted)) {
        if (queued.current?.key === queryKey) queued.current = undefined;
        return;
      }
      const target = queued.current?.key === queryKey ? queued.current : undefined;
      if (!gap.admit(target?.hint ?? hint)) return;
      const joined = client.getQueryState(queryKey)?.fetchStatus === "fetching";
      void refetch({ cancelRefetch: false }).then(() => {
        if (!active) return;
        const missed = queued.current;
        if (missed?.key !== queryKey) return;
        if (joined || missed !== target) refresh(missed.hint);
        // A failed read still owes this checkpoint on the next fallback.
      });
    }
    gap.admit();
    const off = presaleFreshness("presale-candles", REFRESH_MS, presaleId, coinType).subscribe(refresh);
    return () => {
      active = false;
      if (queued.current?.key === queryKey) queued.current = undefined;
      off();
      gap.cancel();
    };
  }, [client, coinType, presaleId, queryKey, ready, refetch]);

  const { quote, decimals } = market;
  const { id, venue: dex } = pool;
  const unseen = useMemo(() => {
    if (!page || page.status !== "available" || live?.pool !== poolKey || live.missingThrough > page.as_of.checkpoint) return [];
    if (live.fence !== null && page.as_of.checkpoint < live.fence) return [];
    return live.fills.filter((fill) => fill.checkpoint > page.as_of.checkpoint);
  }, [page, live, poolKey]);
  const latest = unseen.at(-1);
  const section = useMemo(() => {
    if (!page) return null;
    const section = candleSection(page, { quote, decimals }, { id, venue: dex });
    if (!("data" in section) || !latest) return section;
    return {
      ...section,
      provenance: { ...section.provenance, checkpoint: latest.checkpoint, timestampMs: latest.time },
      data: overlayPoolFills(section.data, page, unseen),
    };
  }, [page, quote, decimals, id, dex, latest, unseen]);
  const width = candleIntervalMs(controls.interval);
  const poolTrade = useMemo(() => latest ? {
    poolKey,
    bucketStart: latest.time - latest.time % width,
    receivedAt: latest.receivedAt,
    trade: { cursor: latest.cursor, timestampMs: latest.time, side: latest.side, price: exactText(latest.price), memeAmount: latest.amount },
  } : null, [latest, poolKey, width]);
  const venue = presaleVenueState(section, isPending, isRefetchError);
  const close = confirmedClose(poolKey, venue, page, live, quote.decimals - decimals);
  const currentPrice = useChartPrice(poolKey, market.as_of.checkpoint);
  usePublishPresaleClose(poolKey, close, venue.state === "available" ? venue.provenance : null, latest?.cursor ?? null);
  const diagnostic = venue.state === "unavailable" && venue.reason !== "unavailable" ? venue.reason : undefined;
  return <PoolCandleTradeContext value={poolTrade}><ChartView
    compact
    source={{ curvePoolKey: null, venuePoolKey: poolKey, migration: null, expected: null, symbol: sale.symbol, memeDecimals: market.decimals, quoteDecimals: market.quote.decimals, quoteSymbol: market.quote.symbol }}
    state={{ ...initialChart(key, true), venue }}
    controls={controls}
    currentPrice={currentPrice?.price ?? null}
    request={page ? { interval: page.interval, from: window === "launch" ? undefined : page.from_ms, capped: page.truncated } : chartRequest(controls, 0)}
    quoteUsd={quoteUsd}
    hidden={[]}
    pending={isFetching}
    {...coverage(page)}
    diagnostic={diagnostic}
    onControls={commit}
    onToggle={() => {}}
    onRefresh={() => void refetch({ cancelRefetch: false })}
  /></PoolCandleTradeContext>;
}
