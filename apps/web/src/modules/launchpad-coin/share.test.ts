import assert from "node:assert/strict";
import { test } from "node:test";
import { coinPagePath } from "@blast/core/modules/launchpad-coin/page-key.ts";
import { coinShareMetadata } from "./share.ts";

test("only the JOEY coin uses its static square icon for the X preview", () => {
  const coinType = "0xbcd73dc8d774982c2da4e07cd1c6803ec29e128821d1ade9e9a7ce4975b44944::joey::JOEY";
  const metadata = coinShareMetadata({ coinType, name: "JOEY", symbol: "JOEY", canonical: coinPagePath(coinType) });

  assert.ok(metadata.twitter && "card" in metadata.twitter);
  assert.equal(metadata.twitter.card, "summary");
  assert.deepEqual(metadata.twitter.images, [{
    url: "https://www.blast.fun/share/joey-x.jpg",
    alt: "JOEY coin icon",
  }]);

  const otherCoinType = "0x2::joey::JOEY";
  const other = coinShareMetadata({ coinType: otherCoinType, name: "JOEY", symbol: "JOEY", canonical: coinPagePath(otherCoinType) });
  assert.ok(other.twitter && "card" in other.twitter);
  assert.equal(other.twitter.card, "summary_large_image");
});
