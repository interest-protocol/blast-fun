"use client";

import type { BarStage } from "@blast/core/modules/presale/presentation.ts";

import { dyn } from "./csp-style.ts";

/** The optional sale key gives the Blast Feel animation its landing target. */
export function ProgressBar({
  pct,
  small,
  className,
  stage,
  bar,
  label,
  smooth,
}: Readonly<{ pct: number; small?: boolean; className?: string; stage?: BarStage | null; bar?: string; label?: string; smooth?: boolean }>) {
  const value = Math.max(0, Math.min(100, pct));
  return (
    <span aria-label={label} aria-valuemax={label ? 100 : undefined} aria-valuemin={label ? 0 : undefined} aria-valuenow={label ? value : undefined} className={className} data-progress-bar={small ? "small" : ""} data-progress-smooth={smooth || undefined} data-stage={stage ?? undefined} role={label ? "progressbar" : undefined}>
      <i data-bar={bar} {...dyn(smooth ? { transform: `scaleX(${value / 100})` } : { width: `${value}%` })} />
    </span>
  );
}
