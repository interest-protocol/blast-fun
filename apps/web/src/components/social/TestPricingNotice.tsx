"use client";

import { Popover, PopoverSurface } from "#web/components/blast-ui/Popover.tsx";
import styles from "./TestPricingNotice.module.css";

const pricing = <><strong>TSUI has no real value.</strong> 1 TSUI uses SUI’s current USD price.</>;

export function TestPricingNotice({ enabled, compact = false }: Readonly<{ enabled: boolean; compact?: boolean }>) {
  if (!enabled) return null;
  if (!compact) return <aside className={styles.notice} aria-label="Test pricing">{pricing}</aside>;

  return <aside aria-label="Test pricing">
    <Popover.Root>
      <Popover.Trigger className={`${styles.notice} ${styles.compact}`}>Test pricing</Popover.Trigger>
      <PopoverSurface
        positioner={{ sideOffset: 8, collisionPadding: 16, className: styles.layer }}
        popup={{ "aria-label": "Test pricing", className: styles.details }}
      >{pricing}</PopoverSurface>
    </Popover.Root>
  </aside>;
}
