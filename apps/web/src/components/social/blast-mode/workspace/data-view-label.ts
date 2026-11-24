import type { DataView } from "@blast/core/modules/social/blast-workspace/setup.ts";

/** The rail's discovery set, in order: what to buy, what is raising, what is bonding, what people say. */
export const PRIMARY_DATA_VIEWS: readonly DataView[] = ["Coins", "Presales", "Bonding", "Feed"];

/** The name a Data view shows; the saved key stays the same (the Feed view reads as Posts). */
export function dataViewLabel(view: DataView): string {
  return view === "Feed" ? "Posts" : view;
}
