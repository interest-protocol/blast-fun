import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// The launchpad's two color themes, as blast-ui.css declares them:
// each `--lp-*` token is `light-dark(<light>, <dark>)`.

const TOKENS = ["canvas", "surface", "raised", "ink", "muted", "accent", "accent-ink", "accent-text", "focus", "up", "down", "caution", "selected", "badge"] as const;
const TEXT_TOKENS = ["ink", "muted", "up", "down", "caution", "accent-text"] as const;
const PLANES = ["canvas", "surface", "raised", "selected", "badge"] as const;

type Token = (typeof TOKENS)[number];
type Palette = Readonly<Record<Token, string>>;

const THEMES = readThemes(readFileSync(new URL("../../blast-ui/blast-ui.css", import.meta.url), "utf8"));

function readThemes(css: string): Readonly<{ light: Palette; dark: Palette }> {
  const light: Partial<Record<Token, string>> = {};
  const dark: Partial<Record<Token, string>> = {};
  for (const token of TOKENS) {
    const match = new RegExp(`--lp-${token}: light-dark\\((#[0-9a-f]{6}), (#[0-9a-f]{6})\\);`).exec(css);
    assert.ok(match, `--lp-${token} should be light-dark(#rrggbb, #rrggbb)`);
    light[token] = match[1]!;
    dark[token] = match[2]!;
  }
  return { light: light as Palette, dark: dark as Palette };
}

function channel(value: number): number {
  const srgb = value / 255;
  return srgb <= 0.04045 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4;
}

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((start) => channel(parseInt(hex.slice(start, start + 2), 16)));
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

/** WCAG 2 contrast ratio between two `#rrggbb` colors. */
function contrastRatio(foreground: string, background: string): number {
  const [light, dark] = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
  return (light! + 0.05) / (dark! + 0.05);
}

test("contrast ratios match known WCAG reference values", () => {
  assert.equal(contrastRatio("#000000", "#ffffff").toFixed(2), "21.00");
  assert.equal(contrastRatio("#ffffff", "#ffffff").toFixed(2), "1.00");
  assert.equal(contrastRatio("#777777", "#ffffff").toFixed(2), "4.48");
});

test("the light theme uses the agreed palette", () => {
  const light = THEMES.light;
  assert.equal(light.canvas, "#fffafd");
  assert.equal(light.surface, "#ffffff");
  assert.equal(light.raised, "#f7edf2");
  assert.equal(light.ink, "#171218");
  assert.equal(light.accent, "#fe4c98");
});

test("the dark theme uses the agreed palette and pink is never its background", () => {
  const dark = THEMES.dark;
  assert.equal(dark.canvas, "#101721");
  assert.equal(dark.surface, "#151d28");
  assert.equal(dark.raised, "#23283a");
  assert.equal(dark.selected, "#1b4352", "teal marks the selected plane");
  assert.equal(dark.badge, "#312e4d", "violet marks badges");
  assert.equal(dark.ink, "#f7f5f6");
  assert.equal(dark.accent, "#fe4c98");
  for (const background of PLANES) {
    assert.notEqual(dark[background], dark.accent);
  }
});

for (const name of ["light", "dark"] as const) {
  const theme = THEMES[name];

  test(`${name} text, including provenance and semantic colors, meets 4.5:1 on every plane, selected and badge included`, () => {
    for (const text of TEXT_TOKENS) {
      for (const background of PLANES) {
        const ratio = contrastRatio(theme[text], theme[background]);
        assert.ok(ratio >= 4.5, `${name} ${text} on ${background} is ${ratio.toFixed(2)}`);
      }
    }
  });

  test(`${name} focus rings and state shapes meet 3:1 on every plane`, () => {
    for (const background of PLANES) {
      for (const shape of ["focus", "up", "down", "caution", "muted"] as const) {
        const ratio = contrastRatio(theme[shape], theme[background]);
        assert.ok(ratio >= 3, `${name} ${shape} on ${background} is ${ratio.toFixed(2)}`);
      }
    }
  });

  test(`${name} action text keeps 4.5:1 on its accent fill`, () => {
    const action = contrastRatio(theme["accent-ink"], theme.accent);
    assert.ok(action >= 4.5, `${name} action text is ${action.toFixed(2)}`);
  });
}
