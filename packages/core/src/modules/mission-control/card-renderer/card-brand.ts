import paths from "@blast/core/modules/mission-control/card-renderer/brand-paths.json" with { type: "json" };

/*
 * The Mission Control card's brand tokens and SVG primitives, for layouts
 * other than the season-zero card (the presale receipt). They are the values
 * and markup of edition-artwork.cjs, which stays unchanged because its bytes
 * are pinned to the season-zero renderer version. card-brand.test.ts renders
 * the standard season-zero card and requires every token and primitive here
 * to appear in it verbatim, so the two cannot drift apart silently.
 */

/** The card palette (`C` in edition-artwork.cjs). */
export const CARD_PALETTE = Object.freeze({
  punch: "#FF4C98",
  kicker: "#EFA1C9",
  paper: "#F8F5F7",
  canvas: "#0D1117",
  muted: "#8E9CAB",
  go: "#81CBA5",
  rec: "#FF5A4D",
} as const);

/** The standard, non-edition card (`BASE_THEME`, its strip, and the monitor screen). */
export const STANDARD_CARD = Object.freeze({
  frame: ["#1A1A1E", "#3C3C44", "#0C0C0E", "#2A2A30", "#15151A"] as const,
  bg: ["#040405", "#131316"] as const,
  grid: "#1E1E23",
  glow2: "#1E1E24",
  bezel: "#101013",
  ban: ["#F34C96", "#F12D82"] as const,
  pill: "rgba(13,17,23,.7)",
  stripFill: "rgba(129,203,165,.12)",
  stripText: "#D9FFE9",
  screen: "#0A0F16",
} as const);

export const CARD_FONT = "Inter,-apple-system,'Helvetica Neue',Arial,sans-serif";
/** The card's own coordinate space: 1050 x 750, the monitor at (64, 128) with side 456, the right column at 572. */
export const CARD_GEOMETRY = Object.freeze({ W: 1050, H: 750, PX: 64, PY: 128, PS: 456, RX: 572 } as const);

export const r2 = (value: number) => Math.round(value * 100) / 100;
export const escapeSvgText = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export type SvgTextOptions = Readonly<{
  weight?: number; italic?: boolean; spacing?: number; anchor?: "start" | "middle" | "end"; opacity?: number; length?: number;
}>;

/** A `<text>` in the card's font, with its attributes in the artwork's order. */
export function svgText(x: number, y: number, size: number, fill: string, value: string, options: SvgTextOptions = {}): string {
  return `<text x="${r2(x)}" y="${r2(y)}" font-family="${CARD_FONT}" font-size="${size}" font-weight="${options.weight ?? 500}"` +
    ` font-style="${options.italic ? "italic" : "normal"}" letter-spacing="${options.spacing ?? 0}em"` +
    ` text-anchor="${options.anchor ?? "start"}" fill="${fill}"` +
    (options.opacity === undefined ? "" : ` opacity="${options.opacity}"`) +
    (options.length === undefined ? "" : ` textLength="${r2(options.length)}" lengthAdjust="spacingAndGlyphs"`) +
    `>${escapeSvgText(value)}</text>`;
}

export function linearGradient(id: string, stops: readonly string[], x1: number, y1: number, x2: number, y2: number): string {
  return `<linearGradient id="${id}" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}">` +
    stops.map((color, index) => `<stop offset="${r2(index / (stops.length - 1))}" stop-color="${color}"/>`).join("") +
    "</linearGradient>";
}

export function bloomGradient(id: string, cx: number, cy: number, r: number, color: string, alpha: number): string {
  return `<radialGradient id="${id}" gradientUnits="userSpaceOnUse" cx="${cx}" cy="${cy}" r="${r}">` +
    `<stop offset="0" stop-color="${color}" stop-opacity="${alpha}"/>` +
    `<stop offset=".5" stop-color="${color}" stop-opacity="${r2(alpha * 0.45)}"/>` +
    `<stop offset="1" stop-color="${color}" stop-opacity="0"/></radialGradient>`;
}

export function roundedRectPath(x: number, y: number, w: number, h: number, r: number): string {
  return `M${x + r} ${y}h${w - 2 * r}a${r} ${r} 0 0 1 ${r} ${r}v${h - 2 * r}a${r} ${r} 0 0 1 -${r} ${r}` +
    `h-${w - 2 * r}a${r} ${r} 0 0 1 -${r} -${r}v-${h - 2 * r}a${r} ${r} 0 0 1 ${r} -${r}z`;
}

/** The Blast helmet mark, `w` units wide, its top-left at (x, y). */
export function helmetMark(x: number, y: number, w: number, fill: string): string {
  return `<path fill="${fill}" fill-rule="evenodd" transform="translate(${x} ${y}) scale(${r2(w / 434)}) translate(-409.33 -398)" d="${paths.helmet}"/>`;
}

/** The helmet and the `blast` word mark, `w` units wide. */
export function brandLockup(x: number, y: number, w: number, helmetFill: string = CARD_PALETTE.punch, wordFill: string = CARD_PALETTE.paper): string {
  const word = `<path fill="${wordFill}" fill-rule="evenodd" transform="translate(517 18.5) scale(${r2(900.4 / 451.34)}) translate(-403.33 -715.33)" d="${paths.word}"/>`;
  return `<g transform="translate(${x} ${y}) scale(${r2(w / 1418)})">${helmetMark(0, 0, 434, helmetFill)}${word}</g>`;
}
