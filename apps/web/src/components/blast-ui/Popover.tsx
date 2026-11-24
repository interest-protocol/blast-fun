"use client";

import { Popover } from "@base-ui/react/popover";
import type { ReactNode } from "react";

import { usePortalContainer } from "#web/components/ui-libraries/portal.ts";

export { Popover };

type PopoverSurfaceProps = Readonly<{
  positioner?: Omit<Popover.Positioner.Props, "children">;
  popup?: Omit<Popover.Popup.Props, "children"> & Partial<Record<`data-${string}`, string | boolean>>;
  children: ReactNode;
}>;

export function PopoverSurface({ positioner, popup, children }: PopoverSurfaceProps) {
  const container = usePortalContainer();
  return (
    <Popover.Portal container={container}>
      <Popover.Positioner {...positioner}>
        <Popover.Popup {...popup}>{children}</Popover.Popup>
      </Popover.Positioner>
    </Popover.Portal>
  );
}
