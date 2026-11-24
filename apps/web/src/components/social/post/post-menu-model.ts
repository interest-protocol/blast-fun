

import type { BlastMenuPlacement } from "#web/components/blast-ui/BlastMenu.tsx";

/**
 * Where a post's More menu opens (the gate's `openMenu(…, 'down')`): 6px
 * below the dots, right-aligned, growing from 18px in from its right edge;
 * above them when there is no room below. Kept 8px inside the viewport.
 * Phones dock it to the bottom edge instead.
 */
export const POST_MENU_PLACEMENT: BlastMenuPlacement = { side: "bottom", align: "end", sideOffset: 6, avoid: "flip", originX: "calc(100% - 18px)" };
