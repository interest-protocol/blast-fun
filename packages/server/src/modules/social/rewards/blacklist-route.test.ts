import assert from "node:assert/strict";
import test from "node:test";
import { createAdminRewardBlacklistRoute } from "@blast/server/modules/social/rewards/blacklist-route.ts";

const url = `https://blast.fun/api/admin/coins/${encodeURIComponent(`0x${"a".repeat(64)}::coin::COIN`)}/reward-blacklist`;
const unavailable = () => {
  throw new Error("Database and scope must not be reached");
};

test("the admin blacklist route validates methods and payloads without accessing its database", async () => {
  const route = createAdminRewardBlacklistRoute({
    pool: unavailable,
    scope: unavailable,
  });
  const headers = { "content-type": "application/json" };
  const unsupported = await route(
    new Request(url, { method: "POST", headers }),
  );
  assert.equal(unsupported.status, 405);
  assert.equal(unsupported.headers.get("allow"), "GET, PUT");
  for (const body of [
    "{",
    "{}",
    JSON.stringify({ wallets: ["0x1"] }),
    JSON.stringify({ wallets: [], extra: true }),
    " ".repeat(8193),
  ]) {
    const response = await route(
      new Request(url, { method: "PUT", headers, body }),
    );
    assert.ok(response.status === 400 || response.status === 413);
    assert.equal(response.headers.get("cache-control"), "no-store");
  }
  const failed = await route(new Request(url, { headers }));
  assert.equal(failed.status, 503);
  assert.doesNotMatch(await failed.text(), /must not be reached/);
});

test("coin picker validates pagination before database access", async () => {
  const route = createAdminRewardBlacklistRoute({
    pool: unavailable,
    scope: unavailable,
  });
  const url = "https://blast.fun/api/admin/reward-coins";
  assert.equal(
    (await route(new Request(`${url}?after=invalid`))).status,
    400,
  );
  assert.equal(
    (await route(new Request(`${url}?q=${"a".repeat(2049)}`)))
      .status,
    400,
  );
  assert.equal(
    (await route(new Request(url, { method: "PUT" }))).status,
    405,
  );
  assert.equal((await route(new Request(url))).status, 503);
});
