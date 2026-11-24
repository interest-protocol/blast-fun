import { candleIntervalMs } from "@blast/core/modules/launchpad-contract/venue-history.ts";

import { CHART_HEIGHT, CHART_WIDTH, PANES, type ChartGeometry, type DrawnCandle } from "./chart-geometry";
import type { ChartControls } from "./chart-model";
import styles from "./Chart.module.css";

const position = (value: number) => Math.round(value * 10) / 10;

function rectangle(x: number, y: number, width: number, height: number): string {
  return `M${position(x)} ${position(y)}h${position(width)}v${position(height)}H${position(x)}Z`;
}

function candlePaths(candles: readonly DrawnCandle[]) {
  const wicks = { up: "", down: "", flat: "" };
  const bodies = { up: "", down: "", flat: "" };
  let volume = "";
  for (const candle of candles) {
    const { direction, wickX, highY, lowY, x, width, bodyTop, bodyHeight, volumeTop } = candle;
    wicks[direction] += `M${position(wickX)} ${position(highY)}V${position(lowY)}`;
    bodies[direction] += rectangle(x, bodyTop, width, bodyHeight);
    if (volumeTop < PANES.volumeBottom) {
      volume += rectangle(x, volumeTop, width, PANES.volumeBottom - volumeTop);
    }
  }
  return { wicks, bodies, volume };
}

function closePath(candles: readonly DrawnCandle[], intervalMs: number): string {
  let path = "";
  let previous: DrawnCandle | undefined;
  for (const candle of candles) {
    const adjacent = previous?.source === candle.source && candle.candle.bucketStart - previous.candle.bucketStart === intervalMs;
    const point = `${position(candle.wickX)} ${position(candle.closeY)}`;
    path += adjacent ? `L${point}` : `M${point}h0`;
    previous = candle;
  }
  return path;
}

/** Reserve the interactive plot's space with paths from the initial candles. */
export function ChartPreview({ geometry, interval, line }: Readonly<{
  geometry: ChartGeometry;
  interval: ChartControls["interval"];
  line: boolean;
}>) {
  const height = line ? PANES.volumeTop : CHART_HEIGHT;
  const paths = line ? null : candlePaths(geometry.candles);
  return (
    <svg className={styles.preview} data-chart-preview="" viewBox={`0 0 ${CHART_WIDTH} ${height}`} preserveAspectRatio="none" focusable="false">
      {paths ? <>
        {(["up", "down", "flat"] as const).map((direction) => (
          <g key={direction} className={styles.previewCandle} data-direction={direction}>
            <path d={paths.wicks[direction]} fill="none" stroke="currentColor" vectorEffect="non-scaling-stroke" />
            <path d={paths.bodies[direction]} fill="currentColor" />
          </g>
        ))}
        <path d={paths.volume} className={styles.previewVolume} />
      </> : <path d={closePath(geometry.candles, candleIntervalMs(interval))} className={styles.previewClose} fill="none" stroke="currentColor" strokeLinecap="round" vectorEffect="non-scaling-stroke" />}
      {geometry.migrationX !== null && <path d={`M${position(geometry.migrationX)} ${PANES.labelBand}V${height}`} className={styles.previewMigration} vectorEffect="non-scaling-stroke" />}
    </svg>
  );
}
