import assert from "node:assert/strict";
import test from "node:test";

import { publicCardImagePath, publicCardSharePath } from "@blast/core/modules/mission-control/card-images/contracts.ts";
import { publicCardMetadata } from "./public-card-metadata.ts";

test("X and Telegram metadata use the personalized x-post asset", () => {
  const metadata = publicCardMetadata({ callsign: "pilot_one", crew: 123 }, "crew-card", 3);
  const image = `https://www.blast.fun${publicCardImagePath("crew-card", "share", 3)}`;

  assert.equal(metadata.robots, undefined);
  assert.equal(metadata.openGraph?.url, `https://www.blast.fun${publicCardSharePath("crew-card", 3)}`);
  assert.deepEqual(metadata.openGraph?.images, [{
    url: image,
    width: 1200,
    height: 675,
    alt: "BLAST recruitment card for @pilot_one, showing 3 recruits",
  }]);
  assert.deepEqual(metadata.twitter, {
    card: "summary_large_image",
    title: "BLAST // CREW #123",
    description: "@pilot_one has recruited 3 people to BLAST Mission Control.",
    site: "@blastdotfun",
    creator: "@pilot_one",
    images: [image],
  });
});
