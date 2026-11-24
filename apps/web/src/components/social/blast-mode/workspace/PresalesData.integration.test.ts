import { testClient } from "../../../../../../../packages/core/test/fixtures/lib/web-security/client-address.ts";
import assert from "node:assert/strict";
import test from "node:test";
import {
  createPresalesDiscoveryFixture,
  discoveryOrigin,
  discoveryId,
} from "../../../../../test/fixtures/workspace/presales-discovery-fixture.ts";
import { presaleIdsOf } from "../../coin-home/presale-ids.ts";
import {
  HOME_COINS_MAX_IDS,
  socialHomeCoinsPath,
  type HomeCoinsByIds,
} from "@blast/core/modules/social/contracts/home.ts";
import type { SocialHappeningResponse } from "@blast/core/modules/social/contracts/happening.ts";

const url = process.env.MISSION_CONTROL_TEST_DATABASE_URL;
test(
  "public happening discovery reaches bounded canonical Home rows and the existing presale detail route",
  { skip: !url },
  async () => {
    const fixture = await createPresalesDiscoveryFixture(
      url!,
      Date.now(),
      process.env.PRESALES_DISCOVERY_REUSE !== "1",
    );
    const get = (path: string) =>
      new Request(`${discoveryOrigin}${path}`, {
        headers: { "x-forwarded-for": "203.0.113.8" },
      });
    try {
      assert.equal(
        (await fixture.replica.query("SELECT current_user AS role")).rows[0]
          ?.role,
        "blast_replica",
      );
      const response = await fixture.happening.GET(
        get("/api/social/happening"), testClient()
      );
      assert.equal(response.status, 200);
      assert.match(response.headers.get("cache-control")!, /^public,/);
      const happening = (await response.json()) as SocialHappeningResponse;
      const { ids } = presaleIdsOf(happening, Date.now());
      assert.equal(ids.length, 6);
      assert.ok(ids.length <= HOME_COINS_MAX_IDS);
      assert.ok(!ids.includes(discoveryId(16)));
      const rowsResponse = await fixture.home.COINS(
        get(socialHomeCoinsPath(ids, "1h")), testClient()
      );
      assert.equal(rowsResponse.status, 200);
      const rows = (await rowsResponse.json()) as HomeCoinsByIds;
      assert.equal(rows.coins.length, 6);
      assert.equal(rows.window, "1h");
      assert.equal(
        rows.coins.find((coin) => coin.symbol === "KSTL")?.presale_id,
        discoveryId(10),
      );
      assert.deepEqual(rows.missing, []);
      const detailResponse = await fixture.presales.presale.GET(
        get(`/api/social/presales/${discoveryId(10)}`), testClient()
      );
      assert.equal(detailResponse.status, 200);
      const detail = await detailResponse.json();
      assert.equal(detail.presale.sale_token, `${discoveryId(10)}::coin::KSTL`);
      assert.equal(detail.presale.phase, "open");
      const privateResponse = await fixture.home.FOLLOWING(
        new Request(`${discoveryOrigin}/api/social/home/following`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            mode: "preview",
            window: "1h",
            presale_ids: ids,
          }),
        }), testClient()
      );
      assert.equal(privateResponse.status, 401);
    } finally {
      await fixture.close();
    }
  },
);
