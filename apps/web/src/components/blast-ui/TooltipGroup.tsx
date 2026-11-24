"use client";

import { Tooltip } from "@base-ui/react/tooltip";
import type { ReactNode } from "react";

/** How long a tooltip waits for a resting pointer. */
export const TOOLTIP_DELAY_MS = 180;

/**
 * The app's one tooltip group. The first tooltip waits {@link TOOLTIP_DELAY_MS}; moving to the next tooltip trigger while
 * one is open, or just after it closes, shows that one at once and without its entrance (Base UI's `data-instant`).
 */
export function TooltipGroup({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <Tooltip.Provider delay={TOOLTIP_DELAY_MS} closeDelay={0}>
      {children}
    </Tooltip.Provider>
  );
}
