import type { WorkspaceLayout, WorkspaceSection } from "@blast/core/modules/social/blast-workspace/workspace-layout-model.ts";

/**
 * The board's two resizable lengths, in board px (16px root). The arrangement never changes
 * (owner, 2026-10-27): the chart card with the holders card under it, the ticket column beside
 * both. Only the ticket column's width and the holders card's height move, within 15% of their
 * default. The ticket's default is the board's 340; the holders card's follows the viewport's
 * height so a laptop's plot keeps its room. A size someone set persists in the
 * layout's `heights` (the ticket's under `trade`).
 */
export type BoardLength = "ticket" | "holders";

export type Band = Readonly<{ default: number; min: number; max: number }>;

export type BoardBands = Readonly<Record<BoardLength, Band>>;

/**
 * A 1280x800 laptop keeps a plot of about 220px. The holders default scales from the
 * 350px card on the 1156px board, never under 200px, and never under 280px on a screen short enough to scroll the board. The boot script serializes this function as well.
 */
export function boardBands(viewportHeight: number): BoardBands {
  function band(fallback: number): Band {
    // Integer arithmetic keeps 340 × 1.15 from rounding down to 390.
    const spread = Math.floor((fallback * 15) / 100);
    return { default: fallback, min: fallback - spread, max: fallback + spread };
  }
  // Below about 700px the board scrolls whatever the card's height, so the card keeps 280px (two holdings and their
  // actions, level with the trade column) instead of shrinking for a plot that already sits at its minimum (audit, Your portfolio).
  const floor = Math.min(280, Math.max(200, 280 - (viewportHeight - 700) * (80 / 57)));
  const holders = Math.round(Math.min(350, Math.max(floor, 350 - (1156 - viewportHeight) * (134 / 356))));
  return { ticket: band(340), holders: band(holders) };
}

export function narrowWorkspaceBoard(width: number, discoverIsSheet: boolean): boolean {
  return width < (discoverIsSheet ? 960 : 680);
}

export function boardSizes(layout: WorkspaceLayout, bands: BoardBands): Readonly<Record<BoardLength, number>> {
  return { ticket: clampLength(bands.ticket, layout.heights?.trade), holders: clampLength(bands.holders, layout.heights?.activity) };
}

export function clampLength({ default: fallback, min, max }: Band, value: number | undefined) {
  return Math.round(Math.min(max, Math.max(min, value ?? fallback)));
}

export function withLength(layout: WorkspaceLayout, length: BoardLength, value: number, bands: BoardBands): WorkspaceLayout {
  const key = length === "ticket" ? "trade" : "activity";
  const heights: Partial<Record<WorkspaceSection, number>> = { ...layout.heights };
  if (value === bands[length].default) delete heights[key];
  else heights[key] = value;
  return { ...layout, heights: Object.keys(heights).length ? heights : undefined };
}
