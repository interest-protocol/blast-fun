import assert from "node:assert/strict";
import test from "node:test";

import { withCachePolicy, type ResponseClass } from "./cache-policy.ts";

const URL_ = "https://www.blast.test/api/launchpad/coins/0x2::meme::MEME";

function cacheControl(
  responseClass: ResponseClass,
  request: RequestInit = {},
  response: Response = Response.json({ ok: true }),
): string | null {
  return withCachePolicy(new Request(URL_, request), responseClass, response).headers.get("Cache-Control");
}

test("an anonymous chain-derived GET is CDN-cacheable for a bounded time", () => {
  const header = cacheControl("chain-derived");
  assert.equal(header, "public, max-age=0, s-maxage=10, stale-while-revalidate=30");
  assert.equal(cacheControl("chain-derived", { method: "HEAD" }, new Response(null)), header);
  const seconds = Object.fromEntries(
    [...(header ?? "").matchAll(/([a-z-]+)=(\d+)/g)].map(([, name, value]) => [name, Number(value)]),
  );
  assert.ok(seconds["s-maxage"] > 0 && seconds["s-maxage"] <= 30);
  assert.ok(seconds["stale-while-revalidate"] <= 60);
  assert.equal(seconds["max-age"], 0, "browsers revalidate");
});

test("social, authenticated, moderation, mutation, watcher and preflight responses are never public", () => {
  for (const responseClass of ["social", "authenticated", "moderation", "mutation", "watcher", "preflight"] as const) {
    assert.equal(cacheControl(responseClass), "private, no-store", responseClass);
  }
  for (const method of ["POST", "PUT", "PATCH", "DELETE", "OPTIONS"]) {
    assert.equal(cacheControl("chain-derived", { method }), "private, no-store", method);
  }
});

test("a chain-derived response is private when the request or response carries identity or an outage", () => {
  const cases: Array<[string, RequestInit, Response]> = [
    ["session cookie", { headers: { Cookie: "blast_member_session=abc" } }, Response.json({})],
    ["authorization", { headers: { Authorization: "Bearer token" } }, Response.json({})],
    ["sets a cookie", {}, Response.json({}, { headers: { "Set-Cookie": "a=b" } })],
    ["unavailable", {}, Response.json({ status: "unavailable" }, { status: 503 })],
    ["not found", {}, Response.json({}, { status: 404 })],
  ];
  for (const [name, request, response] of cases) {
    assert.equal(cacheControl("chain-derived", request, response), "private, no-store", name);
  }
});

test("WP3: the API gate's cookie alone keeps a chain-derived read public; any other cookie still makes it private", () => {
  const gate = "v1.1791374400.AAAAAAAAAAAAAAAAAAAAAA.BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
  const publicHeader = "public, max-age=0, s-maxage=10, stale-while-revalidate=30";
  assert.equal(cacheControl("chain-derived", { headers: { Cookie: `__Host-blast_gate=${gate}` } }), publicHeader);
  assert.equal(cacheControl("chain-derived", { headers: { Cookie: `blast_gate=${gate}` } }), publicHeader);
  assert.equal(cacheControl("chain-derived", { headers: { Cookie: ` __Host-blast_gate=${gate}; ` } }), publicHeader);
  assert.equal(cacheControl("chain-derived", { headers: { Cookie: `__Host-blast_gate=${gate}; privy-token=abc` } }), "private, no-store");
  assert.equal(cacheControl("chain-derived", { headers: { Cookie: `blast_member_session=abc; __Host-blast_gate=${gate}` } }), "private, no-store");
  assert.equal(cacheControl("chain-derived", { headers: { Cookie: "__Host-blast_gate_extra=1" } }), "private, no-store", "only the exact names");
  assert.equal(cacheControl("social", { headers: { Cookie: `__Host-blast_gate=${gate}` } }), "private, no-store");
});

test("the policy replaces a public header a sensitive handler set by mistake", () => {
  const response = Response.json({}, { headers: { "Cache-Control": "public, max-age=3600" } });
  assert.equal(cacheControl("social", {}, response), "private, no-store");
});
