import { useMemo, useRef, useState, useSyncExternalStore } from "react";

import { chartSearch, DEFAULT_CHART_CONTROLS, parseChartControls, parseLiveChartControls, type ChartControls } from "./chart-model";

import { listOriginHistoryState } from "#web/components/blast-ui/list-restoration.ts";

type Preference = "controls" | "style" | "wallet-tags";

function snapshot(name: Preference): string {
  try {
    return window.localStorage.getItem(`blast.coin-chart.${name}`) ?? "";
  } catch {
    return "";
  }
}

const noSubscription = () => () => {};
const serverSnapshot = () => null;

export function useChartPreference(name: Preference) {
  const [readInitial] = useState(() => {
    let saved: string | undefined;
    // A choice in another tab applies when a new chart opens.
    return () => {
      if (saved === undefined) saved = snapshot(name);
      return saved;
    };
  });
  return useSyncExternalStore(noSubscription, readInitial, serverSnapshot);
}

export function saveChartPreference(name: Preference, value: string): void {
  try {
    window.localStorage.setItem(`blast.coin-chart.${name}`, value);
  } catch {
    // The current choice still holds when storage is disabled.
  }
}

export function saveChartControls(current: ChartControls, next: ChartControls): void {
  const fields = new URLSearchParams(snapshot("controls"));
  if (next.range !== current.range) fields.set("range", next.range);
  if (next.interval !== current.interval) fields.set("interval", next.interval);
  saveChartPreference("controls", fields.toString());
}

export function preferredChartControls(saved: string, search: string, initial: ChartControls, live = true, livePreset = live): ChartControls {
  if (!saved) return initial;
  const fields = (value: string) => {
    const query = new URLSearchParams(value);
    const interval = query.getAll("interval");
    const range = query.getAll("range");
    return { interval: interval.length === 1 ? interval[0] : undefined, range: range.length === 1 ? range[0] : undefined };
  };
  const parse = live ? parseLiveChartControls : parseChartControls;
  const query = fields(search);
  if (!livePreset && query.range === "live") return initial;
  return parse(query, parse(fields(saved), initial));
}

export function useCoinChartControls(compact: boolean | undefined, initialControls: ChartControls, live = true, livePreset = live) {
  const saved = useChartPreference("controls");
  const ready = !compact || saved !== null;
  const { interval: initialInterval, range: initialRange } = initialControls;
  const preferred = useMemo(
    () => {
      const initial = { interval: initialInterval, range: initialRange };
      return compact && saved && typeof window !== "undefined"
        ? preferredChartControls(saved, window.location.search, initial, live, livePreset)
        : initial;
    },
    [compact, saved, initialInterval, initialRange, live, livePreset],
  );
  const [selected, setControls] = useState<ChartControls | null>(null);
  const controls = !livePreset && selected?.range === "live" ? preferred : selected ?? preferred;
  const historyInterval = useRef<ChartControls["interval"] | null>(null);
  function commit(choice: ChartControls): ChartControls {
    if (choice.range === "live" && controls.range !== "live") historyInterval.current = controls.interval;
    const leavingLive = controls.range === "live" && choice.range !== "live";
    const next = leavingLive
      ? { ...choice, interval: historyInterval.current ?? preferredChartControls(saved ?? "", "", DEFAULT_CHART_CONTROLS).interval }
      : choice;
    if (compact && next.range !== "live") {
      saveChartControls(leavingLive ? { ...controls, interval: next.interval } : controls, next);
    }
    setControls(next);
    const url = new URL(window.location.href);
    for (const [key, value] of new URLSearchParams(chartSearch(next))) url.searchParams.set(key, value);
    // The chart controls change the URL within the same coin entry.
    window.history.replaceState(listOriginHistoryState(), "", url);
    return next;
  }
  return { controls, ready, commit };
}
