import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import test from "node:test";

import {
  deriveSponsorCalls,
  FRAMEWORK_CALLS_PATH,
  renderFrameworkCalls,
  renderSwapCalls,
  SWAP_CALLS_PATH,
} from "../../../test/fixtures/modules/sponsor/framework-derivation.ts";

/**
 * T-015: the `0x1`/`0x2` functions and the Cetus swap functions the sponsor
 * allows are derived, never written by hand. This test rebuilds every SDK
 * commit and Cetus sponsored-mode swap fixture, derives both lists, and fails
 * when a committed file differs. Regenerate with
 * PRESALE_SPONSOR_FRAMEWORK_WRITE=1 and review the diff.
 */

test("the committed framework and swap lists equal the lists derived from SDK and Cetus sponsored-mode transactions", async () => {
  const { framework, swap } = await deriveSponsorCalls();
  for (const [path, derived] of [
    [FRAMEWORK_CALLS_PATH, renderFrameworkCalls(framework)],
    [SWAP_CALLS_PATH, renderSwapCalls(swap)],
  ] as const) {
    if (process.env.PRESALE_SPONSOR_FRAMEWORK_WRITE === "1") writeFileSync(path, derived);
    assert.ok(existsSync(path), `${path} is missing; generate it with PRESALE_SPONSOR_FRAMEWORK_WRITE=1`);
    assert.equal(readFileSync(path, "utf8"), derived, `${path} drifted; regenerate it with PRESALE_SPONSOR_FRAMEWORK_WRITE=1`);
  }
});
