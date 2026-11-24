import { testClient } from "../../../../../core/test/fixtures/lib/web-security/client-address.ts";
import assert from "node:assert/strict";
import test from "node:test";
import type { Pool, QueryResultRow } from "pg";
import { SOCIAL_CONFIG_DEFAULTS } from "@blast/core/modules/social/contracts/config.ts";
import type { ReadableDatabase } from "@blast/core/modules/database/transaction.ts";
import { createSocialRouteKit } from "@blast/server/modules/social/route-kit/route.ts";
import { createSocialProfileRoutes } from "./route.ts";

test("random valid profile misses perform primary reads without starting write transactions", async () => {
  const queries: string[] = [];
  const database: ReadableDatabase = {
    async read<Row extends QueryResultRow>(sql: string) {
      queries.push(sql);
      return { command: "SELECT", rowCount: 0, oid: 0, fields: [], rows: [] as Row[] };
    },
  };
  const unreachable = async (): Promise<never> => { assert.fail("public miss opened an account or write transaction"); };
  const kit = createSocialRouteKit({
    tradingVisible: () => true,
    expectedOrigin: "https://blast.example", verifyAccessToken: unreachable,
    limiter: { consume: async (bucket) => ({ allowed: true, bucket, policyVersion: 1, retryAfterSeconds: 0 }) },
    accounts: { resolve: unreachable, resolveWallet: unreachable },
    primary: () => ({ connect: unreachable }) as unknown as Pool,
  });
  const routes = createSocialProfileRoutes({ kit, database: () => database, primary: () => database,
    config: async () => SOCIAL_CONFIG_DEFAULTS });
  for (const callsign of ["absent_one", "absent_two"]) {
    const response = await routes.profile.GET(new Request(`https://blast.example/api/social/profiles/${callsign}`), testClient());
    assert.equal(response.status, 404);
  }
  assert.equal(queries.filter((sql) => sql.includes("SELECT EXISTS")).length, 2);
  assert.equal(queries.some((sql) => /INSERT|BEGIN/.test(sql)), false);
});
