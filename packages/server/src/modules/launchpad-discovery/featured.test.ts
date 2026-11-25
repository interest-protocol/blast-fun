import assert from "node:assert/strict";
import test from "node:test";

import { createPublicPresaleReader } from "@blast/server/modules/social/presales/public-reads.ts";
import { discoveryFixtureEngine } from "../../../test/fixtures/modules/launchpad-discovery/fixture-engine.ts";
import { handleDiscoveryRequest } from "./resource.ts";

const featured = () => new Request("https://blast.test/api/launchpad/discovery?catalog=featured");
const pin = `0x${"01".repeat(32)}`;

test("Home and Bonding tabs within the window share one composed carousel; a failure is never kept", async () => {
  let clock = 1_000;
  const share = createPublicPresaleReader(() => clock);
  let reads = 0;
  const pins = async () => { reads++; return [pin]; };
  const ask = () => handleDiscoveryRequest(featured(), discoveryFixtureEngine({ state: () => "serving" }), pins, undefined, share);

  const [a, b] = await Promise.all([ask(), ask()]);
  assert.equal(reads, 1, "concurrent askers join one read");
  assert.deepEqual(await a.json(), await b.json());
  clock += 9_999;
  assert.equal((await ask()).status, 200);
  assert.equal(reads, 1, "inside the window");
  clock += 1;
  await ask();
  assert.equal(reads, 2, "the window ends");

  const failing = createPublicPresaleReader(() => clock);
  const failed = () => handleDiscoveryRequest(featured(), discoveryFixtureEngine({ state: () => "unreachable" }), pins, undefined, failing);
  reads = 0;
  const first = await failed();
  assert.equal(first.status, 503);
  assert.equal(first.headers.get("retry-after"), "5");
  assert.equal((await failed()).status, 503);
  assert.equal(reads, 2, "the next asker reads again");
});

test("with no pins, the highlight skips a coin about the founder and shows the next closest curve", async () => {
  const engine = discoveryFixtureEngine({ state: () => "serving" });
  const highlight = async (market: typeof engine) => {
    const body = await (await handleDiscoveryRequest(featured(), market, async () => [])).json();
    return body.section.data.rows as { launchId: string }[];
  };
  const [closest] = await highlight(engine);
  assert.ok(closest);

  const renamed: typeof engine = {
    ...engine,
    fetch: async (input) => {
      const response = await engine.fetch(input);
      if (new URL(String(input)).pathname !== "/v1/bonding") return response;
      const body = await response.json();
      body.pools[0].metadata = { ...body.pools[0].metadata, name: "The Aden1yi" };
      return Response.json(body);
    },
  };
  const rows = await highlight(renamed);
  assert.equal(rows.length, 1);
  assert.notEqual(rows[0]!.launchId, closest.launchId);
});
