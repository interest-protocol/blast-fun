import type { BlastMenuPlacement, CreateMenuPayload } from "./menu-placement.ts";

/** Open beside the rail, below the header plus, or above the phone's bottom action. */
export function createMenuPlacement(payload: CreateMenuPayload = undefined): BlastMenuPlacement {
  if (payload === "rail") return { side: "right", align: "start", sideOffset: 8, avoid: "shift", originX: "0px" };
  return {
    side: payload === "mobile" ? "top" : "bottom",
    align: payload === "mobile" ? "center" : "end",
    sideOffset: 8,
    avoid: "shift",
    originX: payload === "mobile" ? "50%" : "calc(100% - var(--anchor-width, 0px) / 2)",
  };
}
