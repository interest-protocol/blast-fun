import assert from "node:assert/strict";
import test from "node:test";

import { analyticsUrl } from "./analytics-url.ts";

test("custom events redact dynamic paths, userinfo and OAuth/hash context even after navigation", () => {
  for (const path of ["/presale/0xabc", "/presale/0xabc/receipt/0xwallet", "/%30%78wallet/anything", "/p/private-post"]) {
    assert.deepEqual(analyticsUrl({ type: "event", url: `https://name:password@blast.test${path}?code=secret#token`, payload: "kept" }), {
      type: "event", url: "https://blast.test/_events", payload: "kept",
    });
  }
});

test("pageview and SpeedInsights keep their existing pathname semantics without query/hash", () => {
  assert.deepEqual(analyticsUrl({ type: "pageview", url: "https://blast.test/feed?tab=new#latest" }), {
    type: "pageview", url: "https://blast.test/feed",
  });
  assert.deepEqual(analyticsUrl({ url: "https://blast.test/presale/0xabc?token=private#top" }), {
    url: "https://blast.test/presale/0xabc",
  });
});

test("malformed and non-http analytics URLs are dropped without affecting callers", () => {
  for (const url of ["private", "javascript:alert(1)", "data:text/plain,secret", "https://"]) {
    assert.equal(analyticsUrl({ type: "event", url }), null);
  }
});
