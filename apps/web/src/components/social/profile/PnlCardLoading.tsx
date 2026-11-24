"use client";

import { useId } from "react";
import { SkeletonBox, SkeletonRegion } from "#web/components/blast-ui/Skeleton.tsx";
import { Sheet, SheetClose, SheetHeading } from "#web/components/blast-ui/Sheet.tsx";
import styles from "./Profile.module.css";

export function PnlCardLoading({ onClose }: Readonly<{ onClose: () => void }>) {
  const heading = useId();
  return <Sheet labelledBy={heading} onRequestClose={onClose} open>
    <SheetClose onClick={onClose} />
    <SheetHeading id={heading} title="Your PnL card" />
    <SkeletonRegion className={styles.pnlCardCanvas} label="Loading card preview"><SkeletonBox className={styles.pnlCardSkeleton} /></SkeletonRegion>
  </Sheet>;
}
