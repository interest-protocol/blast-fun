import assert from "node:assert/strict";
import test from "node:test";

import { blastModeCovering, coverPage, onUncover } from "./mode-cover";

/** The page's time loops pause under Blast mode's lanes and catch up once when they leave (R3-60). */

test("the lanes cover the page while mounted; leaving tells each paused loop once", () => {
  assert.equal(blastModeCovering(), false);
  let caughtUp = 0;
  const off = onUncover(() => void (caughtUp += 1));
  const uncover = coverPage();
  assert.equal(blastModeCovering(), true);
  uncover();
  uncover();
  assert.equal(blastModeCovering(), false);
  assert.equal(caughtUp, 1, "once, however often the screen's cleanup runs");
  off();
  coverPage()();
  assert.equal(caughtUp, 1, "a loop that stopped listening is not told");
});
