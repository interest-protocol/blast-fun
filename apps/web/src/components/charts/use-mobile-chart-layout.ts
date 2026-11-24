import { useSyncExternalStore } from "react";
import { SHELL_PHONE_QUERY } from "#web/components/blast-ui/nav.ts";

const mobileChartQuery = `${SHELL_PHONE_QUERY}, (pointer: coarse)`;

function subscribe(onChange: () => void) {
  const query = window.matchMedia?.(mobileChartQuery);
  query?.addEventListener("change", onChange);
  return () => query?.removeEventListener("change", onChange);
}

function snapshot() {
  return window.matchMedia?.(mobileChartQuery).matches ?? false;
}

export function useMobileChartLayout(): boolean {
  return useSyncExternalStore(subscribe, snapshot, () => false);
}
