"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useQuoteUsd } from "#web/components/social/prices/use-quote-usd.ts";

import { browserMarketDependencies } from "../blast-infra-browser";
import { readChartPool, type ChartSource } from "./chart-client";
import { afterChartSourceRead, chartKey, chartRequest, initialChart, type ChartControls } from "./chart-model";
import { useCoinPriceCurrency } from "./CoinPriceCurrency";
import { ChartStream, type ChartStreamStatus } from "./chart-stream";
import { useCoinChartControls } from "./chart-preferences";
import { ChartView, type ChartSourceName } from "./ChartView";
import { MIGRATOR_POOL_KEY } from "@blast/core/modules/launchpad-contract/venues.ts";

/** HTTP history plus the tab's bounded same-origin market stream. */
export function CoinChart({
  source,
  compact,
  coinType,
  initialControls,
  livePreset,
}: Readonly<{ source: ChartSource; compact?: boolean; coinType: string; initialControls: ChartControls; livePreset: boolean }>) {
  const currency = useCoinPriceCurrency();
  const standaloneRate = useQuoteUsd(currency ? null : source.quoteType ?? null);
  const quoteUsd = currency ? currency.quoteUsd : standaloneRate;
  const { controls, ready, commit } = useCoinChartControls(compact, initialControls, true, livePreset);
  const [state, setState] = useState(() =>
    initialChart(chartKey(initialControls), (source.venuePoolKey ?? source.migration?.venuePoolKey ?? null) !== null, source.migration),
  );
  const [hidden, setHidden] = useState<readonly ChartSourceName[]>([]);
  const [pending, setPending] = useState(false);
  const network = source.expected?.network ?? null;
  const deployment = source.expected?.deployment ?? null;
  const dependencies = useMemo(
    () => browserMarketDependencies(network && deployment ? { network, deployment } : null),
    [network, deployment],
  );
  const stream = useRef<ChartStream | null>(null);
  const [streamStatus, setStreamStatus] = useState<ChartStreamStatus>("connecting");
  const known = useRef(state.migration);
  const [requestAt, setRequestAt] = useState<number | null>(null);
  const venuePoolKey = source.venuePoolKey ?? state.migration?.venuePoolKey ?? null;
  const curvePoolKey = source.curvePoolKey;
  const migrationCursor = source.migration?.cursor ?? null;
  const migrationTimestamp = source.migration?.timestampMs ?? null;
  const migrationCurve = source.migration?.curvePoolKey ?? null;
  const migrationVenue = source.migration?.venuePoolKey ?? null;
  const committed = useMemo(() => migrationCursor !== null && migrationTimestamp !== null && migrationCurve !== null
    ? { cursor: migrationCursor, timestampMs: migrationTimestamp, curvePoolKey: migrationCurve, venuePoolKey: migrationVenue }
    : null, [migrationCursor, migrationTimestamp, migrationCurve, migrationVenue]);

  useEffect(() => {
    if (!ready) return;
    const key = chartKey(controls);
    const pools = [curvePoolKey, ...(venuePoolKey && MIGRATOR_POOL_KEY.test(venuePoolKey) ? [venuePoolKey] : [])];
    // The tab's market stream hub keeps the connection through short hides and closes it after longer ones.
    const client = new ChartStream({
      pools,
      coin: coinType,
      expected: network && deployment ? { network, deployment } : null,
      migration: () => committed ?? known.current,
      request: () => chartRequest(controls, Date.now()),
      load: (pool) => readChartPool(pool, controls, dependencies, Date.now()),
      onSection: (pool, section, migration) => {
        if (stream.current !== client) return;
        const marker = committed ?? migration ?? known.current;
        known.current = marker;
        const name = pool === curvePoolKey ? "curve" : "venue";
        setState((shown) => {
          const current = shown.key === key ? shown : initialChart(key, venuePoolKey !== null, marker);
          return afterChartSourceRead(current, key, name, section, marker);
        });
        setRequestAt(Date.now());
      },
      onStatus: setStreamStatus,
    });
    stream.current = client;
    client.start();
    return () => {
      client.stop();
      if (stream.current === client) stream.current = null;
    };
  }, [coinType, controls, curvePoolKey, venuePoolKey, committed, dependencies, network, deployment, ready]);

  const refresh = () => {
    setPending(true);
    return (stream.current?.refresh() ?? Promise.resolve()).finally(() => setPending(false));
  };

  const updates = chartUpdateText(streamStatus);
  const key = chartKey(controls);
  const shown = state.key === key ? state : initialChart(key, venuePoolKey !== null, committed ?? state.migration);

  const change = (choice: ChartControls) => {
    stream.current?.stop();
    const next = commit(choice);
    // Candles read for other controls are never shown under these: the chart starts over.
    setState((shown) => initialChart(chartKey(next), shown.venue !== null, shown.migration));
  };

  return (
    <ChartView
      compact={compact}
      state={shown}
      source={source}
      quoteUsd={quoteUsd}
      controls={controls}
      request={chartRequest(controls, requestAt ?? 0)}
      hidden={hidden}
      pending={pending}
      updates={updates}
      livePreset={livePreset}
      onControls={change}
      onToggle={(name, shown) => setHidden((current) => (shown ? current.filter((item) => item !== name) : [...current, name]))}
      onRefresh={() => void refresh()}
    />
  );
}

const STREAM_TEXT: Readonly<Record<ChartStreamStatus, string | null>> = {
  streaming: null,
  paused: null,
  recovering: "Updating price history…",
  reconnecting: "Trade updates delayed.",
  unavailable: "Trade updates delayed.",
  connecting: "Connecting price updates…",
};

function chartUpdateText(status: ChartStreamStatus): string | null {
  return STREAM_TEXT[status];
}
