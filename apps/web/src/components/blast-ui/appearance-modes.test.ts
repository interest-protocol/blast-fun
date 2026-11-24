import assert from "node:assert/strict";
import { readFileSync } from "#web/test/css-design-px.ts";
import test from "node:test";

/**
 * Reduce Transparency and Increase Contrast (OA-31, the gate's version 5
 * `prefers-reduced-transparency` and `prefers-contrast: more` blocks). The
 * gate writes its tokens on `html:root:root:root`; this app's tokens live on
 * `[data-blast-ui]`, so the pins below read the root rules that amend each
 * theme. Computed values need a browser; this pins the source.
 */
const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

/** The inner text of every `@media <query> { … }` block in `css`, whitespace collapsed. */
function media(css: string, query: string): string {
  const out: string[] = [];
  for (let at = css.indexOf(`@media ${query} {`); at >= 0; at = css.indexOf(`@media ${query} {`, at + 1)) {
    let depth = 0;
    let end = css.indexOf("{", at);
    const open = end;
    for (; end < css.length; end += 1) {
      if (css[end] === "{") depth += 1;
      else if (css[end] === "}") {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    out.push(css.slice(open + 1, end));
  }
  return out.join("\n").replace(/\s+/g, " ");
}

const base = read("./blast-ui.css");
const TRANSPARENCY = "(prefers-reduced-transparency: reduce)";
const CONTRAST = "(prefers-contrast: more)";
const CONTRAST_DARK = "(prefers-contrast: more) and (prefers-color-scheme: dark)";
const LIGHT = "--muted: #4d4c57; --faint: #6c6b76; --hair: #cfced8; --hair-2: #a9a8b4;";
const DARK = "--muted: #b4b3c0; --faint: #8f8e9b; --hair: #3a3944; --hair-2: #5a5967;";
const SOLID = "--glass: var(--bg); --glass-card: var(--card);";
const NO_BLUR = "[data-blast-ui] *, [data-blast-ui] *::before, [data-blast-ui] *::after { -webkit-backdrop-filter: none !important; backdrop-filter: none !important; }";
const EDGE = "outline: 1px solid var(--hair-2); outline-offset: -1px;";

test("OA-31: Reduce Transparency turns the glass solid and stops every blur", () => {
  const block = media(base, TRANSPARENCY);
  assert.ok(block.includes(`[data-blast-ui][data-blast-ui] { ${SOLID} }`), block);
  assert.ok(block.includes(NO_BLUR), block);
});

test("OA-31: Increase Contrast takes the version 5 values, light and dark, solid and unblurred", () => {
  const block = media(base, CONTRAST);
  assert.ok(block.includes(`[data-blast-ui][data-blast-ui] { ${SOLID} ${LIGHT} }`), block);
  assert.ok(block.includes(`[data-blast-ui][data-blast-ui][data-theme="dark"] { ${DARK} }`), block);
  assert.ok(block.includes(NO_BLUR), block);
  assert.ok(block.includes(`[data-blast-ui] .card { ${EDGE} }`), block);
  // The dark set is declared twice, as the theme's own: once for `system` under a dark scheme, once for an explicit dark.
  assert.ok(media(base, CONTRAST_DARK).includes(`[data-blast-ui][data-blast-ui]:not([data-theme="light"]) { ${DARK} }`));
});

test("OA-31: each mode's root rule outweighs the theme it amends and comes after it", () => {
  const theme = base.indexOf('[data-blast-ui][data-theme="dark"] {');
  for (const query of [TRANSPARENCY, CONTRAST, CONTRAST_DARK]) assert.ok(base.indexOf(`@media ${query} {`) > theme, query);
});

test("Increase Contrast edges every surface, with the sheet's stronger ink outline", () => {
  const edged: readonly (readonly [string, string, string?])[] = [
    // Every sheet, the link-a-wallet sheet included (OA-28 M2: it is the shared `Sheet`).
    ["./Sheet.module.css", ".sheet", "outline: 1px solid var(--ink); outline-offset: -1px;"],
    ["./AppShell.module.css", ".balancePopup, .menu, .tabbar"],
    ["../social/post/PostMenu.module.css", ".menu"],
    // OA-28 M1: the toast is sonner's `li`, named by its attribute so the edge wins over sonner's `outline: none`.
    ["./Toasts.module.css", "ol.toasts > li.toast[data-sonner-toast]"],
    ["../social/post/PostCard.module.css", ".post"],
  ];
  for (const [path, selector, edge = EDGE] of edged) assert.ok(media(read(path), CONTRAST).includes(`${selector} { ${edge} }`), `${path} ${selector}`);
});

test("OA-31: the gold card's glass chips turn solid in both modes", () => {
  const profile = read("../social/profile/Profile.module.css");
  for (const query of [TRANSPARENCY, CONTRAST]) assert.ok(media(profile, query).includes(".glassChip { background: rgba(15, 14, 19, .86); }"), query);
});
