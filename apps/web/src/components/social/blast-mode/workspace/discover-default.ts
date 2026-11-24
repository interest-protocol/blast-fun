import { readBrowserStorage } from "#web/lib/browser-storage.ts";
/*
 * Discover's default by width (Blast mode audit, 2026-10-28): from 1100 to 1439px it shows
 * collapsed to its rail, so the chart and ticket keep their room; from 1440 the board's open
 * column. Only for someone who hasn't chosen, and only on screen: the saved workspace is not
 * changed. Opening or collapsing Discover on a desktop records the choice on the device.
 * Phones show Discover as a sheet that starts closed.
 */
export const DISCOVER_CHOSEN_KEY = "blast.discover.chosen";
export const DISCOVER_SHEET_WIDTH = 1100;
export const DISCOVER_DEFAULT_OPEN_WIDTH = 1440;
export const DISCOVER_SHEET_QUERY = `(max-width:${DISCOVER_SHEET_WIDTH - 1}px)`;

export function discoverChosen() {
  return readBrowserStorage("local", DISCOVER_CHOSEN_KEY) === "1";
}
export function discoverDefaultCollapsed(width: number) {
  return width >= DISCOVER_SHEET_WIDTH && width < DISCOVER_DEFAULT_OPEN_WIDTH;
}

export function discoverOpensOnScreen() {
  if (typeof window === "undefined" || window.matchMedia(DISCOVER_SHEET_QUERY).matches) return false;
  return !discoverDefaultCollapsed(window.innerWidth) || discoverChosen();
}
