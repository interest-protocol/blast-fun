import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { makeSeasonZeroCardFixtures } from "../../../../../../packages/server/test/fixtures/modules/mission-control/card-renderer/fixtures.ts";
import { renderSeasonZeroCardSvg } from "@blast/server/modules/mission-control/card-renderer/svg.ts";

test("all 14 avatar rings use the exact approved card frame gradient", async () => {
  const fixtures = await makeSeasonZeroCardFixtures();
  assert.equal(fixtures.length, 14);
  for (const { record } of fixtures) {
    const card = renderSeasonZeroCardSvg(record);
    const ring = await readFile(`public/social/card-rings/${record.edition}.svg`, "utf8");
    const gradient = card.match(/<linearGradient id="lc-frame"[\s\S]*?<\/linearGradient>/)?.[0];
    assert.ok(gradient, record.edition);
    assert.ok(ring.includes(gradient), record.edition);
    assert.match(ring, /(?:fill|stroke)="url\(#lc-frame\)"/, record.edition);
    assert.match(ring, /viewBox="0 0 100 100"/);
    assert.doesNotMatch(ring, /<script|<image|http[s]?:\/\/(?!www\.w3\.org)/);
  }
});
