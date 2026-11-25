"use client";

import { useEffect, useEffectEvent, useMemo, useRef, useState } from "react";
import { useQuoteUsd } from "#web/components/social/prices/use-quote-usd.ts";

import { atCheckpoint, browserMarketDependencies } from "../blast-infra-browser";
import { chartFromSnapshot, chartPoolKeys, chartTailRequest, readChartPool, type ChartSnapshot, type ChartSource } from "./chart-client";
import { afterChartSourceRead, chartKey, denseInterval, tradedBuckets, chartRequest, initialChart, type ChartCandlePage, type ChartControls } from "./chart-model";
import type { Section } from "@blast/core/modules/launchpad-contract/section.ts";
import { useCoinPriceCurrency } from "./CoinPriceCurrency";
import { ChartStream, type ChartStreamStatus } from "./chart-stream";
import { useChartPrice } from "./chart-live-price";
import { useCoinChartControls } from "./chart-preferences";
import { ChartView, type ChartSourceName } from "./ChartView";
import { useLiveScreen } from "../coin/LiveScreen";

function plotForControls(state: ReturnType<typeof initialChart>, source: ChartSource, controls: ChartControls, committed: ChartSource["migration"], venuePoolKey: string | null, requestAt: number) {
  const key = chartKey(controls);
  const shown = state.key === key ? state : initialChart(key, venuePoolKey !== null, committed ?? state.migration);
  const plotCurve = chartPoolKeys({ ...source, venuePoolKey, migration: shown.migration }, controls, requestAt).includes(source.curvePoolKey);
  return { shown, plotCurve };
}

