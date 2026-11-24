import assert from "node:assert/strict";
import { readFileSync } from "#web/test/css-design-px.ts";
import test from "node:test";

/**
 * R3-85 (OA-41 8256) remains a source contract for the Profile stepper.
 * OA-31 body and Mobile-board tab tracking now run against real loaded fonts
 * in test/fixtures/workspace/verify-shell-typography.mjs (#799).
 */
const RULE = /([^{}]*)\{([^{}]*)\}/g;
const rules = (path: string) =>
  [...readFileSync(new URL(path, import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").matchAll(RULE)].map(
    ([, selector, body]) => [selector!.trim().replace(/\s+/g, " "), body!] as const,
  );
const tracking = (path: string, selector: string) => {
  const found = rules(path).filter(([candidate, body]) => candidate === selector && /letter-spacing:/.test(body));
  assert.equal(found.length, 1, `${path}: ${selector}`);
  return found[0]![1].match(/letter-spacing: ([^;]+);/)![1];
};

test("R3-85 (OA-41 8256): the compact stepper's labels grew to 12px and close up to -.01em", () => {
  assert.equal(tracking("../social/profile/Profile.module.css", ".stL"), "-.01em");
});
