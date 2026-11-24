"use client";

import { Tooltip } from "@base-ui/react/tooltip";
import type { ReactNode } from "react";

import { usePortalContainer } from "#web/components/ui-libraries/portal.ts";

export { Tooltip };

type TooltipSurfaceProps = Readonly<{
  positioner?: Omit<Tooltip.Positioner.Props, "children">;
  popup?: Omit<Tooltip.Popup.Props, "children">;
  children: ReactNode;
}>;

export function TooltipSurface({ positioner, popup, children }: TooltipSurfaceProps) {
  const container = usePortalContainer();
  return (
    <Tooltip.Portal container={container}>
      <Tooltip.Positioner {...positioner}>
        <Tooltip.Popup {...popup}>{children}</Tooltip.Popup>
      </Tooltip.Positioner>
    </Tooltip.Portal>
  );
}
