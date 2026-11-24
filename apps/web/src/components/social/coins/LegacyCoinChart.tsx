"use client";

import { useQuery } from "@tanstack/react-query";
import { indexedPoolPolling, readIndexedPool } from "./indexed-pool-query.ts";
import { readChartPool } from "#web/components/launchpad/chart/chart-client.ts";
import { chartKey, chartRequest, initialChart, type ChartControls, type SourceState } from "#web/components/launchpad/chart/chart-model.ts";
import { useCoinChartControls } from "#web/components/launchpad/chart/chart-preferences.ts";
import { ChartView, PRICE_HISTORY_UNAVAILABLE } from "#web/components/launchpad/chart/ChartView.tsx";
import { useCoinPriceCurrency } from "#web/components/launchpad/chart/CoinPriceCurrency.tsx";
import { PublicError, publicErrorMessage } from "#web/lib/errors.ts";
import { useAppQueryClient } from "#web/lib/query/provider.tsx";

const REFRESH_MS = 60_000;

async function readLegacyChart(poolKey: string, controls: ChartControls, signal: AbortSignal) {
  // Align the read clock so viewers with the same controls share relay URLs.
  const readAt = Math.floor(Date.now() / REFRESH_MS) * REFRESH_MS;
  const { section } = await readIndexedPool(PRICE_HISTORY_UNAVAILABLE, signal, (market) => readChartPool(poolKey, controls, market, readAt));
  if (section.state === "unavailable") throw new PublicError(PRICE_HISTORY_UNAVAILABLE, { code: "service_unavailable" });
  return { section, readAt };
}

export function LegacyCoinChart({ poolKey, symbol, decimals, initialControls }: Readonly<{
  poolKey: string; symbol: string; decimals: number; initialControls: ChartControls;
}>) {
  const { controls, ready, commit } = useCoinChartControls(true, initialControls, false);
  const currency = useCoinPriceCurrency();
  const key = chartKey(controls);
  const query = useQuery({
    queryKey: ["legacy-pool-candles", poolKey, key],
    queryFn: ({ signal }) => readLegacyChart(poolKey, controls, signal),
    enabled: ready,
    ...indexedPoolPolling(REFRESH_MS),
  }, useAppQueryClient());
  const last = query.data?.section;
  const venue: SourceState = query.isError
    ? last?.state === "available" || last?.state === "stale"
      ? { ...last, state: "stale", reason: "unavailable" }
      : { state: "unavailable", reason: "unavailable" }
    : last ?? { state: "loading" };

  return <ChartView
    compact
    source={{ curvePoolKey: null, venuePoolKey: poolKey, migration: null, expected: null, symbol, memeDecimals: decimals, quoteDecimals: 9, quoteSymbol: "SUI" }}
    state={{ ...initialChart(key, true), venue }}
    controls={controls}
    request={chartRequest(controls, query.data?.readAt ?? 0)}
    quoteUsd={currency?.quoteUsd}
    hidden={[]}
    pending={query.isFetching}
    updates={null}
    diagnostic={query.error ? publicErrorMessage(query.error, PRICE_HISTORY_UNAVAILABLE) : undefined}
    onControls={commit}
    onToggle={() => {}}
    onRefresh={() => void query.refetch()}
  />;
}
