import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";

import { CHART_CONTROLS_COOKIE, chartSearch, DEFAULT_CHART_CONTROLS, preferredChartControls, type ChartControls } from "./chart-model";

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

function saveChartControlsCookie(value: string): void {
  const saved = new URLSearchParams(value);
  const fields = new URLSearchParams();
  for (const key of ["interval", "range"]) {
    const field = saved.get(key);
    if (field && field.length <= 3 && saved.getAll(key).length === 1) fields.set(key, field);
  }
  try {
    document.cookie = `${CHART_CONTROLS_COOKIE}=${encodeURIComponent(fields.toString())}; Path=/coin; Max-Age=31536000; SameSite=Lax${location.protocol === "https:" ? "; Secure" : ""}`;
  } catch {
    // The URL and local preference still work when cookies are disabled.
  }
}

export function saveChartControls(current: ChartControls, next: ChartControls): void {
  const fields = new URLSearchParams(snapshot("controls"));
  if (next.range !== current.range) fields.set("range", next.range);
  if (next.interval !== current.interval) fields.set("interval", next.interval);
  const value = fields.toString();
  saveChartPreference("controls", value);
  saveChartControlsCookie(value);
}

export function useCoinChartControls(compact: boolean | undefined, initialControls: ChartControls, live = true, livePreset = live, seeded = false) {
  const saved = useChartPreference("controls");
  useEffect(() => {
    if (compact && saved) saveChartControlsCookie(saved);
  }, [compact, saved]);
  const ready = seeded || !compact || saved !== null;
  const { interval: initialInterval, range: initialRange } = initialControls;
  const preferred = useMemo(
    () => {
      const initial = { interval: initialInterval, range: initialRange };
      // A legacy local-only choice is mirrored for the next entry. Keep the current server plot intact.
      return !seeded && compact && saved && typeof window !== "undefined"
        ? preferredChartControls(saved, window.location.search, initial, live, livePreset)
        : initial;
    },
    [seeded, compact, saved, initialInterval, initialRange, live, livePreset],
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
