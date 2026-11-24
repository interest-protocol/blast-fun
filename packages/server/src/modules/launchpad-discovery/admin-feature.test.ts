import assert from "node:assert/strict";
import test from "node:test";

import { createAdminBondingFeatureRoute } from "@blast/server/modules/launchpad-discovery/admin-feature.ts";

const route = createAdminBondingFeatureRoute(() => {
  throw new Error("Database must not be reached");
});
const url = "https://blast.fun/api/admin/bonding-feature";
const headers = { "Content-Type": "application/json" };

test("pin requests validate IDs, booleans, size, JSON and unknown fields before using the database", async () => {
  const id = `0x${"1".repeat(64)}`;
  for (const body of [
    null,
    [],
    {},
    { launch_id: "invalid", pinned: true },
    { launch_id: id, pinned: "false" },
    { launch_id: id, pinned: true, extra: 1 },
  ]) {
    const response = await route(
      new Request(url, { method: "POST", headers, body: JSON.stringify(body) }),
    );
    assert.equal(response.status, 400);
    assert.equal(response.headers.get("cache-control"), "no-store");
  }
  assert.equal(
    (await route(new Request(url, { method: "POST", headers, body: "{" })))
      .status,
    400,
  );
  assert.equal(
    (
      await route(
        new Request(url, { method: "POST", headers, body: " ".repeat(257) }),
      )
    ).status,
    400,
  );
  assert.equal(
    (await route(new Request(`${url}?id=bad`, { headers }))).status,
    400,
  );
  assert.equal(
    (await route(new Request(`${url}?after=bad`, { headers }))).status,
    400,
  );
  assert.equal(
    (
      await route(
        new Request(url, {
          method: "POST",
          body: "{}",
        }),
      )
    ).status,
    415,
  );
});

test("a failed bonding banner list read returns a fixed no-store error, never database details", async () => {
  const response = await route(new Request(url, { headers }));
  assert.equal(response.status, 503);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.doesNotMatch(await response.text(), /Database must not be reached/);
});
