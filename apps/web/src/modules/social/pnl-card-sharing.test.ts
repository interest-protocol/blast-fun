import { testClient } from "../../../../../packages/core/test/fixtures/lib/web-security/client-address.ts";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import sharp from "sharp";
import type { SocialAccount } from "@blast/core/modules/social/contracts/me.ts";
import { createSocialRouteKit } from "@blast/server/modules/social/route-kit/route.ts";
import { FilesystemCardImageStore } from "@blast/server/modules/mission-control/card-images/store.ts";
import { PNL_CARD_SHARE_MAX_BYTES, PNL_CARD_SHARE_PATH, isPnlCardShare } from "@blast/core/modules/social/contracts/pnl-card-sharing.ts";
import { createPnlCardShareRoute, readPnlCardShare } from "@blast/server/modules/social/pnl-card-sharing.ts";
import { pnlCardShareMetadata } from "./pnl-card-metadata.ts";

const ORIGIN = "https://www.blast.fun";
const account: SocialAccount = {
  account_id: "00000000-0000-4000-8000-000000000001", kind: "new", callsign: "nova",
  display_name: null, avatar_url: null, x_handle: null, verified: false,
  onboarding: { shown: false, completed: false }, privacy: "private", sharing_since_ms: null,
};

function kit(allowed = true, owner = account) {
  return createSocialRouteKit({
    tradingVisible: () => true,
    expectedOrigin: ORIGIN,
    verifyAccessToken: async () => ({ userId: "did:privy:nova", appId: "test", expiration: 9999999999, issuedAt: 1, issuer: "privy.io", sessionId: "test" }),
    accounts: { resolve: async () => owner, resolveWallet: async () => owner },
    limiter: { consume: async (bucket) => ({ allowed, bucket, policyVersion: 1, retryAfterSeconds: allowed ? 0 : 60 }) },
    primary: () => { throw new Error("No database work is needed to share an image."); },
  });
}

function request(bytes: Uint8Array, headers: Record<string, string> = {}) {
  return new Request(`${ORIGIN}${PNL_CARD_SHARE_PATH}`, { method: "POST", body: new Uint8Array(bytes), headers: {
    origin: ORIGIN, authorization: "Bearer test", "content-type": "image/png", ...headers,
  } });
}

test("published links preserve the exact PNG and expose the matching large-image metadata", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "blast-pnl-share-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = () => new FilesystemCardImageStore(directory);
  const png = await sharp({ create: { width: 1200, height: 675, channels: 4, background: "#ff4c98" } }).png().toBuffer();
  const publish = createPnlCardShareRoute(kit(), store);
  const response = await publish(request(png), testClient());
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  const body: unknown = await response.json();
  assert.ok(isPnlCardShare(body));
  const link = new URL(body.path, ORIGIN);
  assert.equal(link.searchParams.get("ref"), account.callsign);
  const id = link.pathname.split("/").at(-1)!;
  assert.deepEqual(await readPnlCardShare(id, store), png);
  assert.deepEqual(await (await publish(request(png), testClient())).json(), body, "retrying returns the same snapshot");
  assert.equal(await readPnlCardShare("../secret", store), null);
  assert.equal(await readPnlCardShare("0".repeat(64), store), null);
  const otherOwner = { ...account, callsign: "another_pilot" };
  const otherShare = await createPnlCardShareRoute(kit(true, otherOwner), store)(request(png), testClient());
  assert.deepEqual(await otherShare.json(), { path: `${link.pathname}?ref=another_pilot` }, "identical PNGs credit the publishing account");
  const metadata = pnlCardShareMetadata(id, account.callsign);
  assert.ok(metadata.twitter && "card" in metadata.twitter);
  assert.equal(metadata.twitter.card, "summary_large_image");
  assert.deepEqual(metadata.twitter.images, [`${ORIGIN}${link.pathname}/image`]);
  assert.equal(metadata.alternates?.canonical, link.href);
  assert.equal(metadata.openGraph?.url, link.href);
  assert.equal(isPnlCardShare({ path: link.pathname }), true, "older links remain supported");
  assert.equal(isPnlCardShare({ path: "https://evil.test" }), false);
  assert.equal(isPnlCardShare({ path: `${body.path}?redirect=evil` }), false);
  for (const code of ["irenezhao_", "_nova", "nova_"]) {
    assert.equal(isPnlCardShare({ path: `${link.pathname}?ref=${code}` }), true, "X referral codes support underscores at either edge");
  }
  for (const query of ["?ref=ab", `?ref=${"a".repeat(21)}`, "?ref=nova&ref=other", "?ref=nova&redirect=evil", "?ref=../nova"]) {
    assert.equal(isPnlCardShare({ path: `${link.pathname}${query}` }), false, query);
  }
});

test("sharing requires a session, same-origin intent, rate allowance, bounded valid pixels and storage", async () => {
  let writes = 0;
  const store = () => ({ kind: "filesystem" as const, read: async () => null, write: async () => { writes += 1; return { url: "unused" }; } });
  const route = createPnlCardShareRoute(kit(), store);
  const png = await sharp({ create: { width: 1200, height: 675, channels: 4, background: "white" } }).png().toBuffer();
  const tiny = await sharp({ create: { width: 12, height: 6, channels: 4, background: "white" } }).png().toBuffer();
  for (const [input, status] of [
    [request(png, { authorization: "" }), 401],
    [request(png, { origin: "https://evil.test" }), 403],
    [request(png, { "content-type": "image/svg+xml" }), 400],
    [request(png, { "content-length": String(PNL_CARD_SHARE_MAX_BYTES + 1) }), 413],
    [request(new Uint8Array(PNL_CARD_SHARE_MAX_BYTES + 1)), 413],
    [request(new TextEncoder().encode("not an image")), 400],
    [request(png.subarray(0, 40)), 400],
    [request(tiny), 400],
  ] as const) {
    assert.equal((await route(input, testClient())).status, status);
  }
  assert.equal((await createPnlCardShareRoute(kit(false), store)(request(png), testClient())).status, 429);
  assert.equal((await createPnlCardShareRoute(kit(), () => null)(request(png), testClient())).status, 503);
  assert.equal(writes, 0);
});
