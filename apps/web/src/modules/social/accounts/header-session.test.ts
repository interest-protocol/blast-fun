import { testClient } from "../../../../../../packages/core/test/fixtures/lib/web-security/client-address.ts";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";
import { SignJWT } from "jose";

import { createPrivyTokenVerifier } from "@blast/core/lib/privy-adapter/token-verifier.ts";
import type { SocialAccount } from "@blast/core/modules/social/contracts/me.ts";
import { createSocialRouteKit } from "@blast/server/modules/social/route-kit/route.ts";
import { hasPrivySessionCookie, readHeaderSession } from "./header-session.ts";
import { createSocialMeRoute } from "@blast/server/modules/social/accounts/me-route.ts";

const origin = "https://blast.fun";
const appId = "header-session-test";
const did = "did:privy:pilot";
const walletToken = "w".repeat(43);
const keys = generateKeyPairSync("ec", { namedCurve: "P-256" });
const verificationKey = keys.publicKey.export({ format: "pem", type: "spki" }).toString();
const account: SocialAccount = {
  account_id: "pilot", kind: "new", callsign: "pilot", display_name: "Pilot", avatar_url: null,
  x_handle: null, verified: false, onboarding: { shown: true, completed: true }, privacy: "private",
  sharing_since_ms: null, 
};
const walletAccount = { ...account, account_id: "wallet-pilot", callsign: "wallet_pilot" };

function token(claims: Record<string, unknown> = {}, key = keys.privateKey) {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ sid: "session", sub: did, iss: "privy.io", aud: appId, iat: now - 60, exp: now + 3600, ...claims })
    .setProtectedHeader({ alg: "ES256" }).sign(key);
}

function fixture() {
  const calls: string[] = [];
  const kit = createSocialRouteKit({
    tradingVisible: () => true,
    expectedOrigin: origin,
    verifyAccessToken: createPrivyTokenVerifier({ appId, verificationKey }),
    accounts: {
      async resolve() { throw new Error("Me must not perform a generic account read"); },
      async resolveWallet() { throw new Error("Me must not perform a generic wallet read"); },
    },
    walletSessions: { async live(value) { calls.push(`session:${value}`); return value === walletToken ? { address: "0xwallet" } : null; } },
    limiter: { async consume(bucket) { return { allowed: true, bucket, policyVersion: 1, retryAfterSeconds: 0 }; } },
    primary() { throw new Error("Unexpected database write"); },
    metricSampleRate: 0,
  });
  const me = createSocialMeRoute({ kit, accounts: {
    async resolveWithWallets(value) { calls.push(`privy:${value}`); return { ...account, wallets: [] }; },
    async resolveWalletWithWallets(value) { calls.push(`wallet:${value}`); return { ...walletAccount, wallets: [] }; },
  } });
  const read = (cookie: string, privy = true) => readHeaderSession(new Request(`${origin}/api/social/me`, {
    headers: { cookie, "sec-fetch-site": "none", "x-forwarded-for": "198.51.100.2", authorization: "Bearer untrusted-page-header" },
  }), (request) => {
    // The verified SSR receiver, rather than the frontend, supplies trusted metadata.
    const headers = new Headers(request.headers);
    headers.set("origin", origin);
    headers.set("sec-fetch-site", "same-origin");
    return me.GET(new Request(request, { headers }), testClient());
  }, privy);
  return { read, calls };
}

test("SSR validates the Privy cookie cryptographically and prefers it to a wallet session", async () => {
  const f = fixture();
  const jwt = await token();
  const result = await f.read(`privy-token=${jwt}; __Host-blast_wallet=${walletToken}`);
  assert.equal(result?.signedIn, true);
  assert.equal(result?.viewer?.accountId, account.account_id);
  assert.equal(result?.viewerLoading, false);
  assert.deepEqual(f.calls, [`privy:${did}`]);
  assert.doesNotMatch(JSON.stringify(result), new RegExp(`${jwt}|${walletToken}|did:privy|sessionId|wallets`));
});

test("SSR reads the selected Slush profile when both sessions remain signed in", async () => {
  const f = fixture();
  const both = `privy-token=${await token()}; __Host-blast_wallet=${walletToken}`;
  const slush = await f.read(`${both}; blast_active_account=wallet`);
  assert.equal(slush?.viewer?.accountId, walletAccount.account_id);
  assert.deepEqual(f.calls, [`session:${walletToken}`, "wallet:0xwallet"]);
  assert.equal((await f.read(`${both}; blast_active_account=privy`))?.viewer?.accountId, account.account_id);
  assert.equal(await f.read("blast_active_account=wallet"), null);
  assert.equal(await f.read(`__Host-blast_wallet=${walletToken}; blast_active_account=privy`), null);
});

test("SSR validates direct wallet sessions on a hard refresh and keeps answers request-local", async () => {
  const f = fixture();
  const wallet = await f.read(`__Host-blast_wallet=${walletToken}`);
  assert.equal(wallet?.viewer?.accountId, walletAccount.account_id);
  assert.equal(wallet?.signedIn, true);
  assert.deepEqual(f.calls, [`session:${walletToken}`, "wallet:0xwallet"]);
  assert.equal((await f.read(`privy-token=${await token()}`))?.viewer?.accountId, account.account_id);
  const refused = await f.read(`__Host-blast_wallet=${"r".repeat(43)}`, false);
  assert.equal(refused?.signedIn, false, "expired/revoked sessions never reuse another request's answer");
});

