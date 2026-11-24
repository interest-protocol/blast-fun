import assert from "node:assert/strict";
import test from "node:test";
import { ownerCardFilename, ownerCardShareIntent } from "./owner-card-actions.ts";
test("owner card download uses the crew callsign", () => {
  assert.equal(ownerCardFilename("pilot_one"), "blast-season-zero-pilot_one.png");
});

test("Share on X includes only the card link, without text or mentions", () => {
  for (const cardUrl of [
    "https://www.blast.fun/card/crew-card",
    "https://www.blast.fun/card/crew-card?source=card&preview=1",
  ]) {
    const intent = new URL(ownerCardShareIntent(cardUrl));
    assert.equal(intent.origin + intent.pathname, "https://x.com/intent/post");
    assert.deepEqual([...intent.searchParams], [["url", cardUrl]]);
  }
});