/** HTTP history plus the tab's bounded same-origin market stream. */
export function CoinChart({
  source,
  compact,
  coinType,
  initialControls,
  initialSnapshot,
  livePreset,
}: Readonly<{ source: ChartSource; compact?: boolean; coinType: string; initialControls: ChartControls; initialSnapshot?: ChartSnapshot; livePreset: boolean }>) {
  const currency = useCoinPriceCurrency();
  const standaloneRate = useQuoteUsd(currency ? null : source.quoteType ?? null);
  const quoteUsd = currency ? currency.quoteUsd : standaloneRate;
  const [entry] = useState(initialSnapshot);
  const { controls, ready, commit, chosen } = useCoinChartControls(compact, initialControls, true, livePreset, entry !== undefined);
  const [state, setState] = useState(() => chartFromSnapshot(source, initialControls, initialSnapshot));
  const [hidden, setHidden] = useState<readonly ChartSourceName[]>([]);
  const [pending, setPending] = useState(false);
  const { network, deployment } = source.expected ?? { network: null, deployment: null };
  const expected = useMemo(() => network && deployment ? { network, deployment } : null, [network, deployment]);
  const dependencies = useMemo(() => browserMarketDependencies(expected), [expected]);
  const stream = useRef<ChartStream | null>(null);
  const [streamStatus, setStreamStatus] = useState<ChartStreamStatus>("connecting");
  const liveScreen = useLiveScreen();
  const known = useRef(state.migration);
  const [requestAt, setRequestAt] = useState(entry?.readAt ?? 0);
  const [useEntry, setUseEntry] = useState(true);
  const venuePoolKey = source.venuePoolKey ?? state.migration?.venuePoolKey ?? null;
  const curvePoolKey = source.curvePoolKey;
  const currentPrice = useShownPrice(venuePoolKey ?? curvePoolKey);
  const migrationCursor = source.migration?.cursor ?? null;
  const migrationTimestamp = source.migration?.timestampMs ?? null;
  const migrationCurve = source.migration?.curvePoolKey ?? null;
  const migrationVenue = source.migration?.venuePoolKey ?? null;
  const committed = useMemo(() => migrationCursor !== null && migrationTimestamp !== null && migrationCurve !== null
    ? { cursor: migrationCursor, timestampMs: migrationTimestamp, curvePoolKey: migrationCurve, venuePoolKey: migrationVenue }
    : null, [migrationCursor, migrationTimestamp, migrationCurve, migrationVenue]);

  const change = (choice: ChartControls, remember = true) => {
    stream.current?.stop();
    setUseEntry(false);
    const next = commit(choice, remember);
    // Candles read for other controls are never shown under these: the chart starts over.
    setState((shown) => initialChart(chartKey(next), shown.venue !== null, shown.migration));
  };

  // The live screen opens a quiet coin on a coarser interval, once, unless the viewer picked one.
  const densityChecked = useRef(false);
  // It decides once every pool the chart reads has answered, on their traded buckets together.
  const stepToDensity = useEffectEvent((reads: ReadonlyMap<string, Section<ChartCandlePage>>, pools: readonly string[], current: () => boolean) => {
    if (!liveScreen || chosen || densityChecked.current || reads.size < pools.length) return;
    const sections = [...reads.values()];
    if (sections.some((section) => section.state === "unavailable" || section.state === "stale")) return;
    densityChecked.current = true;
    const traded = sections.flatMap((section) => section.state === "available" ? tradedBuckets(section.data.candles) : []);
    const interval = denseInterval(traded, controls, Date.now());
    // Outside the stream's callback: changing controls stops this stream.
    if (interval !== controls.interval) queueMicrotask(() => { if (current()) change({ ...controls, interval }, false); });
  });

  useEffect(() => {
    if (!ready) return;
    const key = chartKey(controls);
    const seed = useEntry && entry?.key === key ? entry : undefined;
    const startedAt = seed?.readAt ?? Date.now();
    const pools = chartPoolKeys({ curvePoolKey, venuePoolKey, migration: committed ?? known.current }, controls, startedAt);
    const densityReads = new Map<string, Section<ChartCandlePage>>();
    // The tab's market stream hub keeps the connection through short hides and closes it after longer ones.
    const client = new ChartStream({
      pools,
      coin: coinType,
      expected,
      migration: () => committed ?? known.current,
      request: () => chartTailRequest(controls, Date.now()),
      load: (pool, checkpoint) => readChartPool(pool, controls, atCheckpoint(dependencies, checkpoint), Date.now()),
      onSection: (pool, section, migration) => {
        if (stream.current !== client) return;
        const marker = committed ?? migration ?? known.current;
        known.current = marker;
        densityReads.set(pool, section);
        stepToDensity(densityReads, pools, () => stream.current === client);
        if (seed?.pools.some(([key, read]) => key === pool && read.section === section)) return;
        const name = pool === curvePoolKey ? "curve" : "venue";
        setState((shown) => {
          const current = shown.key === key ? shown : initialChart(key, venuePoolKey !== null, marker);
          return afterChartSourceRead(current, key, name, section, marker);
        });
        setRequestAt(Date.now());
      },
      onStatus: setStreamStatus,
      livePolls: !liveScreen,
    });
    stream.current = client;
    client.start(seed?.pools);
    return () => {
      client.stop();
      if (stream.current === client) stream.current = null;
    };
  }, [coinType, controls, curvePoolKey, venuePoolKey, committed, dependencies, expected, ready, entry, useEntry, liveScreen]);

  const refresh = () => {
    setPending(true);
    return (stream.current?.refresh() ?? Promise.resolve()).finally(() => setPending(false));
  };

  const key = chartKey(controls);
  const preview = useEntry && entry?.key === key;
  const updates = chartUpdateText(streamStatus, preview);
  const { shown, plotCurve } = plotForControls(state, source, controls, committed, venuePoolKey, requestAt);

  return (
    <ChartView
      compact={compact}
      state={shown}
      // Until the stream's first price arrives, the last REST close is the price shown, never "—".
      currentPrice={currentPrice}
      source={source}
      omitCurve={!plotCurve}
      quoteUsd={quoteUsd}
      controls={controls}
      request={chartRequest(controls, requestAt)}
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

function chartUpdateText(status: ChartStreamStatus, preview: boolean): string | null {
  return preview && status === "connecting" ? null : STREAM_TEXT[status];
}

/** The chart's price: `undefined` until the stream's first price (the last close shows), `null` once the stream withdraws it. */
function useShownPrice(poolKey: string | null): string | null | undefined {
  const price = useChartPrice(poolKey);
  const [pricedPool, setPricedPool] = useState<string | null>(null);
  if (price && pricedPool !== poolKey) setPricedPool(poolKey);
  return price?.price ?? (pricedPool === poolKey ? null : undefined);
}
