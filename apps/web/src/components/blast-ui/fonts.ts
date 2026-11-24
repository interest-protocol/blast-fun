import { Bricolage_Grotesque, Geist, Geist_Mono } from "next/font/google";

/**
 * Geist and Geist Mono (tokens.md §4, corrected by `FEATURE-MAP-R3.md` §21.1
 * point 1), self-hosted by next/font at build time (the browser never calls
 * Google, so `font-src 'self'` holds) with metric-matched fallbacks, so
 * swapping in the web font does not shift layout.
 *
 * The reference loads them as **variable** fonts
 * (`Geist:wght@400..700&family=Geist+Mono:wght@400..600`), not as the static
 * weights the old build used, and it draws weights the static set cannot
 * render: `650` (the coin sheet's heading, Blast mode's metrics and delta
 * chips, the countdown rail's timer) would otherwise snap to `700`.
 * next/font self-hosts one variable file per family and has no way to clip
 * the `wght` axis to a sub-range, so the axis ships whole (100–900); that is a
 * superset of the reference's range, and every weight the design asks for is
 * rendered exactly rather than rounded to a neighbour.
 *
 * The range does not change a glyph (visual check, 2026-10-05): Google serves
 * one file per family whatever the range (`400..700` or `100..900` for Geist,
 * `400..600` or `100..900` for Geist Mono), and Chrome draws the same advances
 * under either `font-weight` descriptor. Google does pick the file by
 * browser: next/font fetches the macOS build, byte for byte what a Mac browser
 * gets for the gate's URL, while Linux Chrome gets one with other advances
 * (medium text 4% and semibold 1.5% narrower). A comparison run on Linux must
 * load the gate's fonts as macOS would before reading text widths.
 */
export const geist = Geist({
  subsets: ["latin"],
  weight: "variable",
  display: "swap",
  variable: "--font-geist",
});

export const geistMono = Geist_Mono({
  subsets: ["latin"],
  weight: "variable",
  display: "swap",
  variable: "--font-geist-mono",
});

/**
 * Bricolage Grotesque, the display face (OA-32): the wordmark, page and entity
 * titles and hero figures; Geist stays on everything else. Self-hosted and
 * fallback-matched like Geist, so `font-src 'self'` holds and the swap does
 * not shift layout.
 *
 * The owner's brief asks for `opsz,wght@12..96,600..800`: the optical-size
 * axis, so large sizes pick up the tighter display cut under the default
 * `font-optical-sizing: auto`, and not the width axis (`wdth`), which the
 * gate's link requests but only draws at its default, 100. As with Geist,
 * next/font cannot clip `wght` to a sub-range: `axes` takes only the extra
 * axes and the weight axis always ships whole (200–800 for this family), a
 * superset of the brief's 600–800 (the roles draw 700 and 800). It costs
 * nothing (visual check, 2026-10-06): for the macOS build next/font fetches,
 * Google serves the same latin file, byte for byte (76,868 bytes), for
 * `600..800` and `200..800`; the gate's `wdth` file is 131,312 bytes and
 * draws the same glyphs at the default width.
 */
export const bricolage = Bricolage_Grotesque({
  subsets: ["latin"],
  weight: "variable",
  axes: ["opsz"],
  display: "swap",
  variable: "--font-bricolage",
});
