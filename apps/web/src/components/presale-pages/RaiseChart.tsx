"use client";

import { useMemo } from "react";
import { ClientOnly } from "#web/components/ui-libraries/use-hydrated.tsx";
import type { SocialPresaleDetail } from "@blast/core/web/contracts/presales.ts";

import { cx } from "./cx";
import {
  raiseGeometry,
  raiseLabels,
  type ChartMark,
  type ChartOverlays,
} from "./raise-geometry";
import styles from "./RaiseChart.module.css";
import RaiseChartPlot from "./RaiseChartPlot";

export {
  raisedAt,
  unpiledMarks,
  type ChartMark,
  type ChartOverlays,
  type MarkSpot,
} from "./raise-geometry";

/** Cumulative funding, target and commitments around the shared chart renderer. */
export function RaiseChart({
  detail,
  id: chartId = "chartBox",
  marks,
  overlays,
  nowMs,
  stretch = false,
}: Readonly<{
  id?: string;
  detail: SocialPresaleDetail;
  marks: readonly ChartMark[];
  overlays: ChartOverlays;
  nowMs: number;
  stretch?: boolean;
}>) {
  const plotNow =
    detail.presale.phase === "open"
      ? Math.floor(nowMs / 60_000) * 60_000
      : detail.presale.end_ms;
  const geometry = useMemo(
    () => raiseGeometry(detail, plotNow),
    [detail, plotNow],
  );
  // R3-40: heights and printed figures in the sale's own coin.
  const words = raiseLabels(detail);
  return (
    <div
      className={cx("chartBox", styles.box, stretch && styles.stretch)}
      id={chartId}
    >
      <ClientOnly>
        <RaiseChartPlot
          stretch={stretch}
          geometry={geometry}
          label={words.label}
          marks={marks}
          overlays={overlays}
          points={detail.raise.points}
          targetLabel={words.target}
        />
      </ClientOnly>
    </div>
  );
}
