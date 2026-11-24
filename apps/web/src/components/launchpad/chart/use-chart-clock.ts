import { useCallback, useSyncExternalStore } from "react";

const serverClock = () => null;

/** Display time only. Refresh immediately when the tab becomes visible again. */
export function useChartClock(step: number, enabled: boolean): number | null {
  const subscribe = useCallback((onChange: () => void) => {
    if (!enabled) return () => {};
    const tick = () => { if (!document.hidden) onChange(); };
    const timer = window.setInterval(tick, step);
    document.addEventListener("visibilitychange", tick);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [enabled, step]);
  const read = () => enabled ? Math.floor(Date.now() / step) * step : null;
  return useSyncExternalStore(subscribe, read, serverClock);
}
