import { poolLinePoints } from "#web/components/charts/candle-data.ts";
import { exactChartScale } from "#web/components/charts/exact-chart-scale.ts";

import { CHART_HEIGHT, CHART_WIDTH, PANES, type ChartGeometry, type DrawnCandle, type DrawnSeries } from "./chart-geometry";
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

function closePath({ start, end }: ChartGeometry, sources: readonly DrawnSeries[], migrationAt?: number, rolling?: boolean): string {
  const lines = poolLinePoints(sources, migrationAt, end, rolling);
  const scale = exactChartScale(lines.flatMap((points) => points.map(({ price }) => price)));
  return lines.map((points) => {
    const path = points.map(({ timestampMs, price }, index) => {
      const x = (timestampMs - start) * CHART_WIDTH / (end - start);
      const y = PANES.priceBottom - scale.coordinate(price) * (PANES.priceBottom - PANES.priceTop) / 100;
      return `${index === 0 ? "M" : "L"}${position(x)} ${position(y)}`;
    }).join("");
    return points.length === 1 ? `${path}h0` : path;
  }).join("");
}

/** Reserve the interactive plot's space with paths from the initial candles. */
export function ChartPreview({ geometry, sources, migrationAt, line, rolling, viewport }: Readonly<{
  geometry: ChartGeometry;
  sources: readonly DrawnSeries[];
  migrationAt?: number;
  line: boolean;
  rolling?: boolean;
  viewport?: "mobile" | "desktop";
}>) {
  const height = line ? PANES.volumeTop : CHART_HEIGHT;
  const paths = line ? null : candlePaths(geometry.candles);
  return (
    <svg className={styles.preview} data-chart-preview="" data-viewport={viewport} viewBox={`0 0 ${CHART_WIDTH} ${height}`} preserveAspectRatio="none" focusable="false">
      {paths ? <>
        {(["up", "down", "flat"] as const).map((direction) => (
          <g key={direction} className={styles.previewCandle} data-direction={direction}>
            <path d={paths.wicks[direction]} fill="none" stroke="currentColor" vectorEffect="non-scaling-stroke" />
            <path d={paths.bodies[direction]} fill="currentColor" />
          </g>
        ))}
        <path d={paths.volume} className={styles.previewVolume} />
      </> : <path d={closePath(geometry, sources, migrationAt, rolling)} className={styles.previewClose} fill="none" stroke="currentColor" strokeLinecap="round" vectorEffect="non-scaling-stroke" />}
      {geometry.migrationX !== null && <path d={`M${position(geometry.migrationX)} ${PANES.labelBand}V${height}`} className={styles.previewMigration} vectorEffect="non-scaling-stroke" />}
    </svg>
  );
}
