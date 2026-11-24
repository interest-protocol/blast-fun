"use client";

import { useMemo, useState } from "react";
import { usd } from "@blast/core/web/format.ts";
import {
  TradingViewChart,
  type ChartSeries,
  type ChartHandle,
} from "#web/components/charts/TradingViewChart.tsx";
import {
  chartData,
  elapsedTimeScale,
} from "#web/components/charts/tradingview-model.ts";
import { DateStamp } from "#web/components/blast-ui/DateStamp.tsx";
import { InspectValue } from "#web/components/blast-ui/InspectValue.tsx";
import { useShellPrefs } from "#web/components/blast-ui/use-shell-prefs.ts";
import { Avatar } from "#web/components/social/post/PostMedia.tsx";
import { dyn } from "#web/components/blast-ui/csp-style.ts";
import {
  raisedAt,
  unpiledMarks,
  type ChartMark,
  type ChartOverlays,
  type RaiseGeometry,
  type RaiseSample,
} from "./raise-geometry";
import styles from "./RaiseChart.module.css";

type Positioned = Readonly<{
  mark: ChartMark;
  x: number;
  y: number;
  r: number;
  rank: number;
  usd: number;
}>;
export default function RaiseChartPlot({
  geometry,
  points,
  marks,
  overlays,
  label,
  targetLabel,
}: Readonly<{
  geometry: RaiseGeometry;
  stretch: boolean;
  points: readonly RaiseSample[];
  marks: readonly ChartMark[];
  overlays: ChartOverlays;
  label: string;
  targetLabel: string;
}>) {
  const hidden = useShellPrefs().amountsHidden;
  const [view, setView] = useState<{
    marks: readonly Positioned[];
    target: number;
    now: { x: number; y: number } | null;
  } | null>(null);
  const time = useMemo(
    () => elapsedTimeScale(geometry.line.map((point) => point.t)),
    [geometry],
  );
  const projectionKey = useMemo(() => ({ marks, overlays }), [marks, overlays]);
  const series = useMemo<readonly ChartSeries[]>(
    () => [
      {
        type: "Area",
        data: chartData(
          geometry.line.map((point) => ({
            time: time.timestamp(point.t),
            value: point.v,
          })),
        ),
        options: {
          lineColor: "var(--pink)",
          lastValueVisible: false,
          priceLineVisible: false,
          autoscaleInfoProvider: () => ({
            priceRange: { minValue: 0, maxValue: geometry.maxV },
          }),
        },
      },
    ],
    [geometry, time],
  );
  const project = ({ series, timeToCoordinate }: ChartHandle) => {
    const position = (at: number, value: number) => ({
      x: Number(timeToCoordinate(time.snap(at))),
      y: Number(series[0]!.priceToCoordinate(value)),
    });
    const now = geometry.now ? position(geometry.now.t, geometry.now.v) : null;
    const placed = unpiledMarks(
      marks.map((mark) => ({
        mark,
        ...position(mark.t, raisedAt(points, mark.t, geometry.quote)),
        r: 22,
        rank: mark.rank,
        usd: mark.usd,
      })),
      now,
    );
    setView({
      marks: placed,
      target: Number(series[0]!.priceToCoordinate(geometry.target)),
      now,
    });
  };
  return (
    <div className={styles.plot}>
      <TradingViewChart
        series={series}
        timeline={time.timeline}
        compact
        label={hidden ? "Total raised over time" : label}
        onProject={project}
        projectionKey={projectionKey}
        onReady={({ series, host }) => {
          const line = series[0]!.createPriceLine({
            price: geometry.target,
            color:
              getComputedStyle(host).getPropertyValue("--muted").trim() ||
              "#777777",
            lineStyle: 2,
            axisLabelVisible: false,
          });
          return () => series[0]!.removePriceLine(line);
        }}
      />
      {view ? (
        <>
          <span className={styles.target} {...dyn({ top: `${view.target}px` })}>
            {hidden ? "Target" : targetLabel}
          </span>
          {view.marks.map(({ mark, x, y }) => (
            <span
              className={styles.mark}
              key={`${mark.kind}:${mark.t}:${mark.who}`}
              {...dyn({ left: `${x}px`, top: `${y}px` })}
            >
              <InspectValue
                label="funding commitment"
                value={`${mark.who} · ${hidden ? "Amount hidden" : usd(mark.usd)}${mark.why ? ` · ${mark.why}` : ""}`}
              >
                {mark.person ? (
                  <Avatar
                    callsign={mark.person.callsign ?? mark.who}
                    src={mark.person.avatar_url}
                    size={26}
                  />
                ) : (
                  <span className={styles.wallet} />
                )}
                {mark.why && overlays.thesis ? (
                  <span className={styles.thesis} aria-hidden="true" />
                ) : null}
              </InspectValue>
            </span>
          ))}
          {view.now ? (
            <span
              className={styles.now}
              aria-hidden="true"
              {...dyn({ left: `${view.now.x}px`, top: `${view.now.y}px` })}
            />
          ) : null}
        </>
      ) : null}
      <div className={styles.dates} aria-hidden="true">
        <DateStamp at={geometry.t0} plain />
        {geometry.open ? <span>Now</span> : <DateStamp at={geometry.t1} plain />}
      </div>
    </div>
  );
}
