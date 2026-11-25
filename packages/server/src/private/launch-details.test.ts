import assert from "node:assert/strict";
import test from "node:test";

import { privateRoute } from "@blast/core/modules/backend-api/private-routes.ts";
import { launchDetailsPath } from "@blast/core/modules/launchpad-coin/transfer.ts";
import { launchDetailsHandler } from "./launch-details.ts";

const id = `0x${"1".repeat(64)}`;
const request = (value = id) =>
  new Request(`https://blast.fun/api/launchpad/launch-details/${value}`);

test("published decoration uses one validated ID read without a visitor session", async () => {
  const seen: string[] = [];
  const details = { tagline: "A small seed", cover: null, links: [] };
  const read = launchDetailsHandler(async (launchId) => {
    seen.push(launchId);
    return details;
  });
  const response = await read(request());
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "public, s-maxage=10, stale-while-revalidate=20");
  assert.equal(response.headers.get("set-cookie"), null);
  assert.deepEqual(await response.json(), { details });
  assert.deepEqual(seen, [id]);
  const invalid = await read(request("invalid"));
  assert.equal(invalid.status, 400);
  assert.equal(invalid.headers.get("cache-control"), "private, no-store");
  assert.deepEqual(seen, [id]);
});

test("an absent publication and an unavailable database remain distinct", async () => {
  assert.deepEqual(
    await (await launchDetailsHandler(async () => null)(request())).json(),
    { details: null },
  );
  const response = await launchDetailsHandler(async () => {
    throw new Error("private database diagnostic");
  })(request());
  assert.equal(response.status, 503);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.deepEqual(await response.json(), {
    error: { code: "launch_details_unavailable" },
  });
});

test("the browser and the Bonding page's server render may both read launch details", () => {
  for (const purpose of ["browser", "ssr-read"] as const)
    assert.equal(privateRoute("GET", launchDetailsPath(id), purpose)?.id, "launchpad.launch-details.read");
  assert.equal(privateRoute("HEAD", launchDetailsPath(id), "ssr-read"), null);
});
