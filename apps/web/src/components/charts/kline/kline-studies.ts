import { registerIndicator, registerOverlay, type Chart, type OverlayFigure } from "klinecharts";
import { fibLabelRows, RSI_PERIOD, rsiValues } from "./kline-model.ts";

/** The usual RSI guides. */
const RSI_GUIDES = [30, 70] as const;
/** Fibonacci retracement levels, top to bottom, as TradingView draws them. */
export const FIB_LEVELS = [1, 0.786, 0.618, 0.5, 0.382, 0.236, 0] as const;

export const BLAST_RSI = "blastRsi";
export const BLAST_FIB = "blastFib";
export const BLAST_GRADUATION = "blastGraduation";
/** "Graduated" at 11 px with its 4 px side padding, a little over its measured 60 px. */
const GRADUATED_CHIP_WIDTH = 64;

/** Text styles for a label drawn straight on the plot, in the axis colour. */
function plainText(chart: Chart) {
  const { color, family } = chart.getStyles().yAxis.tickText;
  return { color, family, size: 11, backgroundColor: "transparent", borderSize: 0, paddingLeft: 0, paddingRight: 0, paddingTop: 0, paddingBottom: 0 };
}

let registered = false;

/** Registers the chart's own studies and drawings once per page. */
export function registerStudies() {
  if (registered) return;
  registered = true;

  registerIndicator<{ rsi?: number }>({
    name: BLAST_RSI,
    shortName: "RSI",
    calcParams: [RSI_PERIOD],
    precision: 1,
    minValue: 0,
    maxValue: 100,
    figures: [{ key: "rsi", title: `RSI${RSI_PERIOD}: `, type: "line" }],
    calc: (dataList) => rsiValues(dataList.map((bar) => bar.close)).map((rsi) => rsi === null ? {} : { rsi }),
    // The 30 and 70 guides, dashed under the line; the line itself is drawn as usual.
    draw: ({ ctx, bounding, yAxis, chart }) => {
      ctx.strokeStyle = chart.getStyles().grid.horizontal.color;
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 3]);
      for (const level of RSI_GUIDES) {
        const y = Math.round(yAxis.convertToPixel(level)) + 0.5;
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(bounding.width, y);
        ctx.stroke();
      }
      return false;
    },
  });

  registerOverlay({
    name: BLAST_FIB,
    totalStep: 3,
    needDefaultPointFigure: true,
    needDefaultXAxisFigure: true,
    needDefaultYAxisFigure: true,
    createPointFigures: ({ chart, coordinates, bounding, overlay }) => {
      const [start, end] = overlay.points;
      if (coordinates.length < 2 || typeof start?.value !== "number" || typeof end?.value !== "number") return [];
      const [from, to] = [coordinates[0]!, coordinates[1]!];
      const precision = chart.getSymbol()?.pricePrecision ?? 2;
      const ys = FIB_LEVELS.map((level) => to.y + (from.y - to.y) * level);
      const shown = fibLabelRows(ys);
      const styles = chart.getStyles();
      // Quiet levels in the axis colour; each label sits on a chip of the card colour so a candle under it never garbles it.
      const figures: OverlayFigure[] = [{ type: "line", attrs: ys.map((y) => ({ coordinates: [{ x: 0, y }, { x: bounding.width, y }] })), styles: { color: styles.yAxis.tickText.color } }];
      const texts = FIB_LEVELS.flatMap((level, index) => {
        if (!shown[index]) return [];
        const value = chart.getDecimalFold().format((end.value! + (start.value! - end.value!) * level).toFixed(precision));
        return [{ x: bounding.width - 6, y: ys[index]! - 1, text: `${(level * 100).toFixed(1)}%  ${value}`, align: "right" as const, baseline: "bottom" as const }];
      });
      figures.push({ type: "text", attrs: texts, styles: { ...plainText(chart), backgroundColor: styles.overlay.text.color, paddingLeft: 3, paddingRight: 3, paddingTop: 1, paddingBottom: 1, borderRadius: 2 }, ignoreEvent: true });
      return figures;
    },
  });

  registerOverlay({
    name: BLAST_GRADUATION,
    totalStep: 2,
    needDefaultPointFigure: false,
    needDefaultXAxisFigure: false,
    needDefaultYAxisFigure: false,
    createPointFigures: ({ chart, coordinates, bounding }) => {
      const x = coordinates[0]?.x;
      if (x === undefined || x < 0 || x > bounding.width) return [];
      const { color } = chart.getStyles().yAxis.tickText;
      return [{ type: "line", attrs: { coordinates: [{ x, y: 0 }, { x, y: bounding.height }] }, styles: { color, style: "dashed", dashedValue: [3, 3] }, ignoreEvent: true }];
    },
    // The event's name sits on the time axis, as charting apps mark events, clear of the candles, price marks and legends.
    // Near either edge the chip slides inward, so it is never cut.
    createXAxisFigures: ({ chart, coordinates, bounding }) => {
      const x = coordinates[0]?.x;
      if (x === undefined || x < 0 || x > bounding.width) return [];
      const styles = chart.getStyles();
      const half = GRADUATED_CHIP_WIDTH / 2;
      const at = Math.min(Math.max(x, half), bounding.width - half);
      return [{ type: "text", attrs: { x: at, y: 4, text: "Graduated", align: "center", baseline: "top" }, styles: { ...plainText(chart), color: styles.overlay.text.color, backgroundColor: styles.yAxis.tickText.color, paddingLeft: 4, paddingRight: 4, paddingTop: 2, paddingBottom: 2, borderRadius: 2 }, ignoreEvent: true }];
    },
  });
}
