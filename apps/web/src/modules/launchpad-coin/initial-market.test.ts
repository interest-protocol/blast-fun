import assert from "node:assert/strict";
import test from "node:test";

import { wantsInitialMarket } from "./initial-market.ts";

test("initial markup and coin navigation seed the market, while refreshes and prefetches skip it", () => {
  const coin = "/coin/0x2::example::TOKEN";
  const referer = `https://www.blast.fun${coin.replaceAll(":", "%3A")}?range=all`;
  assert.equal(wantsInitialMarket(new Headers({ referer }), coin), true);
  assert.equal(wantsInitialMarket(new Headers({ rsc: "1", referer }), coin), false);
  assert.equal(wantsInitialMarket(new Headers({ rsc: "1", referer: "https://www.blast.fun/" }), coin), true);
  assert.equal(wantsInitialMarket(new Headers({ "next-router-prefetch": "1" }), coin), false);
  assert.equal(wantsInitialMarket(new Headers({ "next-router-segment-prefetch": "/_tree" }), coin), false);
  assert.equal(wantsInitialMarket(new Headers({ "sec-purpose": "prefetch;prerender" }), coin), false);
});
