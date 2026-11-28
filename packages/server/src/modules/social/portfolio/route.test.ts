import assert from "node:assert/strict";
import test from "node:test";

import { MemoryRateLimiter } from "@blast/core/modules/web-security/route-limits.ts";
import { createSocialRouteKit } from "@blast/server/modules/social/route-kit/route.ts";
import { testClient } from "../../../../../core/test/fixtures/lib/web-security/client-address.ts";
import { createSocialPortfolioRoute } from "./route.ts";

test("portfolio and holdings reject a wallet the signed-in account does not own", async () => {
  const origin = "https://blast.fun";
  const accountId = "00000000-0000-4000-8000-000000000001";
  const ownedAddress = `0x${"1a".repeat(32)}`;
  const outsideAddress = `0x${"2b".repeat(32)}`;
  const unused = () => { throw new Error("The route should refuse before reading holdings."); };
  const routes = createSocialPortfolioRoute({
    kit: createSocialRouteKit({
      expectedOrigin: origin,
      verifyAccessToken: async () => ({
        appId: "test", expiration: 2000, issuedAt: 1000, issuer: "privy.io", sessionId: "test", userId: "did:privy:portfolio-test",
      }),
      accounts: {
        resolve: async () => ({
          account_id: accountId, kind: "new", callsign: "portfolio_test", display_name: null,
          avatar_url: null, x_handle: null, verified: false, onboarding: { shown: false, completed: false },
          privacy: "public", sharing_since_ms: null,
        }),
        resolveWallet: async () => null,
      },
      limiter: new MemoryRateLimiter(),
      tradingVisible: () => true,
      primary: unused,
      metricSampleRate: 0,
    }),
    wallets: {
      async wallets(id) {
        assert.equal(id, accountId);
        return [{ address: ownedAddress, kind: "embedded", linked_at_ms: 0 }];
      },
    },
    database: unused,
  });
  for (const [route, suffix] of [[routes.GET, ""], [routes.COINS, "/coins"]] as const) {
    const request = new Request(`${origin}/api/social/me/portfolio${suffix}?wallet=${outsideAddress}`, {
      headers: { Authorization: "Bearer test" },
    });
    assert.equal((await route(request, testClient())).status, 404);
  }
});
