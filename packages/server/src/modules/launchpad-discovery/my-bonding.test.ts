import { testClient } from "../../../../core/test/fixtures/lib/web-security/client-address.ts";
import assert from "node:assert/strict";
import test from "node:test";
import { MemoryRateLimiter } from "@blast/core/modules/web-security/route-limits.ts";
import { createSocialRouteKit } from "@blast/server/modules/social/route-kit/route.ts";
import type { SocialAccount } from "@blast/core/modules/social/contracts/me.ts";
import { SOCIAL_WALLET_SESSION_COOKIE } from "@blast/core/modules/social/contracts/wallet-sign-in.ts";
import { createMyBondingLaunchesRoute } from "@blast/server/modules/social/launch/discovery.ts";
import { privateRoute } from "@blast/core/modules/backend-api/private-routes.ts";
import { discoveryFixtureEngine } from "../../../test/fixtures/modules/launchpad-discovery/fixture-engine.ts";
const wallet = `0x${"a1".repeat(32)}`,
  other = `0x${"b2".repeat(32)}`;
const account: SocialAccount = {
  account_id: "10000000-0000-4000-8000-000000000001",
  kind: "new",
  callsign: "tester",
  display_name: null,
  avatar_url: null,
  x_handle: null,
  verified: false,
  onboarding: { shown: true, completed: true },
  privacy: "private",
  sharing_since_ms: null,
};
test("account discovery has its own GET/HEAD contract before the draft route", () => {
  for (const method of ["GET", "HEAD"])
    assert.equal(
      privateRoute(method, "/api/social/me/launches/discovery", "browser")?.id,
      "social.launch.discovery",
    );
});
function harness(commitment: Uint8Array | null = new Uint8Array(32).fill(7)) {
  const kit = createSocialRouteKit({
    tradingVisible: () => true,
    expectedOrigin: "https://blast.test",
    verifyAccessToken: async () => {
      throw Error("No bearer");
    },
    limiter: new MemoryRateLimiter(),
    accounts: {
      resolve: async () => account,
      resolveWallet: async () => account,
    },
    walletSessions: { live: async () => ({ address: wallet }) },
    primary: () => {
      throw Error("Read never writes");
    },
    metricSampleRate: 0,
  });
  const engine = discoveryFixtureEngine({ state: () => "serving" });
  const seen: string[] = [];
  let commitmentReads = 0;
  const route = createMyBondingLaunchesRoute({
    kit,
    wallets: async () => [wallet],
    commitment: async (id) => {
      assert.equal(id, account.account_id);
      commitmentReads++;
      return commitment;
    },
    market: {
      ...engine,
      fetch: async (input, init) => {
        seen.push(String(input));
        return engine.fetch!(input, init);
      },
    },
  });
  return { route, seen, reads: () => commitmentReads };
}
function request(query: string, authenticated = true, method = "GET") {
  return new Request(
    `https://blast.test/api/social/me/launches/discovery?${query}`,
    {
      method,
      headers: authenticated
        ? {
            cookie: `${SOCIAL_WALLET_SESSION_COOKIE}=${"s".repeat(43)}`,
            "sec-fetch-site": "same-origin",
          }
        : undefined,
    },
  );
}
test("account discovery derives commitment server-side, validates linked wallet, and never writes", async () => {
  const h = harness();
  for (const [q, auth, status] of [
    [`wallet=${wallet}`, false, 401],
    [`wallet=${other}`, true, 403],
    [`wallet=${wallet}&account_commitment=${"aa".repeat(32)}`, true, 400],
    [`wallet=${wallet}&wallet=${other}`, true, 400],
  ] as const) {
    const answer = await h.route(request(q, auth), testClient());
    assert.equal(answer.status, status);
    assert.equal(answer.headers.get("Cache-Control"), "private, no-store");
  }
  assert.equal(h.reads(), 0);
  assert.equal(h.seen.length, 0);
  const answer = await h.route(request(`wallet=${wallet}&q=pixel&limit=2`), testClient());
  assert.equal(answer.status, 200);
  assert.equal(answer.headers.get("Cache-Control"), "private, no-store");
  assert.ok(
    h.seen.some(
      (path) =>
        path.includes(`creator=${wallet}`) &&
        path.includes(`account_commitment=${"07".repeat(32)}`) &&
        !path.includes("exclude_quote="),
    ),
  );
  const body = await answer.text();
  assert.ok(
    !body.includes("07".repeat(32)),
    "commitment stays off browser wire",
  );
});
test("an account without a stored commitment uses a wallet filter; HEAD remains private", async () => {
  const h = harness(null);
  const answer = await h.route(request(`wallet=${wallet}&q=`), testClient());
  assert.equal(answer.status, 200);
  assert.ok(h.seen.some((path) => path.includes(`creator=${wallet}`)));
  assert.ok(h.seen.every((path) => !path.includes("account_commitment=")));
  const head = await h.route(request(`wallet=${wallet}&q=`, true, "HEAD"), testClient());
  assert.equal(head.status, 200);
  assert.equal(head.headers.get("Cache-Control"), "private, no-store");
  assert.equal(await head.text(), "");
});
