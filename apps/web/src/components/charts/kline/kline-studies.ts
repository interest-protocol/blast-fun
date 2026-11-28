import { registerIndicator, registerOverlay, type Chart } from "klinecharts";
import { floorBarHeight, FLOOR_VOLUME_SHARE } from "./kline-model.ts";

export const BLAST_GRADUATION = "blastGraduation";
export const BLAST_FLOOR_VOLUME = "blastFloorVolume";
/** "Graduated" at 11 px with its 4 px side padding, a little over its measured 60 px. */
const GRADUATED_CHIP_WIDTH = 64;

/** Text styles for a label drawn straight on the plot, in the axis colour. */
function plainText(chart: Chart) {
  const { color, family } = chart.getStyles().yAxis.tickText;
  return { color, family, size: 11, backgroundColor: "transparent", borderSize: 0, paddingLeft: 0, paddingRight: 0, paddingTop: 0, paddingBottom: 0 };
}

let registered = false;

/** The floor volume bars' colours, by the bar's direction. */
export type FloorVolumeColors = Readonly<{ up: string; down: string; flat: string }>;

/** Registers the graduation marker and the floor volume bars once per page. */
export function registerStudies() {
  if (registered) return;
  registered = true;

  // A phone's volume: faint bars on the price pane's floor, each its share of the tallest bar in view, up to
  // FLOOR_VOLUME_SHARE of the pane. It has no figures, so it never widens the price axis; the price pane's
  // bottom gap keeps the candles above the bars. Drawn here (`draw` returns true), so the library adds nothing.
  // The price axis takes the fewest decimals of the price and its pane's indicators (YAxisImp.createRangeImp),
  // so the bars claim the most (16, kline-model `pricePrecision`) and leave the price's own.
  registerIndicator<unknown, unknown, FloorVolumeColors>({
    name: BLAST_FLOOR_VOLUME,
    precision: 16,
    figures: [],
    calc: (dataList) => dataList.map(() => ({})),
    createTooltipDataSource: () => ({ name: "", calcParamsText: "", features: [], legends: [] }),
    draw: ({ ctx, chart, indicator, bounding, xAxis }) => {
      const bars = chart.getDataList();
      const { from, to } = chart.getVisibleRange();
      const first = Math.max(0, from), last = Math.min(bars.length, to);
      let tallest = 0;
      for (let index = first; index < last; index++) tallest = Math.max(tallest, bars[index]?.volume ?? 0);
      if (!(tallest > 0)) return true;
      const band = bounding.height * FLOOR_VOLUME_SHARE;
      const { gapBar, halfGapBar } = chart.getBarSpace();
      const colors = indicator.extendData;
      for (let index = first; index < last; index++) {
        const bar = bars[index];
        const height = floorBarHeight(bar?.volume, tallest, band);
        if (!bar || !height) continue;
        ctx.fillStyle = bar.close > bar.open ? colors.up : bar.close < bar.open ? colors.down : colors.flat;
        ctx.fillRect(xAxis.convertToPixel(index) - halfGapBar, bounding.height - height, Math.max(1, gapBar), height);
      }
      return true;
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
