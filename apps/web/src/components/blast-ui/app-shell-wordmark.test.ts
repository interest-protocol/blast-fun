import assert from "node:assert/strict";
import { readFileSync } from "#web/test/css-design-px.ts";
import test from "node:test";

/**
 * OA-24 (the gate `design/blast-feel-preview-oa24.html`, sha256 232e34aa…3017f0a,
 * "Review pass": `.shell.rail-mini .topbar .brand b { opacity: 1 }`): the
 * collapsed-rail preference, on by default under 1400px, folds the rail's
 * wordmark only. Phones' top bar keeps "Blast" next to its mark. The earlier
 * gate faded it too, and the product had copied that.
 */
const css = readFileSync(new URL("./AppShell.module.css", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
const RULE = /([^{}]*)\{([^{}]*)\}/g;

test("OA-24: no collapsed-rail rule fades or hides the top bar's wordmark", () => {
  const rules = [...css.matchAll(RULE)].map(([, selector, body]) => [selector!.trim(), body!] as const);
  const topbarWordmark = rules.filter(([selector]) => /data-rail="mini"/.test(selector) && /\.topbar\b[^,]*\.brand b\b/.test(selector));
  for (const [selector, body] of topbarWordmark) {
    assert.doesNotMatch(body, /opacity:\s*0\b|display:\s*none|visibility:\s*hidden/, selector);
  }
  // The rail's own wordmark still folds away with the rail.
  assert.ok(rules.some(([selector, body]) => /data-rail="mini"/.test(selector) && /\.rail \.brand b/.test(selector) && /opacity: 0;/.test(body)));
  // Phones draw the top bar's wordmark at 21px.
  assert.ok(rules.some(([selector, body]) => selector === ".topbar .brand b" && /display: inline; font-size: 21px;/.test(body)));
});
