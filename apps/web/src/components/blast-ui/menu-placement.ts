/** Where the menu opens against its trigger (base-ui's positioner, set to the gate's `openMenu`/`openCreateMenu`). */
export type BlastMenuPlacement = Readonly<{
  side: "top" | "bottom" | "right";
  align: "start" | "center" | "end";
  /** The gap to the trigger, by the side it ends up on (a flipped menu can take another). */
  sideOffset: number | ((side: "top" | "bottom" | "right" | "left") => number);
  alignOffset?: number;
  /** `flip`: to the other side when it does not fit (account, post); `shift`: slide inside the viewport (Create). */
  avoid: "flip" | "shift";
  /** Where along its top or bottom edge it grows from (the gate's `--ox`). */
  originX: string;
}>;

export type CreateMenuPayload = "mobile" | "rail" | undefined;

/**
 * Where the account menu opens (the gate's `openMenu`): below the top bar's
 * avatar, right-aligned, 6px down, growing from 18px in from its right edge.
 * Kept 8px inside the viewport. Phones dock it to the bottom edge instead.
 */
export function accountMenuPlacement(): BlastMenuPlacement {
  return { side: "bottom", align: "end", sideOffset: 6, avoid: "flip", originX: "calc(100% - 18px)" };
}
