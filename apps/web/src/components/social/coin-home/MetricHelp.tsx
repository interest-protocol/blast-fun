"use client";

import { Tooltip, TooltipSurface } from "#web/components/blast-ui/Tooltip.tsx";
import type { ReactNode } from "react";
import styles from "./CoinHome.module.css";

export function MetricHelp({ why, children }: Readonly<{ why: string; children: ReactNode }>) {
  return <Tooltip.Root>
    <Tooltip.Trigger render={<button type="button" />} className={styles.metricHelp} aria-label={why}>{children}</Tooltip.Trigger>
    <TooltipSurface
      positioner={{ sideOffset: 6, collisionPadding: 12, className: styles.settingsLayer }}
      popup={{ className: styles.metricTip }}
    >{why}</TooltipSurface>
  </Tooltip.Root>;
}

export function Unknown({ why }: Readonly<{ why: string }>) {
  return <span><span aria-hidden="true">—</span><span className="sr-only">{why}</span></span>;
}
