import assert from "node:assert/strict";
import test from "node:test";

// Next 16.3.1 ships the matcher check under its middleware name; the docs call it unstable_doesProxyMatch.
import { unstable_doesMiddlewareMatch as doesProxyMatch } from "next/experimental/testing/server";

import { config } from "#web/proxy.ts";

const PRESALE_ID = `0x${"ab".repeat(32)}`;

test("the proxy runs on presale paths that look like files, so they carry the CSP", () => {
  for (const url of [
    "/presale",
    "/presale/x.png",
    `/presale/${PRESALE_ID}.json`,
    `/presale/${PRESALE_ID}/receipt/w.png`,
    "/presale/allowlists/new",
    "/sign-in",
    "/sign-in/a.css",
    "/settings",
    "/settings/b.js",
    "/api/presale/x.json",
    "/api/account/settings.json",
  ]) {
    assert.equal(doesProxyMatch({ config, nextConfig: {}, url }), true, url);
  }
  // Other public files still skip the proxy.
  assert.equal(doesProxyMatch({ config, nextConfig: {}, url: "/presale.png" }), false);
});
