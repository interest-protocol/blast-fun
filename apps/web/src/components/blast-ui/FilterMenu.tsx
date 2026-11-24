"use client";

import { useId, useState, type ReactNode } from "react";
import { IconButton } from "./Button";
import { FilterIcon } from "./Icons";
import { Popover, PopoverSurface } from "./Popover";
import { Sheet, SheetClose, SheetHeading } from "./Sheet";
import { usePhoneLayout } from "./use-shell-prefs";
import styles from "./FilterMenu.module.css";

export function FilterMenu({ label, active, children }: Readonly<{ label: string; active: boolean; children: ReactNode }>) {
  const phone = usePhoneLayout();
  const [open, setOpen] = useState(false);
  const title = useId();
  const trigger = <IconButton {...(phone ? { "aria-expanded": open, "aria-haspopup": "dialog" as const, onClick: () => setOpen(true) } : {})} aria-label={label} className={styles.trigger} data-active={active || undefined} size="touch" title={label} variant="secondary">
    <FilterIcon />
  </IconButton>;
  const fields = <div className={styles.fields}>{children}</div>;

  if (phone) return <>
    {trigger}
    <Sheet labelledBy={title} open={open} onRequestClose={() => setOpen(false)}>
      <SheetClose onClick={() => setOpen(false)} />
      <SheetHeading id={title} title="Filters" />
      {fields}
    </Sheet>
  </>;

  return <Popover.Root>
    <Popover.Trigger render={trigger} />
    <PopoverSurface positioner={{ align: "end", sideOffset: 8, collisionPadding: 12, className: styles.layer }} popup={{ className: styles.popup }}>
      <Popover.Title className={styles.title}>Filters</Popover.Title>
      {fields}
    </PopoverSurface>
  </Popover.Root>;
}