test("expired, forged, wrong-app and wrong-issuer Privy cookies never authenticate or fall back to a wallet", async () => {
  const foreignKey = generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey;
  const bad = [await token({ exp: 1 }), await token({ aud: "other-app" }), await token({ iss: "other-issuer" }), await token({}, foreignKey)];
  for (const jwt of bad) {
    const f = fixture();
    assert.equal(await f.read(`privy-token=${jwt}; __Host-blast_wallet=${walletToken}`), null);
    assert.deepEqual(f.calls, []);
  }
});

test("missing, refreshable, malformed, duplicated and hint-only cookies stay unresolved for Privy", async () => {
  const f = fixture();
  for (const cookie of ["", "privy-session=t", `privy-session=t; __Host-blast_wallet=${walletToken}`, "__Host-blast_wallet_hint=1", "privy-token=", "privy-token=not-a-jwt", "privy-token=a.b.c; privy-token=d.e.f", `privy-token=${"x".repeat(8193)}`]) {
    assert.equal(await f.read(cookie), null, cookie.slice(0, 100));
  }
  assert.equal((await f.read(`blast_active_account=privy; __Host-blast_wallet=${walletToken}`, false))?.signedIn, false, "without Privy, an explicit Privy selection is signed out");
  assert.deepEqual(f.calls, []);
  assert.equal((await f.read("", false))?.signedIn, false, "without Privy, no credentials is signed out");
});

test("provider/database failures, throttling and missing accounts stay unresolved", async () => {
  const request = new Request(`${origin}/api/social/me`, { headers: { cookie: `__Host-blast_wallet=${walletToken}` } });
  for (const status of [401, 429, 503]) {
    assert.equal(await readHeaderSession(request, async () => new Response(null, { status }), true), null);
  }
  assert.equal(await readHeaderSession(request, async () => { throw new Error("Database unavailable"); }, true), null);
  assert.equal(await readHeaderSession(request, async () => Response.json({ account: null }), true), null);
});

test("a stalled header session read is canceled and stays unresolved", { timeout: 5_000 }, async () => {
  const request = new Request(`${origin}/api/social/me`, {
    headers: { cookie: `__Host-blast_wallet=${walletToken}` },
  });
  let abortReason: unknown;
  const session = await readHeaderSession(request, ({ signal }) => new Promise<never>((_, reject) => {
    signal.addEventListener("abort", () => {
      abortReason = signal.reason;
      reject(abortReason);
    }, { once: true });
  }), true);

  assert.equal(session, null);
  assert.ok(abortReason instanceof DOMException);
  assert.equal(abortReason.name, "TimeoutError");
});

test("Me denies the verified caller's quota before either compound account reader", async () => {
  const calls: string[] = [];
  const kit = createSocialRouteKit({
    tradingVisible: () => true,
    expectedOrigin: origin,
    verifyAccessToken: createPrivyTokenVerifier({ appId, verificationKey }),
    accounts: {
      async resolve() { throw new Error("Unexpected generic resolution"); },
      async resolveWallet() { throw new Error("Unexpected generic wallet resolution"); },
    },
    walletSessions: { async live() { return { address: "0xwallet" }; } },
    limiter: { async consume(bucket, subject) {
      calls.push(`${bucket}:${subject?.accountId}`);
      return { allowed: false, bucket, policyVersion: 1, retryAfterSeconds: 60 };
    } },
    primary() { throw new Error("Unexpected database write"); },
    metricSampleRate: 0,
  });
  const me = createSocialMeRoute({ kit, accounts: {
    async resolveWithWallets() { throw new Error("Privy account read must follow quota"); },
    async resolveWalletWithWallets() { throw new Error("Wallet account read must follow quota"); },
  } });
  const requests = [
    new Request(`${origin}/api/social/me`, { headers: { authorization: `Bearer ${await token()}` } }),
    new Request(`${origin}/api/social/me`, { headers: { cookie: `__Host-blast_wallet=${walletToken}`, "sec-fetch-site": "same-origin" } }),
  ];
  for (const request of requests) {
    const response = await me.GET(request, testClient());
    assert.equal(response.status, 429);
    assert.equal(response.headers.get("cache-control"), "private, no-store");
    assert.equal(response.headers.has("set-cookie"), false);
  }
  assert.deepEqual(calls, [`social_me_read:${did}`, "social_me_read:sui:0xwallet"]);
});

test("a Privy access or session cookie, and only that, starts Privy's SDK with the page", () => {
  const has = (cookie?: string) => hasPrivySessionCookie(new Headers(cookie === undefined ? {} : { cookie }));
  assert.equal(has(), false);
  assert.equal(has("theme=dark"), false);
  assert.equal(has("privy-token=a.b.c"), true);
  assert.equal(has("theme=dark; privy-session=t"), true);
  assert.equal(has("theme=dark;privy-token=a.b.c"), true);
  assert.equal(has("privy-caid=x; not-privy-token=y; privy-tokens=z"), false);
});
