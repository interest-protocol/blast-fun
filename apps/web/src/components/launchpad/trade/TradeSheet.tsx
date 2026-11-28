"use client";

import { useId, type ReactNode } from "react";

import { Sheet, SheetClose, SheetHeading } from "#web/components/blast-ui/Sheet.tsx";
import styles from "./trade-sheet.module.css";

/** A coin's trade rail in a sheet (the coin page's phone Trade, Home's Buy): its title, a close button and the rail's dock. */
export function TradeSheet({ open, title, onClose, onClosed, children }: Readonly<{
  open: boolean;
  title: string;
  onClose: () => void;
  onClosed?: () => void;
  children: ReactNode;
}>) {
  const titleId = useId();
  return (
    <Sheet open={open} onRequestClose={onClose} onClosed={onClosed} labelledBy={titleId} className={styles.sheet} hasDock>
      <SheetHeading id={titleId} title={title} />
      <SheetClose onClick={onClose} />
      {children}
    </Sheet>
  );
}
