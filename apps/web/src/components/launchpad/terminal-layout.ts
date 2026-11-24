// The terminal's information architecture: which slot shows where. It is the
// single source for region visibility; CSS applies the answer per breakpoint.

/** The desktop composition starts here. Keep in sync with LaunchpadTerminal.module.css. */
export const TERMINAL_DESKTOP_MEDIA = "(min-width: 64rem)";

/** Desktop detail destinations below the chart, one visible at a time. */
export const DESKTOP_DESTINATIONS = ["overview", "theses", "activity", "holders"] as const;
export type DesktopDestination = (typeof DESKTOP_DESTINATIONS)[number];

/** Mobile bottom navigation. Trade opens a full-screen surface, not a view. */
export const MOBILE_DESTINATIONS = ["discover", "chart", "trade", "theses"] as const;
export type MobileDestination = (typeof MOBILE_DESTINATIONS)[number];
export type MobileView = Exclude<MobileDestination, "trade">;

/** Page regions in document order. `execution` is the desktop rail. */
export const TERMINAL_REGIONS = [
  "discovery",
  "market",
  "chart",
  "overview",
  "theses",
  "activity",
  "holders",
  "execution",
] as const;
export type TerminalRegion = (typeof TERMINAL_REGIONS)[number];

export type TerminalViewState = Readonly<{
  destination: DesktopDestination;
  mobileView: MobileView;
}>;

const MOBILE_VIEW_REGIONS: Record<MobileView, readonly TerminalRegion[]> = {
  discover: ["discovery"],
  chart: ["market", "chart", "overview", "holders"],
  theses: ["market", "theses", "activity"],
};

export function terminalRegionVisibility(
  region: TerminalRegion,
  state: TerminalViewState,
): { desktop: boolean; mobile: boolean } {
  const isDestination = (DESKTOP_DESTINATIONS as readonly string[]).includes(region);
  return {
    desktop: !isDestination || region === state.destination,
    mobile: MOBILE_VIEW_REGIONS[state.mobileView].includes(region),
  };
}

/** Tab-list keyboard movement (APG): arrows wrap, Home/End jump; else null. */
export function nextDestination(
  current: DesktopDestination,
  key: string,
): DesktopDestination | null {
  const last = DESKTOP_DESTINATIONS.length - 1;
  const index = DESKTOP_DESTINATIONS.indexOf(current);
  if (key === "ArrowRight") return DESKTOP_DESTINATIONS[index === last ? 0 : index + 1];
  if (key === "ArrowLeft") return DESKTOP_DESTINATIONS[index === 0 ? last : index - 1];
  if (key === "Home") return DESKTOP_DESTINATIONS[0];
  if (key === "End") return DESKTOP_DESTINATIONS[last];
  return null;
}
