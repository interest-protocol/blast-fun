import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

/** Custom properties set at runtime rather than in a stylesheet: Base UI's popup origin, and the shell's measured top bar. */
const RUNTIME = new Set(["--transform-origin", "--shell-topbar-height"]);

/** The stylesheets that apply on Home, comments stripped: the shared library, the app's globals and Home's own module. */
const sheet = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
const HOME_SHEETS = ["../../blast-ui/blast-ui.css", "../../../app/globals.css", "./CoinHome.module.css"];

test("#620: every custom property Home's stylesheet reads is defined, so no shadow or colour silently drops out", () => {
  const css = sheet("./CoinHome.module.css");
  const defined = new Set(HOME_SHEETS.flatMap((path) => [...sheet(path).matchAll(/(--[\w-]+)\s*:/g)].map(([, name]) => name!)));
  const used = new Set([...css.matchAll(/var\((--[\w-]+)/g)].map(([, name]) => name!));
  assert.deepEqual([...used].filter((name) => !defined.has(name) && !RUNTIME.has(name)), []);
});

test("#620: Home's sections and select menus are the library's menu box: the popover shadow and no border", () => {
  const css = sheet("./CoinHome.module.css").replace(/\s+/g, " ");
  for (const selector of [".sectionsMenu {", ".selectMenu {"]) {
    const start = css.indexOf(selector);
    assert.ok(start >= 0, selector);
    const body = css.slice(start, css.indexOf("}", start));
    assert.match(body, /box-shadow: var\(--sh-pop\);/, selector);
    assert.doesNotMatch(body, /\bborder:/, `${selector} (dark --sh-pop already draws a 1px ring)`);
  }
});
