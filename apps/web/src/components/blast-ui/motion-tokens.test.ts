import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { EASE_DRAWER, EASE_IN_OUT, EASE_OUT, staggerDelay, T1, T2, T3, T4 } from "./motion-tokens";

test("script's motion tokens are blast-ui.css's", () => {
  const css = readFileSync(new URL("./blast-ui.css", import.meta.url), "utf8").replace(/\s+/g, "");
  for (const [name, value] of [["--ease-std", EASE_OUT], ["--ease-io", EASE_IN_OUT], ["--ease-drawer", EASE_DRAWER]] as const) {
    assert.ok(css.includes(`${name}:${value}`), `${name} is ${value}`);
  }
  assert.ok(css.includes(`--t1:.12s;--t2:.2s;--t3:.28s;--t4:.3s;`));
  assert.deepEqual([T1, T2, T3, T4], [120, 200, 280, 300]);
});

test("a group staggers 40ms an item, capped at the sixth (240ms)", () => {
  assert.deepEqual([0, 1, 2, 5, 6, 7, 30].map(staggerDelay), [0, 40, 80, 200, 240, 240, 240]);
  assert.equal(staggerDelay(-1), 0);
});
