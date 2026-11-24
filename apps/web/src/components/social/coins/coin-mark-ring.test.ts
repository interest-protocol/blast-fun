import assert from "node:assert/strict";
import { readFileSync } from "#web/test/css-design-px.ts";
import test from "node:test";

/**
 * R3-07 (FEATURE-MAP-R3 §21.1 point 3; the gate `design/blast-feel-preview.html`,
 * sha256 dd8cb26c…c5bed, draws `.mk-sui.round::after` and no other mark ring): the
 * round mark's inner hairline rings SUI's white disc only, in the gate's literal
 * colour. `var(--hair)` is #25242d in dark mode, a near-black ring on a white disc,
 * and an unscoped rule rings USDC's blue disc. AC-4's computed-style check needs a
 * browser; this pins the separate profile stylesheet.
 */
const RULE = /([^{}]*)\{([^{}]*)\}/g;

for (const path of ["../profile/Profile.module.css"]) {
  test(`R3-07-AC-4 ${path}: one mark ring, on .mk-sui.round, in rgba(15, 14, 19, .1)`, () => {
    const css = readFileSync(new URL(path, import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    const rings = [...css.matchAll(RULE)].filter(([, selector]) => /\.mk\b/.test(selector!) && /::?after\b/.test(selector!));
    assert.deepEqual(rings.map(([, selector]) => selector!.trim()), [".mk.round:global(.mk-sui)::after"]);
    const body = rings[0]![2]!;
    assert.match(body, /box-shadow: inset 0 0 0 1px rgba\(15, 14, 19, \.1\);/);
    assert.doesNotMatch(body, /var\(/);
  });
}
