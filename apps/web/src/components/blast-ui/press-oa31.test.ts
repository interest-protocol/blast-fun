import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

/**
 * OA-31: claim buttons pressed while busy or done. A claim that is running
 * or has landed stays focusable and says so with `aria-disabled="true"`
 * (the dock's wallet, the panel's position and refund, the sale page's
 * aside), which `.btn:active:not([disabled])` let through; `.icon-btn:active`
 * had no guard at all. Every press of the shared controls, reduced motion's
 * included, now skips both.
 */
const css = readFileSync(new URL("./blast-ui.css", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

test('OA-31: .btn and .icon-btn press only when enabled: neither `disabled` nor `aria-disabled="true"` answers', () => {
  const presses = [...css.matchAll(/([^{}]*)\{[^{}]*\}/g)]
    .flatMap(([, selectors]) => selectors!.split(/,(?![^(]*\))/).map((selector) => selector.trim()))
    .filter((selector) => /\.(btn|icon-btn):active/.test(selector));
  const guarded = (control: string) => `[data-blast-ui] .${control}:active:not([disabled], [aria-disabled="true"])`;
  // The press, then reduced motion's.
  assert.deepEqual(presses, [guarded("btn"), guarded("icon-btn"), guarded("btn"), guarded("icon-btn")]);
});
