import { testClient } from "../../../../../core/test/fixtures/lib/web-security/client-address.ts";
import assert from "node:assert/strict";
import test from "node:test";
import { MemoryRateLimiter } from "@blast/core/modules/web-security/route-limits.ts";
import { createSocialRouteKit } from "@blast/server/modules/social/route-kit/route.ts";
import type { SocialAccount } from "@blast/core/modules/social/contracts/me.ts";
import { socialPresaleRoutes as publicRoutes } from "./shared-runtime.ts";
import { socialPresaleRoutes as viewerRoutes } from "./viewer-runtime.ts";

const ADDRESS = `0x${"ab".repeat(32)}`;
const OTHER = `0x${"cd".repeat(32)}`;
const SALE = `0x${"ef".repeat(32)}`;
const account: SocialAccount = {
  account_id: "10000000-0000-4000-8000-000000000001",
  kind: "new",
  callsign: "viewer",
  display_name: null,
  avatar_url: null,
  x_handle: null,
  verified: false,
  onboarding: { shown: true, completed: true },
  privacy: "private",
  sharing_since_ms: null,
};

for (const order of ["public-first", "viewer-first"] as const) {
  test(`presale runtime ${order} retains the viewer wallet resolver and independent public owner`, async () => {
    const slots = globalThis as typeof globalThis & Record<symbol, unknown>;
    const names = [
      "social.presale-routes",
      "social.presale-viewer-routes",
      "social.route-kit",
      "database.replica-pool",
    ];
    const saved = names.map(
      (name) =>
        [
          Symbol.for(`blast.${name}`),
          slots[Symbol.for(`blast.${name}`)],
        ] as const,
    );
    const recorded: unknown[][] = [];
    const kit = createSocialRouteKit({
      tradingVisible: () => true,
      expectedOrigin: "https://blast.fun",
      verifyAccessToken: async () => {
        throw new Error("No bearer calls");
      },
      limiter: new MemoryRateLimiter(),
      accounts: {
        resolve: async () => account,
        resolveWallet: async () => account,
      },
      walletSessions: { live: async () => ({ address: ADDRESS }) },
      primary: () => {
        throw new Error("No writes");
      },
      metricSampleRate: 0,
    });
    try {
      for (const [slot] of saved) delete slots[slot];
      slots[Symbol.for("blast.social.route-kit")] = kit;
      slots[Symbol.for("blast.database.replica-pool")] = {
        connect: async () => ({
          query: async (query: { text: string; values: unknown[] }) => {
            if (query.text.includes("SELECT mine.address"))
              return { rows: [{ address: ADDRESS }, { address: OTHER }] };
            if (query.text.includes("claim_wallet_participated"))
              recorded.push(query.values);
            return { rows: [] };
          },
          on() {},
          removeListener() {},
          release() {},
        }),
      };
      const first = order === "public-first" ? publicRoutes() : viewerRoutes();
      const second = order === "public-first" ? viewerRoutes() : publicRoutes();
      assert.notEqual(first, second);
      assert.equal(viewerRoutes(), order === "public-first" ? second : first);
      const request = () =>
        new Request("https://blast.fun/api/social/presales/viewer", {
          method: "POST",
          headers: {
            origin: "https://blast.fun",
            "sec-fetch-site": "same-origin",
            cookie: `__Host-blast_wallet=${"A".repeat(43)}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ presale_ids: [SALE] }),
        });
      const viewer = await viewerRoutes().viewer.POST(request(), testClient());
      assert.equal(viewer.status, 200, await viewer.text());
      assert.equal(recorded.length, 1);
      assert.ok(
        recorded[0]!.includes(ADDRESS),
        "signing wallet enters the actual mine SQL parameters",
      );
      recorded.length = 0;
      const publicResponse = await publicRoutes().viewer.POST(request(), testClient());
      assert.equal(publicResponse.status, 200, await publicResponse.text());
      assert.equal(recorded.length, 1);
      assert.equal(
        recorded[0]!.at(-1),
        null,
        "public factory retains its existing ambiguous-wallet fallback",
      );
    } finally {
      for (const [slot, value] of saved) {
        if (value === undefined) delete slots[slot];
        else slots[slot] = value;
      }
    }
  });
}
