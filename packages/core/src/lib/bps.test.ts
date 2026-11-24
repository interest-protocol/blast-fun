import assert from "node:assert/strict";
import test from "node:test";

import { bpsMultiple, bpsPercent, isSlippageBps, minimumOut } from "./bps.ts";

// Fails if rounding accepts one atom below the advertised tolerance or the bound admits 100%.
test("the minimum rounds up, and a tolerance runs from 0 up to, not including, 100%", () => {
  assert.equal(minimumOut(999n, 100n), 990n);
  assert.equal(minimumOut(1_000_000n, 0n), 1_000_000n);
  assert.equal(minimumOut(18_446_744_073_709_551_615n, 50n), 18_354_510_353_341_003_857n);
  assert.deepEqual([-1n, 0n, 9_999n, 10_000n].map(isSlippageBps), [false, true, true, false]);
});

// Fails if a bps figure is read through floats (`1.005×` reads `1.00×` with toFixed).
test("basis points read as an exact percentage and a multiple rounded half up", () => {
  assert.deepEqual([5, 25, 50, 100, 255, 10_000].map((bps) => bpsPercent(bps)), ["0.05%", "0.25%", "0.5%", "1%", "2.55%", "100%"]);
  assert.equal(bpsPercent(-50n), "-0.5%");
  assert.deepEqual([12_500, 10_050, 10_000].map(bpsMultiple), ["1.25×", "1.01×", "1.00×"]);
});
