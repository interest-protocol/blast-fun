import { testClient } from "../../../../../core/test/fixtures/lib/web-security/client-address.ts";
import assert from "node:assert/strict";
import test from "node:test";

import { MemoryRateLimiter } from "@blast/core/modules/web-security/route-limits.ts";
import type { SocialAccount } from "@blast/core/modules/social/contracts/me.ts";
import { createSocialRouteKit } from "../route-kit/route.ts";
import { createSocialNotificationRoutes } from "./route.ts";
import { decodeNotificationCursor, encodeNotificationCursor } from "./store.ts";

const ORIGIN = "https://blast.fun";
const MAX_ID = "9223372036854775807";
const OVERFLOW_IDS = ["9223372036854775808", "9999999999999999999"];
const ACCOUNT: SocialAccount = {
  account_id: "00000000-0000-4000-8000-000000000001",
  kind: "new",
  callsign: "notifications_test",
  display_name: null,
  avatar_url: null,
  x_handle: null,
  verified: false,
  onboarding: { shown: false, completed: false },
  privacy: "private",
  sharing_since_ms: null,
};

test("notification cursors accept signed-BIGINT IDs and refuse SQL overflow", () => {
  const position = { occurredAtMs: 1_790_000_000_000, id: MAX_ID };
  assert.deepEqual(decodeNotificationCursor(encodeNotificationCursor(position)), position);
  for (const id of OVERFLOW_IDS) {
    const cursor = encodeNotificationCursor({ ...position, id });
    assert.throws(() => decodeNotificationCursor(cursor), { code: "invalid_parameter" }, id);
  }
});

test("overflow IDs return the notification route's 400 or 404 before accessing PostgreSQL", async () => {
  let databaseCalls = 0;
  const kit = createSocialRouteKit({
    tradingVisible: () => true,
    expectedOrigin: ORIGIN,
    verifyAccessToken: async () => ({
      appId: "notifications-test", expiration: 2_000_000_000, issuedAt: 1_000_000_000,
      issuer: "privy.io", sessionId: "session", userId: "did:privy:notifications-test",
    }),
    limiter: new MemoryRateLimiter(),
    accounts: { resolve: async () => ACCOUNT, resolveWallet: async () => ACCOUNT },
    primary: () => {
      databaseCalls += 1;
      throw new Error("An invalid notification ID reached PostgreSQL.");
    },
    metricSampleRate: 0,
  });
  const routes = createSocialNotificationRoutes({ kit });
  const headers = { authorization: "Bearer verified-test-session", origin: ORIGIN };
  for (const id of OVERFLOW_IDS) {
    const read = await routes.markRead.POST(new Request(`${ORIGIN}/api/social/me/notifications/${id}/read`, { method: "POST", headers }), testClient());
    assert.equal(read.status, 404, id);
    assert.equal((await read.json()).error.code, "not_found");
    const cursor = encodeNotificationCursor({ occurredAtMs: 1_790_000_000_000, id });
    const page = await routes.page.GET(new Request(`${ORIGIN}/api/social/me/notifications?cursor=${cursor}`, { headers }), testClient());
    assert.equal(page.status, 400, id);
    assert.equal((await page.json()).error.code, "invalid_parameter");
  }
  const path = `${ORIGIN}/api/social/me/notifications/${OVERFLOW_IDS[0]}/read`;
  assert.equal((await routes.markRead.POST(new Request(path, { method: "POST" }), testClient())).status, 401);
  assert.equal((await routes.markRead.POST(new Request(path, { method: "POST", headers, body: "unexpected" }), testClient())).status, 400);
  assert.equal(databaseCalls, 0);
});
