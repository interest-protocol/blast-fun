import type { DiscoveryViewName } from "@blast/core/modules/launchpad-discovery/rows.ts";

import type { SectionState } from "../primitives/data-state";
import type { ViewList } from "./discovery-model";

/**
 * The rail between routes. The terminal remounts on each route (`/`,
 * `/coin/{launchId}`), so the rail keeps its view, the pages it has read and
 * the launch just chosen here, in this tab's memory, and comes back with
 * them. Only the browser writes it (from effects and handlers), so a server
 * render always starts fresh; a full page load starts fresh too.
 */
export type RailMemory = Readonly<{
  view: DiscoveryViewName;
  states: Readonly<Record<DiscoveryViewName, SectionState<ViewList>>>;
  /** The launch whose row had focus when it was chosen; focus returns to it once. */
  focusLaunchId: string | null;
}>;

let memory: RailMemory | null = null;

export function rememberRail(next: RailMemory | null): void {
  memory = next;
}

export function recallRail(): RailMemory | null {
  return memory;
}
