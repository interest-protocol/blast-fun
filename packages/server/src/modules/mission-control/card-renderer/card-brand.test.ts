import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import paths from "@blast/core/modules/mission-control/card-renderer/brand-paths.json" with { type: "json" };
import {
  bloomGradient,
  brandLockup,
  CARD_FONT,
  CARD_GEOMETRY,
  CARD_PALETTE,
  helmetMark,
  linearGradient,
  roundedRectPath,
  STANDARD_CARD,
  svgText,
} from "@blast/core/modules/mission-control/card-renderer/card-brand.ts";
import makeEditionArtwork from "@blast/server/modules/mission-control/card-renderer/edition-artwork.cjs";

/**
 * T-012 revision (Q-008): the receipt's brand tokens and SVG primitives are
 * the season-zero artwork's. edition-artwork.cjs is not edited (its bytes are
 * pinned to the season-zero renderer version); instead the standard card it
 * draws must contain every shared token and primitive verbatim.
 */

const artwork = makeEditionArtwork(paths);
const standard = artwork.cardSVG(
  { name: "your_callsign", avatar: "", role: "Flight Director", crewNo: 1042 },
  undefined as never,
  2,
);
const source = await readFile(new URL(import.meta.resolve("@blast/server/modules/mission-control/card-renderer/edition-artwork.cjs")), "utf8");

/** `name: '#RRGGBB'` pairs of an object literal `var <name>={...}` in the artwork source. */
function literalColors(name: string): Record<string, string> {
  const body = source.match(new RegExp(`var ${name}=\\{([^;]*?)\\};`))?.[1] ?? "";
  return Object.fromEntries([...body.matchAll(/(\w+):'(#[0-9A-Fa-f]{6}|rgba\([^']+\))'/g)].map(([, key, value]) => [key, value]));
}

test("the palette is the artwork's C palette and standard theme", () => {
  const palette = literalColors("C");
  for (const [key, value] of Object.entries(CARD_PALETTE)) assert.equal(value, palette[key], key);
  const base = source.match(/var BASE_THEME=\{(.*?)\};/)?.[1] ?? "";
  assert.ok(base.includes(`bg:['${STANDARD_CARD.bg.join("','")}']`));
  assert.ok(base.includes(`frame:['${STANDARD_CARD.frame.join("','")}']`));
  assert.ok(base.includes(`grid:'${STANDARD_CARD.grid}'`));
  assert.ok(base.includes(`glow2:'${STANDARD_CARD.glow2}'`));
  assert.ok(base.includes(`bezel:'${STANDARD_CARD.bezel}'`));
  assert.ok(base.includes(`ban:['${STANDARD_CARD.ban.join("','")}']`));
  assert.ok(base.includes(`pill:'${STANDARD_CARD.pill}'`));
  assert.ok(source.includes(`fill:'${STANDARD_CARD.stripFill}'`) && source.includes(`text:'${STANDARD_CARD.stripText}'`));
  assert.ok(source.includes(`var FONT="${CARD_FONT}"`));
  const { W, H, PX, PY, PS, RX } = CARD_GEOMETRY;
  assert.ok(source.includes(`W=${W},H=${H},PX=${PX},PY=${PY},PS=${PS},RX=${RX}`));
});

test("the primitives draw exactly what the standard season-zero card draws", () => {
  const { W, H, PX, PY, PS } = CARD_GEOMETRY;
  for (const [label, fragment] of [
    ["lockup", brandLockup(52, 50, 192)],
    ["helmet", helmetMark(0, 0, 434, CARD_PALETTE.punch)],
    ["frame gradient", linearGradient("lc-frame", STANDARD_CARD.frame, 0, 0, 1, 1)],
    ["background gradient", linearGradient("lc-bg", STANDARD_CARD.bg, 0, 0, 1, 0.5)],
    ["banner gradient", linearGradient("lc-ban", STANDARD_CARD.ban, 0, 0, 1, 0)],
    ["punch glow", bloomGradient("lc-gl", 60, 740, 700, CARD_PALETTE.punch, 0.3)],
    ["corner glow", bloomGradient("lc-gl2", 1000, 20, 620, STANDARD_CARD.glow2, 0.85)],
    ["sheen frame", `d="${roundedRectPath(0, 0, W, H, 38)}${roundedRectPath(14, 14, W - 28, H - 28, 26)}"`],
    ["pill", `<rect x="798" y="46" width="206" height="44" rx="22" fill="${STANDARD_CARD.pill}"/>`],
    ["pill text", svgText(840, 73, 13, CARD_PALETTE.paper, "MISSION CONTROL", { weight: 700, spacing: 0.16 })],
    ["monitor screen", `<rect x="${PX}" y="${PY}" width="${PS}" height="${PS}" fill="${STANDARD_CARD.screen}"/>`],
    ["bezel", `fill="${STANDARD_CARD.bezel}" stroke="${CARD_PALETTE.punch}" stroke-width="3"/>`],
    ["crew label", svgText(572, 392, 13, CARD_PALETTE.muted, "CREW NO.", { weight: 800, spacing: 0.22 })],
    ["camera label", svgText(PX + 34, PY + 42, 12, "#fff", "CAM 01  ·  CREW", { weight: 700, spacing: 0.16 })],
  ] as const) {
    assert.ok(standard.includes(fragment), `${label} drifted from edition-artwork.cjs`);
  }
});
