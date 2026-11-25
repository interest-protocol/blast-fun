"use client";

import { useEffect, useEffectEvent, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { SUI_POOL_QUOTE, type PoolQuote } from "@blast/core/modules/social/portfolio/core-coins.ts";
import { indexedPoolPolling, readIndexedPool } from "./indexed-pool-query.ts";
import { atCheckpoint } from "#web/components/launchpad/blast-infra-browser.ts";
import { useChartPrice } from "#web/components/launchpad/chart/chart-live-price.ts";
import { ChartStream } from "#web/components/launchpad/chart/chart-stream.ts";
import { chartTailRequest, readChartPool } from "#web/components/launchpad/chart/chart-client.ts";
import { afterChartSourceRead, chartKey, chartRequest, initialChart, type ChartControls } from "#web/components/launchpad/chart/chart-model.ts";
import { useCoinChartControls } from "#web/components/launchpad/chart/chart-preferences.ts";
import { ChartView, PRICE_HISTORY_UNAVAILABLE } from "#web/components/launchpad/chart/ChartView.tsx";
import { useCoinPriceCurrency } from "#web/components/launchpad/chart/CoinPriceCurrency.tsx";
import { PublicError, publicErrorMessage } from "#web/lib/errors.ts";
import { useAppQueryClient } from "#web/lib/query/provider.tsx";

const REFRESH_MS = 15_000;

async function readLegacyChart(poolKey: string, controls: ChartControls, signal: AbortSignal, checkpoint: number | null) {
  // Align the read clock so viewers with the same controls share relay URLs.
  const readAt = Math.floor(Date.now() / REFRESH_MS) * REFRESH_MS;
  const read = await readIndexedPool(PRICE_HISTORY_UNAVAILABLE, signal, (market) => readChartPool(poolKey, controls, atCheckpoint(market, checkpoint), readAt));
  if (read.section.state === "unavailable") throw new PublicError(PRICE_HISTORY_UNAVAILABLE, { code: "service_unavailable" });
  return { ...read, readAt };
}

export function LegacyCoinChart({ poolKey, symbol, decimals, quote = SUI_POOL_QUOTE, initialControls }: Readonly<{
  poolKey: string; symbol: string; decimals: number; quote?: PoolQuote; initialControls: ChartControls;
}>) {
  const { controls, ready, commit } = useCoinChartControls(true, initialControls, false);
  const currency = useCoinPriceCurrency();
  const key = chartKey(controls);
  const stream = useRef<ChartStream | null>(null);
  const recoveryCheckpoint = useRef<number | null>(null);
  const [state, setState] = useState(() => initialChart(key, true));
  const latest = useChartPrice(poolKey);
  const client = useAppQueryClient();
  const queryKey = ["legacy-pool-candles", poolKey, key] as const;
  const polling = indexedPoolPolling(REFRESH_MS);
  const query = useQuery({
    queryKey,
    queryFn: ({ signal }) => readLegacyChart(poolKey, controls, signal, recoveryCheckpoint.current),
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
  useEffect(() => {
    if (!ready) return;
    const client = new ChartStream({
      pools: [poolKey], expected: null, migration: () => null,
      request: () => chartTailRequest(controls, Date.now()),
      load: (_, checkpoint) => load(checkpoint),
      pollMs: () => pollMs(), retryReadErrors: false,
      onStatus: () => {},
      onSection: (_, section) => setState((previous) =>
        afterChartSourceRead(previous.key === key ? previous : initialChart(key, true), key, "venue", section, null)),
    });
    stream.current = client;
    client.start();
    return () => {
      client.stop();
      if (stream.current === client) stream.current = null;
    };
  }, [poolKey, controls, key, ready]);

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
    updates={null}
    diagnostic={query.error ? publicErrorMessage(query.error, PRICE_HISTORY_UNAVAILABLE) : undefined}
    onControls={commit}
    onToggle={() => {}}
    onRefresh={() => void stream.current?.refresh()}
  />;
}
