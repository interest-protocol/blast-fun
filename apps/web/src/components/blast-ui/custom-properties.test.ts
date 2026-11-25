import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";

/**
 * A custom property read without a fallback and defined nowhere makes its
 * declaration invalid, so the shadow, radius or colour silently drops out
 * (#620's `--shadow-card`; #622's `--r-card` sat in a dead rule). These are
 * set at runtime, not in a stylesheet.
 */
const RUNTIME = new Map([
  ["--active-tab-left", "Base UI's Tabs.Indicator"],
  ["--active-tab-width", "Base UI's Tabs.Indicator"],
  ["--available-height", "Base UI's positioner"],
  ["--collapsible-panel-height", "Base UI's Collapsible panel"],
  ["--transform-origin", "Base UI's popups"],
  ["--z-index", "Sonner's toasts (the inline toast portal has none, so its z-index is auto)"],
  ["--h", "presale-pages/bits.tsx, inline"],
]);

const ROOT = new URL("../../", import.meta.url);

function stylesheets(dir: URL): Array<readonly [string, string]> {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const url = new URL(`${entry.name}${entry.isDirectory() ? "/" : ""}`, dir);
    if (entry.isDirectory()) return stylesheets(url);
    if (!entry.name.endsWith(".css")) return [];
    return [[url.pathname.slice(ROOT.pathname.length), readFileSync(url, "utf8").replace(/\/\*[\s\S]*?\*\//g, "")] as const];
  });
}

test("every custom property read without a fallback is defined in a stylesheet or set at runtime", () => {
  const sheets = stylesheets(ROOT);
  const defined = new Set(sheets.flatMap(([, css]) => [...css.matchAll(/(--[\w-]+)\s*:/g)].map(([, name]) => name!)));
  const missing = sheets.flatMap(([path, css]) =>
    [...css.matchAll(/var\(\s*(--[\w-]+)\s*\)/g)].map(([, name]) => name!).filter((name) => !defined.has(name) && !RUNTIME.has(name)).map((name) => `${path}: ${name}`),
  );
  assert.deepEqual([...new Set(missing)], []);
});

test("the runtime list stays honest: each entry is read somewhere and defined in no stylesheet", () => {
  const sheets = stylesheets(ROOT);
  const all = sheets.map(([, css]) => css).join("\n");
  for (const name of RUNTIME.keys()) {
    assert.match(all, new RegExp(`var\\(\\s*${name}\\s*\\)`), `${name} is no longer read without a fallback; drop it`);
    assert.doesNotMatch(all, new RegExp(`${name}\\s*:`), `${name} is now defined in a stylesheet; drop it`);
  }
});
