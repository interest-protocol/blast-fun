import assert from "node:assert/strict";
import test from "node:test";

import { createAdminVerifiedMarkRoute } from "@blast/server/modules/social/admin-verified/route.ts";

const route = createAdminVerifiedMarkRoute(() => { throw new Error("Database must not be reached"); });
const url = "https://backend.test/api/admin/verified-mark";
const headers = { "Content-Type": "application/json" };
const coin = `0x${"cd".repeat(32)}::meme::MEME`;
const presale = `0x${"1".repeat(64)}`;

test("mark changes validate the kind, target, flag, reason, size and JSON before using the database", async () => {
  for (const body of [
    null, [], {},
    { kind: "coin", target: coin, verified: true },
    { kind: "coin", target: coin, verified: true, reason: "" },
    { kind: "coin", target: coin, verified: true, reason: "   " },
    { kind: "coin", target: coin, verified: true, reason: "x".repeat(501) },
    { kind: "coin", target: coin, verified: true, reason: "two\nlines" },
    { kind: "coin", target: coin, verified: "true", reason: "x" },
    { kind: "coin", target: "not-a-type", verified: true, reason: "x" },
    { kind: "presale", target: "0xabc", verified: true, reason: "x" },
    { kind: "token", target: coin, verified: true, reason: "x" },
    { kind: "presale", target: presale, verified: true, reason: "x", audited: true },
  ]) {
    const response = await route(new Request(url, { method: "POST", headers, body: JSON.stringify(body) }));
    assert.equal(response.status, 400, JSON.stringify(body));
    assert.equal(response.headers.get("cache-control"), "no-store");
  }
  assert.equal((await route(new Request(url, { method: "POST", headers, body: "{" }))).status, 400);
  assert.equal((await route(new Request(url, { method: "POST", headers, body: " ".repeat(2_049) }))).status, 400);
  assert.equal((await route(new Request(url, { method: "POST", body: "{}" }))).status, 415);
  for (const query of ["?kind=token&target=x", `?kind=coin&target=${presale}`, "?kind=presale&target=0xabc", "?target=x"]) {
    assert.equal((await route(new Request(`${url}${query}`))).status, 400, query);
  }
  const wrong = await route(new Request(url, { method: "DELETE" }));
  assert.equal(wrong.status, 405);
  assert.equal(wrong.headers.get("allow"), "GET, POST");
});

test("a failed read or change returns a fixed no-store error, never database details", async () => {
  for (const request of [
    new Request(url),
    new Request(url, { method: "POST", headers, body: JSON.stringify({ kind: "presale", target: presale, verified: true, reason: "Jose asked" }) }),
  ]) {
    const response = await route(request);
    assert.equal(response.status, 503);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.doesNotMatch(await response.text(), /Database must not be reached/);
  }
});
