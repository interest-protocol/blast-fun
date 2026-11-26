"use client";

import { ClientOnly } from "#web/components/ui-libraries/use-hydrated.tsx";

import SparklinePlot from "./SparklinePlot";
import type { SparkPoint } from "./spark-model";

/** A stable, noninteractive slot; empty histories never invent a line. */
export function Sparkline({
  points,
  width,
  height,
  up,
  ink = false,
  className,
  slot,
}: Readonly<{
  points: readonly SparkPoint[] | null | undefined;
  width: number;
  height: number;
  /** Green or red by a result (a call's multiple) instead of the line's own ends. */
  up?: boolean;
  /** The text's own colour, no green or red (a ledger row whose only coloured figure is the move). */
  ink?: boolean;
  className?: string;
  /** `data-slot`, for tests and the browser check. */
  slot?: string;
}>) {
  return (
    <span aria-hidden="true" className={className} data-slot={slot}>
      {points && points.length >= 2 ? (
        <ClientOnly>
          <SparklinePlot height={height} ink={ink} points={points} up={up} width={width} />
        </ClientOnly>
      ) : null}
    </span>
  );
}
