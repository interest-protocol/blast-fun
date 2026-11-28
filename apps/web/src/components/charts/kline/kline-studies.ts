import { registerOverlay, registerYAxis, type Chart } from "klinecharts";
import { readableUsd } from "#web/lib/market-format.ts";
import { capText } from "./kline-model.ts";

export const BLAST_GRADUATION = "blastGraduation";
/** The price axis in USD market cap: the last-price mark and the crosshair read like the headline ($84.2K). */
export const BLAST_MARKET_CAP_AXIS = "blastMarketCap";
/** "Graduated" at 11 px with its 4 px side padding, a little over its measured 60 px. */
const GRADUATED_CHIP_WIDTH = 64;

/** Text styles for a label drawn straight on the plot, in the axis colour. */
function plainText(chart: Chart) {
  const { color, family } = chart.getStyles().yAxis.tickText;
  return { color, family, size: 11, backgroundColor: "transparent", borderSize: 0, paddingLeft: 0, paddingRight: 0, paddingTop: 0, paddingBottom: 0 };
}

let registered = false;

/** Registers the graduation marker once per page. */
export function registerGraduation() {
  if (registered) return;
  registered = true;

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

let capAxis = false;

/** Registers the market-cap axis once per page. Its ticks get their own two places (createTicks), so close ones stay apart. */
export function registerMarketCapAxis() {
  if (capAxis) return;
  capAxis = true;
  registerYAxis({ name: BLAST_MARKET_CAP_AXIS, displayValueToText: (value) => (value > 0 ? readableUsd(String(value)) : capText(value)) });
}
