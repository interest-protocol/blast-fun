import { readBrowserStorage, writeBrowserStorage } from "#web/lib/browser-storage.ts";
import { useSyncExternalStore } from "react";
import { readTradePresets, TRADE_PRESETS_KEY, validateTradePresets, type TradePresets } from "./trade-presets";

const CHANGED = "blast:trade-presets";
function snapshot() {
  return readBrowserStorage("local", TRADE_PRESETS_KEY);
}
function subscribe(notify: () => void) {
  const storage = (event: StorageEvent) => { if (event.key === TRADE_PRESETS_KEY || event.key === null) notify(); };
  window.addEventListener("storage", storage);
  window.addEventListener(CHANGED, notify);
  return () => { window.removeEventListener("storage", storage); window.removeEventListener(CHANGED, notify); };
}
export function useTradePresets() {
  return readTradePresets(useSyncExternalStore(subscribe, snapshot, () => null));
}
export function saveTradePresets(presets: TradePresets): boolean {
  if (!validateTradePresets(presets)) return false;
  try {
    if (!writeBrowserStorage("local", TRADE_PRESETS_KEY, JSON.stringify(presets))) return false;
    window.dispatchEvent(new window.Event(CHANGED));
    return true;
  } catch { return false; }
}
