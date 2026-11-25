"use client";

import { useEffect, useEffectEvent, useRef, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { SUI_POOL_QUOTE } from "@blast/core/modules/social/portfolio/core-coins.ts";
import { indexedPoolPolling, readIndexedPool } from "./indexed-pool-query.ts";
import { atCheckpoint } from "#web/components/launchpad/blast-infra-browser.ts";
import { useChartPrice, type ChartPriceUpdate } from "#web/components/launchpad/chart/chart-live-price.ts";
import { ChartStream, type ChartStreamStatus } from "#web/components/launchpad/chart/chart-stream.ts";
import { chartTailRequest, readChartPool } from "#web/components/launchpad/chart/chart-client.ts";
import { afterChartSourceRead, chartKey, chartRequest, initialChart, type ChartControls } from "#web/components/launchpad/chart/chart-model.ts";
import { useCoinChartControls } from "#web/components/launchpad/chart/chart-preferences.ts";
import { ChartView, PRICE_HISTORY_UNAVAILABLE } from "#web/components/launchpad/chart/ChartView.tsx";
import { useCoinPriceCurrency } from "#web/components/launchpad/chart/CoinPriceCurrency.tsx";
import { PublicError, publicErrorMessage } from "#web/lib/errors.ts";
import { useAppQueryClient } from "#web/lib/query/provider.tsx";

const REFRESH_MS = 15_000;

async function readPoolChart(poolKey: string, controls: ChartControls, signal: AbortSignal, checkpoint: number | null) {
  // Align the read clock so viewers with the same controls share relay URLs.
  const readAt = Math.floor(Date.now() / REFRESH_MS) * REFRESH_MS;
  const read = await readIndexedPool(PRICE_HISTORY_UNAVAILABLE, signal, (market) => readChartPool(poolKey, controls, atCheckpoint(market, checkpoint), readAt));
  if (read.section.state === "unavailable") throw new PublicError(PRICE_HISTORY_UNAVAILABLE, { code: "service_unavailable" });
  return { ...read, readAt };
}

/** What the chart says about its stream. A chart that streams nothing stays silent. */
const STREAM_TEXT: Readonly<Partial<Record<ChartStreamStatus, string>>> = {
  recovering: "Updating price history…",
  reconnecting: "Trade updates delayed.",
  unavailable: "Trade updates delayed.",
};

/**
 * One venue pool's candles: HTTP history from the pool-keyed market read, then the tab's market stream.
 * `live` is a pool the tab's market stream serves; its stream status is shown.
 */
export function PoolChart({ poolKey, coinType, symbol, decimals, quote = SUI_POOL_QUOTE, initialControls, live = false, price, uncovered }: Readonly<{
  poolKey: string; coinType?: string; symbol: string; decimals: number;
  quote?: Readonly<{ symbol: string; decimals: number }>;
  initialControls: ChartControls;
  live?: boolean;
  /** The current price the page shows beside the chart, held to the page's own rule; the chart's own price when absent. */
  price?: ChartPriceUpdate | null;
  /** Shown instead while the market read does not know this pool. */
  uncovered?: ReactNode;
}>) {
  const { controls, ready, commit } = useCoinChartControls(true, initialControls, false);
  const currency = useCoinPriceCurrency();
  const key = chartKey(controls);
  const stream = useRef<ChartStream | null>(null);
  const recoveryCheckpoint = useRef<number | null>(null);
  const [state, setState] = useState(() => initialChart(key, true));
  const own = useChartPrice(poolKey);
  const latest = price === undefined ? own : price;
  const [status, setStatus] = useState<ChartStreamStatus>("connecting");
  const client = useAppQueryClient();
  const queryKey = ["pool-candles", poolKey, key] as const;
  const polling = indexedPoolPolling(REFRESH_MS);
  const query = useQuery({
    queryKey,
    queryFn: ({ signal }) => readPoolChart(poolKey, controls, signal, recoveryCheckpoint.current),
    ...polling,
    enabled: false,
  }, client);
  const load = useEffectEvent(async (checkpoint: number | null) => {
    recoveryCheckpoint.current = checkpoint;
    const result = await query.refetch({ cancelRefetch: false });
    if (result.error) throw result.error;
    if (!result.data) throw new PublicError(PRICE_HISTORY_UNAVAILABLE, { code: "service_unavailable" });
    return result.data;
  });
  const pollMs = useEffectEvent(() => {
    const state = client.getQueryState(queryKey);
    if (!state) return REFRESH_MS;
    const delay = polling.refetchInterval({ state });
    if (delay === false) return false;
    if (document.hidden) return delay;
    return Math.max(0, Math.max(state.dataUpdatedAt, state.errorUpdatedAt) + delay - Date.now());
  });
  const unknown = uncovered !== undefined && query.error instanceof PublicError && query.error.httpStatus === 404;
  useEffect(() => {
    if (!ready || unknown) return;
    const client = new ChartStream({
      pools: [poolKey], ...(coinType ? { coin: coinType } : {}), expected: null, migration: () => null,
      request: () => chartTailRequest(controls, Date.now()),
      load: (_, checkpoint) => load(checkpoint),
      pollMs: () => pollMs(), retryReadErrors: false,
      onStatus: (next) => { if (live && stream.current === client) setStatus(next); },
      onSection: (_, section) => setState((previous) =>
        afterChartSourceRead(previous.key === key ? previous : initialChart(key, true), key, "venue", section, null)),
    });
    stream.current = client;
    client.start();
    return () => {
      if (stream.current === client) stream.current = null;
      client.stop();
    };
  }, [poolKey, coinType, controls, key, ready, live, unknown]);

  if (unknown) return uncovered;
  return <ChartView
    compact
    source={{ curvePoolKey: null, venuePoolKey: poolKey, migration: null, expected: null, symbol, memeDecimals: decimals, quoteDecimals: quote.decimals, quoteSymbol: quote.symbol }}
    state={state.key === key ? state : initialChart(key, true)}
    currentPrice={latest?.price ?? null}
    controls={controls}
    request={chartRequest(controls, query.data?.readAt ?? 0)}
    quoteUsd={currency?.quoteUsd}
    hidden={[]}
    pending={query.isFetching}
    updates={live ? STREAM_TEXT[status] ?? null : null}
    diagnostic={query.error ? publicErrorMessage(query.error, PRICE_HISTORY_UNAVAILABLE) : undefined}
    onControls={commit}
    onToggle={() => {}}
    onRefresh={() => void stream.current?.refresh()}
  />;
}
