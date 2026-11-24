import assert from "node:assert/strict";
import test from "node:test";

import { CARD_IMAGE_RETRIES, cardImageRetryDelayMs, cardImageRetrySrc } from "./card-image-retry.ts";

test("card image retries wait past Retry-After, grow, and stop after three", () => {
  const none = () => 0;
  const most = () => 0.999;
  assert.equal(CARD_IMAGE_RETRIES, 3);
  assert.deepEqual([1, 2, 3].map((failures) => cardImageRetryDelayMs(failures, none)), [5_000, 10_000, 15_000]);
  assert.deepEqual([1, 2, 3].map((failures) => cardImageRetryDelayMs(failures, most)), [5_999, 10_999, 15_999]);
  for (const failures of [0, 4, -1, 1.5, Number.NaN]) assert.equal(cardImageRetryDelayMs(failures, none), null);
});

test("each retry asks for a fresh URL and keeps the original query", () => {
  assert.equal(cardImageRetrySrc("/api/mission-control/owner/card?preview=0", 0), "/api/mission-control/owner/card?preview=0");
  assert.equal(cardImageRetrySrc("/api/mission-control/owner/card?preview=0", 2), "/api/mission-control/owner/card?preview=0&retry=2");
  assert.equal(cardImageRetrySrc("/card/abc/image", 1), "/card/abc/image?retry=1");
});
