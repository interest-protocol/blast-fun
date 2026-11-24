"use client";

import { Tooltip, TooltipSurface } from "#web/components/blast-ui/Tooltip.tsx";
import { useId, type ReactNode } from "react";
import styles from "./CoinHome.module.css";

export function MetricHelp({ why, children }: Readonly<{ why: string; children: ReactNode }>) {
  const descriptionId = useId();
  return <Tooltip.Root>
    <Tooltip.Trigger render={<button type="button" />} aria-describedby={descriptionId} className={styles.metricHelp}>{children}</Tooltip.Trigger>
    <span id={descriptionId} hidden>{why}</span>
    <TooltipSurface
      positioner={{ sideOffset: 6, collisionPadding: 12, className: styles.settingsLayer }}
      popup={{ "aria-hidden": true, className: styles.metricTip }}
    >{why}</TooltipSurface>
  </Tooltip.Root>;
}

export function Unknown({ why }: Readonly<{ why: string }>) {
  return <span><span aria-hidden="true">—</span><span className="sr-only">{why}</span></span>;
}
