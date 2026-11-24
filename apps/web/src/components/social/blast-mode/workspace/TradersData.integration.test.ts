import { testClient } from "../../../../../../../packages/core/test/fixtures/lib/web-security/client-address.ts";
import assert from "node:assert/strict";
import test from "node:test";
import { createTradersDiscoveryFixture } from "../../../../../test/fixtures/workspace/traders-discovery-fixture.ts";
import { discoveryOrigin } from "../../../../../test/fixtures/workspace/presales-discovery-fixture.ts";
import type { HomeTradersPage } from "@blast/core/modules/social/contracts/home.ts";

const databaseUrl = process.env.MISSION_CONTROL_TEST_DATABASE_URL;
test(
  "global Traders route keeps lifetime ranks across pages and search, excludes private/unsynced accounts, and resolves actual holdings",
  { skip: !databaseUrl },
  async () => {
    const fixture = await createTradersDiscoveryFixture(
      databaseUrl!,
      Number(process.env.TRADERS_DISCOVERY_NOW) || Date.now(),
      process.env.TRADERS_DISCOVERY_REUSE !== "1",
    );
    const read = async (query: string): Promise<HomeTradersPage> => {
      const response = await fixture.home.TRADERS(
        new Request(`${discoveryOrigin}/api/social/home/traders?${query}`, {
          headers: { "x-forwarded-for": "203.0.113.8" },
        }), testClient("203.0.113.8")
      );
      assert.equal(response.status, 200, await response.clone().text());
      return response.json();
    };
    try {
      const first = await read("limit=5");
      assert.equal(first.global_total, 125);
      assert.equal(first.traders[0]?.rank, 1);
      assert.equal(first.traders[0]?.portfolio.pnl_usd, "125.00");
      assert.equal(first.traders[0]?.portfolio.value_usd, null);
      assert.equal(first.traders[0]?.holdings?.length, 2);
      const tail = await read("page=25&limit=5&window=1h");
      assert.deepEqual(
        tail.traders.map((trader) => trader.rank),
        [121, 122, 123, 124, 125],
      );
      assert.ok(tail.traders.every((trader) => trader.events_total === 0));
      const named = await read("search=trader124");
      assert.deepEqual(
        [
          named.total,
          named.traders[0]?.rank,
          named.traders[0]?.portfolio.pnl_usd,
        ],
        [1, 125, "1.00"],
      );
      for (const search of ["trader125", "trader126", "trader127", "no-match"])
        assert.equal((await read(`search=${search}`)).total, 0);
      const response = await fixture.home.COINS(
        new Request(
          `${discoveryOrigin}/api/social/home/coins?presale=${first.traders[0]!.holdings![0]!.presale_id}`,
        ), testClient()
      );
      assert.equal(response.status, 200);
      const coins = await response.json();
      assert.ok(coins.coins[0]?.coin_type);
      assert.doesNotMatch(JSON.stringify(first), /account_id|did:privy/);
    } finally {
      await fixture.close();
    }
  },
);
