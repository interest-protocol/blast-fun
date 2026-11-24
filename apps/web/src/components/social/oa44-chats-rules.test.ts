import assert from "node:assert/strict";
import { readFileSync } from "#web/test/css-design-px.ts";
import test from "node:test";

/**
 * OA-44 (2026-10-07): the oa43 gate (`design/blast-trading-home-oa43.html`, sha256 aa760f6f…) carries three generic
 * rules in its Chats block, adopted on the launch surfaces as the gate draws them:
 *
 * - `.msg { …; margin-top: 3px; }`: a field's hint (withdraw, onboarding, a sale's Edit details) sits 3 px lower;
 * - `.empty .btn { margin-top: 8px; }`: already drawn by both launch empty states that hold a button.
 *
 * The geometry needs a browser; this pins the source.
 */
const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
const RULE = /([^{}]*)\{([^{}]*)\}/g;
const rules = (css: string) => [...css.matchAll(RULE)].map(([, selector, body]) => ({ selector: selector!.trim(), body: body!.trim() }));

for (const [path, selector] of [
  ["./coins/coins.module.css", ".msg"],
  ["./onboarding/Onboarding.module.css", ".msg"],
  ["../presale-pages/SaleDetails.module.css", ".field .msg"],
] as const) {
  test(`OA-44 .msg: ${path} sets a field hint 3 px below its input`, () => {
    const found = rules(read(path)).filter((rule) => rule.selector === selector && /margin-top:/.test(rule.body));
    assert.equal(found.length, 1);
    assert.match(found[0]!.body, /margin-top: 3px;/);
  });
}

