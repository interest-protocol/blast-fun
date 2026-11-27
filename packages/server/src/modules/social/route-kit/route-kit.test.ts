import { testClient } from "../../../../../core/test/fixtures/lib/web-security/client-address.ts";
import assert from "node:assert/strict";
import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { copyFile, rm } from "node:fs/promises";
import test from "node:test";

import type { Pool } from "pg";

import { PrivyAdapterError } from "@blast/core/lib/privy-adapter/errors.ts";
import { createPrivyTokenVerifier } from "@blast/core/lib/privy-adapter/token-verifier.ts";
import { isTradingVisible } from "@blast/core/lib/social-flag.ts";
import { DEFAULT_RATE_POLICIES, type RateBucket, type RateLimitDecision, type RateLimitPort, type RateLimitSubject } from "@blast/core/lib/web-security/rate-limits.ts";
import { MemoryRateLimiter } from "@blast/core/modules/web-security/route-limits.ts";
import { SOCIAL_ERRORS, type SocialErrorCode } from "@blast/core/modules/social/contracts/errors.ts";
import type { SocialAccount } from "@blast/core/modules/social/contracts/me.ts";
import { createSocialValidator } from "@blast/core/modules/social/contracts/validate.ts";
import { SocialRouteError, toSocialRouteError } from "@blast/core/modules/social/route-kit/errors.ts";
import {
  createSocialRouteKit,
  readSocialJson,
  SOCIAL_BODY_LIMIT_BYTES,
  SOCIAL_PUBLIC_CACHE_CONTROL,
  SOCIAL_PUBLIC_FRESH_CACHE_CONTROL,
  type SocialRouteKitDependencies,
} from "./route.ts";

/**
 * Social-feed T-002: the social route kit (REQ-027) as Request -> Response
 * handlers with a real Privy token verifier over a fixture key, an in-memory
 * rate-limit port and an in-memory account loader.
 */

const ORIGIN = "https://blast.fun";
const APP_ID = "social-kit-app";
const NOW = Math.floor(Date.now() / 1_000);
const DID = "did:privy:social-kit-caller";
const WALLET = `0x${"ab".repeat(32)}`;
const OTHER_WALLET = `0x${"cd".repeat(32)}`;
const SESSION = "s".repeat(43);
const OTHER_SESSION = "o".repeat(43);
const STALE_SESSION = "x".repeat(43);
const SESSION_ID = "00000000-0000-4000-8000-000000000002";
const OTHER_SESSION_ID = "00000000-0000-4000-8000-000000000003";
const keys = generateKeyPairSync("ec", { namedCurve: "P-256" });
const verificationKey = keys.publicKey.export({ format: "pem", type: "spki" }).toString();
const validator = createSocialValidator();

function token(claims: Record<string, unknown> = {}): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const header = encode({ alg: "ES256", typ: "JWT" });
  const payload = encode({ aud: APP_ID, exp: NOW + 3_600, iat: NOW - 60, iss: "privy.io", sid: "s-1", sub: DID, ...claims });
  const signature = sign("sha256", Buffer.from(`${header}.${payload}`), { dsaEncoding: "ieee-p1363", key: keys.privateKey });
  return `${header}.${payload}.${signature.toString("base64url")}`;
}

const ACCOUNT: SocialAccount = {
  account_id: "00000000-0000-4000-8000-000000000001",
  kind: "new",
  callsign: "kit_pilot",
  display_name: null,
  avatar_url: null,
  x_handle: null,
  verified: false,
  onboarding: { shown: false, completed: false },
  privacy: "public",
  sharing_since_ms: null,
};

class MemoryLimiter implements RateLimitPort {
  readonly calls: { bucket: RateBucket; subject: RateLimitSubject }[] = [];
  refuse: ((subject: RateLimitSubject) => boolean) | null = null;
  async consume(bucket: RateBucket, subject: RateLimitSubject): Promise<RateLimitDecision> {
    this.calls.push({ bucket, subject });
    const refused = this.refuse?.(subject) ?? false;
    return { allowed: !refused, bucket, policyVersion: 1, retryAfterSeconds: refused ? 42 : 0 };
  }
}

function kit(overrides: Partial<SocialRouteKitDependencies> = {}) {
  const limiter = new MemoryLimiter();
  const resolved: string[] = [];
  let id = 0;
  const dependencies: SocialRouteKitDependencies = {
    expectedOrigin: ORIGIN,
    verifyAccessToken: createPrivyTokenVerifier({ appId: APP_ID, verificationKey }),
    limiter,
    accounts: {
      async resolve(did) {
        resolved.push(did);
        return did === DID ? ACCOUNT : null;
      },
      async resolveWallet(address, sessionId) {
        resolved.push(`sui:${address}`);
        return address === WALLET && sessionId === SESSION_ID ? ACCOUNT : null;
      },
    },
    walletSessions: {
      async live(token) {
        if (token === SESSION) return { address: WALLET, sessionId: SESSION_ID };
        if (token === OTHER_SESSION) return { address: OTHER_WALLET, sessionId: OTHER_SESSION_ID };
        return null;
      },
    },
    primary: () => {
      throw new Error("no primary in this test");
    },
    createRequestId: () => `req-${++id}`,
    tradingVisible: () => true,
    ...overrides,
  };
  return { kit: createSocialRouteKit(dependencies), limiter, resolved };
}

const request = (headers: Record<string, string> = {}, init: RequestInit = {}) =>
  new Request(`${ORIGIN}/api/social/test`, { ...init, headers });
const signedIn = (claims?: Record<string, unknown>) => ({ authorization: `Bearer ${token(claims)}` });

async function assertError(response: Response, code: SocialErrorCode, cacheControl = "no-store"): Promise<void> {
  const body = (await response.json()) as { error: { code: string; message: string } };
  assert.equal(body.error.code, code, JSON.stringify(body));
  assert.equal(response.status, SOCIAL_ERRORS[code].status);
  assert.deepEqual(validator.validate("error", body).errors, []);
  assert.equal(response.headers.get("cache-control"), cacheControl);
  assert.match(response.headers.get("x-request-id") ?? "", /^req-\d+$/);
  assert.equal(response.headers.has("retry-after"), SOCIAL_ERRORS[code].retryAfter, code);
}

test("auth `account`: a missing, malformed, badly signed or expired token is 401 before the handler", async () => {
  const { kit: social } = kit();
  let handled = 0;
  const route = social.route({ name: "GET /api/social/test", auth: "account" }, async (context) => {
    handled += 1;
    return context.json({ ok: true });
  });
  const other = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const forged = (() => {
    const [header, payload] = token().split(".");
    const signature = sign("sha256", Buffer.from(`${header}.${payload}`), { dsaEncoding: "ieee-p1363", key: other.privateKey });
    return `${header}.${payload}.${signature.toString("base64url")}`;
  })();
  for (const headers of [
    {},
    { authorization: "Bearer" },
    { authorization: `Basic ${token()}` },
    { authorization: "Bearer not-a-jwt" },
    { authorization: `Bearer ${forged}` },
    signedIn({ exp: NOW - 10, iat: NOW - 3_600 }),
    signedIn({ aud: "another-app" }),
  ]) {
    await assertError(await route(request(headers), testClient()), "unauthorized");
  }
  assert.equal(handled, 0);
  const ok = await route(request(signedIn()), testClient());
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get("cache-control"), "no-store");
  assert.ok(ok.headers.get("x-request-id"));
});

test("a `private` route answers private, no-store on success and on every error", async () => {
  const { kit: social } = kit();
  const route = social.route({ name: "GET /api/social/test", auth: "account", cache: "private" }, async (context) =>
    context.json({ ok: true }));
  const ok = await route(request(signedIn()), testClient());
  assert.equal(ok.headers.get("cache-control"), "private, no-store");
  await assertError(await route(request(), testClient()), "unauthorized", "private, no-store");
  await assertError(await route(request({ ...signedIn(), origin: "https://evil.example" }), testClient()), "origin_invalid", "private, no-store");
});

test("T-007: a `public` route shares only its 200; errors stay no-store; it may not read the caller", async () => {
  const { kit: social, limiter } = kit();
  let fail: SocialRouteError | null = null;
  const route = social.route({ name: "GET /api/social/test", auth: "none", bucket: "social_read", cache: "public" }, async (context) => {
    if (fail) throw fail;
    return context.json({ ok: true });
  });
  const ok = await route(request(signedIn()), testClient());
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get("cache-control"), SOCIAL_PUBLIC_CACHE_CONTROL);
  assert.equal(SOCIAL_PUBLIC_CACHE_CONTROL, "public, s-maxage=10, stale-while-revalidate=20");
  fail = new SocialRouteError("invalid_parameter");
  await assertError(await route(request(), testClient()), "invalid_parameter");
  fail = new SocialRouteError("service_unavailable");
  await assertError(await route(request(), testClient()), "service_unavailable");
  fail = null;
  limiter.refuse = () => true;
  await assertError(await route(request(), testClient()), "rate_limited");
  await assertError(await route(request({ origin: "https://evil.example" }), testClient()), "origin_invalid");
  const handler = async () => new Response();
  assert.throws(() => social.route({ name: "x", auth: "optional", cache: "public" }, handler), /must not read the caller/);
  assert.throws(() => social.route({ name: "x", auth: "account", cache: "public" }, handler), /must not read the caller/);
});

test("OA-30: a `public-fresh` route shares its 200 for 10 s and never stale; errors stay no-store; it may not read the caller", async () => {
  const { kit: social } = kit();
  let fail: SocialRouteError | null = null;
  const route = social.route({ name: "GET /api/social/test", auth: "none", bucket: "social_read", cache: "public-fresh" }, async (context) => {
    if (fail) throw fail;
    return context.json({ ok: true });
  });
  const ok = await route(request(signedIn()), testClient());
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get("cache-control"), SOCIAL_PUBLIC_FRESH_CACHE_CONTROL);
  assert.equal(SOCIAL_PUBLIC_FRESH_CACHE_CONTROL, "public, s-maxage=10");
  fail = new SocialRouteError("portfolio_private");
  await assertError(await route(request(), testClient()), "portfolio_private");
  fail = new SocialRouteError("service_unavailable");
  await assertError(await route(request(), testClient()), "service_unavailable");
  const handler = async () => new Response();
  assert.throws(() => social.route({ name: "x", auth: "optional", cache: "public-fresh" }, handler), /must not read the caller/);
  assert.throws(() => social.route({ name: "x", auth: "account", cache: "public-fresh" }, handler), /must not read the caller/);
});

test("OA-7: the real trading flag is read once per request; \"team\" shows trades to everyone since launch", async (t) => {
  const previous = process.env.BLAST_TRADING_ENABLED;
  t.after(() => {
    if (previous === undefined) delete process.env.BLAST_TRADING_ENABLED;
    else process.env.BLAST_TRADING_ENABLED = previous;
  });
  let reads = 0;
  const { kit: social } = kit({
    tradingVisible() {
      reads++;
      return isTradingVisible();
    },
  });
  const seen = social.route({ name: "GET /api/social/test", auth: "none", bucket: "social_read" }, async (context) =>
    context.json({ trading: context.trading, hiddenKinds: context.hiddenKinds }));
  const read = async (headers: Record<string, string> = {}) => (await seen(request(headers), testClient())).json();
  const hidden = { trading: false, hiddenKinds: ["trade_buy", "trade_sell"] };
  const shown = { trading: true, hiddenKinds: [] };

  delete process.env.BLAST_TRADING_ENABLED;
  assert.deepEqual(await read(), hidden);
  process.env.BLAST_TRADING_ENABLED = "TRUE";
  assert.deepEqual(await read(), hidden);
  process.env.BLAST_TRADING_ENABLED = "true";
  assert.deepEqual(await read(), shown);
  process.env.BLAST_TRADING_ENABLED = "team";
  assert.deepEqual(await read(), shown);
  assert.equal(reads, 4);
});

test("account modes: resolve gives the account or null; required refuses a caller without one", async () => {
  const { kit: social, resolved } = kit();
  const seen: (SocialAccount | null)[] = [];
  const resolve = social.route({ name: "GET /api/social/me", auth: "account", account: "resolve" }, async (context) => {
    seen.push(context.account);
    return context.json({});
  });
  const required = social.route({ name: "POST /api/social/follows", auth: "account", account: "required" }, async (context) =>
    context.json({ account_id: context.account?.account_id }));
  assert.equal((await resolve(request(signedIn()), testClient())).status, 200);
  assert.equal((await resolve(request(signedIn({ sub: "did:privy:nobody" })), testClient())).status, 200);
  assert.deepEqual(seen, [ACCOUNT, null]);
  assert.deepEqual(await (await required(request(signedIn()), testClient())).json(), { account_id: ACCOUNT.account_id });
  await assertError(await required(request(signedIn({ sub: "did:privy:nobody" })), testClient()), "account_required");
  assert.deepEqual(resolved, [DID, "did:privy:nobody", DID, "did:privy:nobody"]);
  // A route that does not ask never loads the account.
  const none = social.route({ name: "GET /api/social/feed", auth: "optional" }, async (context) => context.json({ account: context.account }));
  assert.deepEqual(await (await none(request(signedIn()), testClient())).json(), { account: null });
  assert.equal(resolved.length, 4);
});

test("specs that could not keep their promise are refused at construction", () => {
  const { kit: social } = kit();
  const handler = async () => new Response();
  assert.throws(() => social.route({ name: "x", auth: "none", account: "resolve" }, handler), /must read the caller/);
  assert.throws(() => social.route({ name: "x", auth: "optional", bucket: "social_follow" }, handler), /must require one/);
  assert.throws(() => social.route({ name: "x", auth: "none", bucket: "social_account_create" }, handler), /must require one/);
  social.route({ name: "x", auth: "none", bucket: "social_read" }, handler);
});

test("rate limits: buckets count per DID or IP, social_account_create counts both, a full one is 429 with Retry-After", async () => {
  const { kit: social, limiter } = kit();
  const follow = social.route({ name: "POST /api/social/follows", auth: "account", bucket: "social_follow" }, async (context) =>
    context.json({}));
  const read = social.route({ name: "GET /api/social/feed", auth: "optional", bucket: "social_read" }, async (context) =>
    context.json({}));
  const create = social.route({ name: "POST /api/social/accounts", auth: "account", bucket: "social_account_create" }, async (context) =>
    context.json({}));
  const ip = { "x-forwarded-for": "203.0.113.9" };
  await follow(request({ ...signedIn(), ...ip }), testClient("203.0.113.9"));
  await read(request(ip), testClient("203.0.113.9"));
  await create(request({ ...signedIn(), ...ip }), testClient("203.0.113.9"));
  assert.deepEqual(limiter.calls, [
    { bucket: "social_follow", subject: { accountId: DID } },
    { bucket: "social_read", subject: { ip: "203.0.113.9" } },
    { bucket: "social_account_create", subject: { ip: "203.0.113.9" } },
    { bucket: "social_account_create", subject: { accountId: DID } },
  ]);

  // Either part of social_account_create being full refuses the request.
  limiter.refuse = (subject) => subject.accountId === DID;
  const refused = await create(request({ ...signedIn(), ...ip }), testClient("203.0.113.9"));
  assert.equal(refused.headers.get("retry-after"), "42");
  await assertError(refused, "rate_limited");
  limiter.refuse = (subject) => subject.ip === "203.0.113.9";
  await assertError(await create(request({ ...signedIn(), ...ip }), testClient("203.0.113.9")), "rate_limited");
  await assertError(await read(request(ip), testClient("203.0.113.9")), "rate_limited");

  // A route-level budget through context.consume.
  limiter.refuse = null;
  const why = social.route({ name: "POST /api/social/whys", auth: "account" }, async (context) => {
    await context.consume("social_why");
    return context.json({});
  });
  assert.equal((await why(request(signedIn()), testClient("203.0.113.9"))).status, 200);
  assert.deepEqual(limiter.calls.at(-1), { bucket: "social_why", subject: { accountId: DID } });
});

test("resolved-account limits use the stable account for either sign-in and retain Retry-After", async () => {
  const { kit: social, limiter } = kit();
  limiter.refuse = (subject) => subject.accountId === ACCOUNT.account_id;
  const save = social.route({ name: "PUT /api/social/test", auth: "account", account: "required" }, async (context) => {
    await context.consumeAccount("social_workspace_save");
    return context.json({});
  });
  for (const headers of [signedIn(), { cookie: `__Host-blast_wallet=${SESSION}`, origin: ORIGIN }]) {
    const response = await save(request(headers, { method: "PUT" }), testClient());
    await assertError(response, "rate_limited");
    assert.equal(response.headers.get("retry-after"), "42");
  }
});

test("resolved-account limits refuse an unresolved account instead of using the caller identity", async () => {
  const { kit: social, limiter } = kit();
  const save = social.route({ name: "PUT /api/social/test", auth: "account" }, async (context) => {
    await context.consumeAccount("social_workspace_save");
    return context.json({});
  });
  await assertError(await save(request(signedIn(), { method: "PUT" }), testClient()), "account_required");
  assert.equal(limiter.calls.length, 0);
});

test("outages are 503 service_unavailable with Retry-After: Privy, the account loader, the limiter, a handler fault", async () => {
  const route = (overrides: Partial<SocialRouteKitDependencies>, handler?: () => Promise<Response>) =>
    kit(overrides).kit.route({ name: "GET /api/social/me", auth: "account", account: "resolve", bucket: "social_account_update" }, async (context) =>
      handler ? handler() : context.json({}));
  const pgDown = Object.assign(new Error("Connection terminated unexpectedly"), { code: "57P01" });

  await assertError(await route({ verifyAccessToken: async () => { throw new PrivyAdapterError("PROVIDER_UNAVAILABLE"); } })(request(signedIn()), testClient()), "service_unavailable");
  await assertError(await route({ verifyAccessToken: async () => { throw new PrivyAdapterError("INVALID_CONFIGURATION"); } })(request(signedIn()), testClient()), "service_unavailable");
  await assertError(await route({ accounts: { resolve: async () => { throw pgDown; }, resolveWallet: async () => { throw pgDown; } } })(request(signedIn()), testClient()), "service_unavailable");
  await assertError(await route({ limiter: { consume: async () => { throw pgDown; } } })(request(signedIn()), testClient()), "service_unavailable");
  await assertError(await route({}, async () => { throw new TypeError("bug"); })(request(signedIn()), testClient()), "service_unavailable");
  for (const rejection of [null, undefined]) {
    await assertError(await route({}, () => Promise.reject(rejection))(request(signedIn()), testClient()), "service_unavailable");
  }
  const response = await route({ accounts: { resolve: async () => { throw pgDown; }, resolveWallet: async () => { throw pgDown; } } })(request(signedIn()), testClient());
  assert.equal(response.headers.get("retry-after"), "5");
  assert.equal(toSocialRouteError(new PrivyAdapterError("ACCESS_TOKEN_EXPIRED")).code, "unauthorized");
});

test("route errors carry route-specific fields inside error, and only the codes' fixed messages", async () => {
  const { kit: social } = kit();
  const route = social.route({ name: "GET /api/social/profiles/[callsign]", auth: "none" }, async () => {
    throw new SocialRouteError("invalid_parameter", { extra: { parameter: "callsign" } });
  });
  const response = await route(request(), testClient());
  assert.deepEqual(await response.json(), {
    error: { code: "invalid_parameter", message: "A path or query parameter is invalid.", parameter: "callsign" },
  });
});

test("the shared kit recognizes refusals from another server bundle", async (context) => {
  const source = new URL("../../../../../core/src/modules/social/route-kit/errors.ts", import.meta.url);
  const copy = new URL(`.errors-${randomUUID()}.ts`, source);
  context.after(() => rm(copy, { force: true }));
  await copyFile(source, copy);
  const otherBundle = await import(copy.href);
  assert.notEqual(otherBundle.toSocialRouteError, toSocialRouteError);
  const { kit: social } = kit();
  for (const code of ["portfolio_private", "not_found", "invalid_parameter"] as const) {
    const error = new otherBundle.SocialRouteError(code);
    const route = social.route({ name: "GET /api/social/test", auth: "none" }, async () => { throw error; });
    await assertError(await route(request(), testClient()), code);
  }
  assert.equal(toSocialRouteError(Object.assign(new Error("forged"), { name: "SocialRouteError", code: "portfolio_private" })).code, "service_unavailable");
});

test("the kit's owning modules share one transaction on the primary it was given", async () => {
  const statements: string[] = [];
  const client = {
    query: async (text: string | { text: string }) => {
      const statement = typeof text === "string" ? text : text.text;
      statements.push(statement);
      return { rows: [], rowCount: 0, command: statement.trim().split(/\s+/, 1)[0]?.toUpperCase() };
    },
    release: () => undefined,
    on: () => client,
    removeListener: () => client,
  };
  const primary = { connect: async () => client, options: {} } as unknown as Pool;
  let asked = 0;
  const { kit: social } = kit({ primary: () => (asked += 1, primary) });
  const route = social.route({ name: "POST /api/social/test", auth: "account", account: "required" }, async (context) => {
    await context.transaction(async (tx, transaction) => {
      assert.equal(tx.moduleName, "social");
      await tx.write("social_follows", "INSERT INTO social_follows (follower_account_id) VALUES ($1)", [context.account?.account_id]);
      const sponsor = transaction.forModule("presale-sponsor");
      await sponsor.write("presale_sponsor_reservations", "UPDATE presale_sponsor_reservations SET state = 'expired' WHERE id = $1", ["reservation"]);
      await assert.rejects(
        async () => tx.write("social_follows" as never, "INSERT INTO social_accounts (account_id) VALUES ($1)", []),
        /targets "social_accounts"/,
      );
    });
    return context.json({});
  });
  assert.equal((await route(request(signedIn()), testClient())).status, 200);
  assert.equal(asked, 1);
  assert.ok(statements.some((text) => text.startsWith("INSERT INTO social_follows")));
  assert.ok(statements.some((text) => text.startsWith("UPDATE presale_sponsor_reservations")));
  assert.equal(statements.at(-1), "COMMIT");
});

test("bodies: closed JSON objects of at most 4 KiB", async () => {
  const post = (body: string, headers: Record<string, string> = { "content-type": "application/json" }) =>
    new Request(`${ORIGIN}/api/social/test`, { method: "POST", body, headers });
  assert.deepEqual(await readSocialJson(post('{"text":"hi"}'), ["text"], ["source"]), { text: "hi" });
  assert.deepEqual(await readSocialJson(post('{"text":"hi","source":"x"}'), ["text"], ["source"]), { text: "hi", source: "x" });
  for (const [body, headers] of [
    ['{"text":"hi","extra":1}', undefined],
    ["{}", undefined],
    ["[]", undefined],
    ["not json", undefined],
    ['{"text":"hi"}', { "content-type": "text/plain" }],
  ] as const) {
    await assert.rejects(readSocialJson(post(body, headers), ["text"]), (error: unknown) =>
      error instanceof SocialRouteError && error.code === "invalid_request");
  }
  const big = JSON.stringify({ text: "x".repeat(SOCIAL_BODY_LIMIT_BYTES) });
  await assert.rejects(readSocialJson(post(big), ["text"]), (error: unknown) =>
    error instanceof SocialRouteError && error.code === "body_too_large");
  assert.equal(SOCIAL_BODY_LIMIT_BYTES, 4_096);
});

const walletCookie = (token = SESSION) => `__Host-blast_wallet=${token}`;

test("OA-16: a wallet session cookie is a caller on a same-origin request; its address finds the account and keys the limits", async () => {
  const { kit: social, limiter, resolved } = kit();
  const seen: unknown[] = [];
  const route = (method: string) =>
    social.route({ name: `${method} /api/social/test`, auth: "account", account: "required", bucket: "social_follow" }, async (context) => {
      seen.push(context.caller);
      return context.json({ id: context.account?.account_id });
    });
  const post = await route("POST")(request({ cookie: walletCookie(), origin: ORIGIN, "sec-fetch-site": "same-origin" }, { method: "POST" }), testClient());
  assert.equal(post.status, 200);
  assert.deepEqual(seen.at(-1), { kind: "wallet", address: WALLET, sessionId: SESSION_ID, subject: `sui:${WALLET}` });
  assert.deepEqual(resolved.at(-1), `sui:${WALLET}`);
  assert.deepEqual(limiter.calls.at(-1), { bucket: "social_follow", subject: { accountId: `sui:${WALLET}` } });
  // A same-origin GET (browsers send no Origin on it) is enough with Sec-Fetch-Site.
  assert.equal((await route("GET")(request({ cookie: walletCookie(), "sec-fetch-site": "same-origin" }), testClient())).status, 200);
  // A wallet caller without an account is account_required, like a Privy one.
  await assertError(await route("POST")(request({ cookie: walletCookie(OTHER_SESSION), origin: ORIGIN }, { method: "POST" }), testClient()), "account_required");
});

test("OA-16: a Bearer token wins over a wallet cookie; neither is unauthorized", async () => {
  const { kit: social } = kit();
  const seen: unknown[] = [];
  const route = social.route({ name: "POST /api/social/test", auth: "account" }, async (context) => {
    seen.push(context.caller);
    return context.json({});
  });
  assert.equal((await route(request({ ...signedIn(), cookie: walletCookie(), origin: ORIGIN }, { method: "POST" }), testClient())).status, 200);
  assert.deepEqual(seen.at(-1), { kind: "privy", did: DID, subject: DID });
  await assertError(await route(request({ origin: ORIGIN }, { method: "POST" }), testClient()), "unauthorized");
  // A bad Bearer token does not fall back to the cookie.
  await assertError(await route(request({ authorization: "Bearer nope", cookie: walletCookie(), origin: ORIGIN }, { method: "POST" }), testClient()), "unauthorized");
});

test("OA-16: a cookie caller must be same-origin (CSRF): no Origin on a write, a cross-site fetch, another origin", async () => {
  const { kit: social } = kit();
  const route = social.route({ name: "POST /api/social/test", auth: "account" }, async (context) => context.json({}));
  for (const headers of [
    { cookie: walletCookie() } as Record<string, string>,
    { cookie: walletCookie(), "sec-fetch-site": "same-origin" },
    { cookie: walletCookie(), origin: ORIGIN, "sec-fetch-site": "cross-site" },
    { cookie: walletCookie(), origin: ORIGIN, "sec-fetch-site": "same-site" },
    { cookie: walletCookie(), "sec-fetch-site": "none" },
  ]) {
    await assertError(await route(request(headers, { method: "POST" }), testClient()), "origin_invalid");
  }
  await assertError(await route(request({ cookie: walletCookie(), origin: "https://evil.example" }, { method: "POST" }), testClient()), "origin_invalid");
  const get = social.route({ name: "GET /api/social/test", auth: "account" }, async (context) => context.json({}));
  await assertError(await get(request({ cookie: walletCookie() }), testClient()), "origin_invalid");
  await assertError(await get(request({ cookie: walletCookie(), "sec-fetch-site": "cross-site" }), testClient()), "origin_invalid");
  // An optional route treats a cross-site cookie as no caller.
  const optional = social.route({ name: "GET /api/social/optional", auth: "optional" }, async (context) => context.json({ caller: context.caller !== null }));
  assert.deepEqual(await (await optional(request({ cookie: walletCookie(), "sec-fetch-site": "cross-site" }), testClient())).json(), { caller: false });
  assert.deepEqual(await (await optional(request({ cookie: walletCookie(), "sec-fetch-site": "same-origin" }), testClient())).json(), { caller: true });
});

test("OA-16: a cookie whose session has ended is unauthorized and clears both cookies; without session support the cookie is ignored", async () => {
  const { kit: social } = kit();
  const route = social.route({ name: "POST /api/social/test", auth: "account" }, async (context) => context.json({}));
  const stale = await route(request({ cookie: walletCookie(STALE_SESSION), origin: ORIGIN }, { method: "POST" }), testClient());
  assert.deepEqual(stale.headers.getSetCookie().map((cookie) => cookie.split(";")[0]), ["__Host-blast_wallet=", "__Host-blast_wallet_hint="]);
  await assertError(stale, "unauthorized", "private, no-store");
  const optional = social.route({ name: "GET /api/social/optional", auth: "optional" }, async (context) => context.json({ caller: context.caller !== null }));
  const anonymous = await optional(request({ cookie: walletCookie(STALE_SESSION), "sec-fetch-site": "same-origin" }), testClient());
  assert.equal(anonymous.headers.getSetCookie().length, 2);
  assert.deepEqual(await anonymous.json(), { caller: false });
  const withoutSessions = kit({ walletSessions: undefined }).kit.route({ name: "POST /api/social/test", auth: "account" }, async (context) => context.json({}));
  await assertError(await withoutSessions(request({ cookie: walletCookie(), origin: ORIGIN }, { method: "POST" }), testClient()), "unauthorized");
  // A public route never reads the cookie.
  const open = social.route({ name: "GET /api/social/feed", auth: "none", cache: "public" }, async (context) => context.json({ caller: context.caller }));
  assert.deepEqual(await (await open(request({ cookie: walletCookie(), "sec-fetch-site": "same-origin" }), testClient())).json(), { caller: null });
});

test("expired-session cookie clearing makes shared inner responses private across transports", async () => {
  const { kit: social, resolved } = kit();
  const route = social.route({ name: "GET /api/social/optional", auth: "optional" }, async () => Response.json({ public: true }, { headers: {
    "Cache-Control": SOCIAL_PUBLIC_CACHE_CONTROL, "CDN-Cache-Control": "public, s-maxage=10", "Vercel-CDN-Cache-Control": "public, s-maxage=10",
  } }));
  const stale = await route(request({ cookie: walletCookie(STALE_SESSION), "sec-fetch-site": "same-origin" }), testClient());
  assert.deepEqual(await stale.json(), { public: true });
  assert.equal(stale.headers.getSetCookie().length, 2);
  assert.equal(stale.headers.get("cache-control"), "private, no-store");
  for (const name of ["cdn-cache-control", "vercel-cdn-cache-control"]) assert.equal(stale.headers.get(name), "no-store");
  const live = await route(request({ cookie: walletCookie(), "sec-fetch-site": "same-origin" }), testClient());
  assert.equal(live.headers.getSetCookie().length, 0);
  assert.equal(live.headers.get("cache-control"), SOCIAL_PUBLIC_CACHE_CONTROL);
  assert.deepEqual(resolved, [], "Public inner responses do not create or resolve accounts.");
});

test("review L4: failed wallet-session lookups count per IP; once full, no cookie from that IP is looked up", async () => {
  let lookups = 0;
  const authFailures = new MemoryRateLimiter();
  const { kit: social } = kit({
    authFailures,
    walletSessions: {
      async live(token) {
        lookups += 1;
        return token === SESSION ? { address: WALLET, sessionId: SESSION_ID } : null;
      },
    },
  });
  const route = social.route({ name: "POST /api/social/test", auth: "account" }, async (context) => context.json({}));
  const optional = social.route({ name: "GET /api/social/optional", auth: "optional" }, async (context) => context.json({ caller: context.caller !== null }));
  const stale = (ip: string) => request({ cookie: walletCookie(STALE_SESSION), origin: ORIGIN, "x-forwarded-for": ip }, { method: "POST" });
  const limit = DEFAULT_RATE_POLICIES.social_auth_failure.windows[0]!.limit;
  for (let attempt = 0; attempt < limit; attempt += 1) await assertError(await route(stale("198.51.100.8"), testClient("198.51.100.8")), "unauthorized", "private, no-store");
  assert.equal(lookups, limit);
  const limited = await route(stale("198.51.100.8"), testClient("198.51.100.8"));
  assert.equal(limited.headers.get("retry-after") !== null, true);
  await assertError(limited, "rate_limited");
  // Even a live cookie from that IP is not looked up now; an optional route answers anonymously.
  await assertError(await route(request({ cookie: walletCookie(), origin: ORIGIN, "x-forwarded-for": "198.51.100.8" }, { method: "POST" }), testClient("198.51.100.8")), "rate_limited");
  const anonymous = await optional(request({ cookie: walletCookie(), "sec-fetch-site": "same-origin", "x-forwarded-for": "198.51.100.8" }), testClient("198.51.100.8"));
  assert.deepEqual(await anonymous.json(), { caller: false });
  assert.equal(lookups, limit, "nothing more was looked up");
  // Another IP is unaffected, and a live session never counts as a failure.
  assert.equal((await route(request({ cookie: walletCookie(), origin: ORIGIN, "x-forwarded-for": "198.51.100.9" }, { method: "POST" }), testClient("198.51.100.9"))).status, 200);
  assert.equal((await authFailures.peek("social_auth_failure", { ip: "198.51.100.9" })).allowed, true);
});

test("UI-02 metrics: every 5xx logs a social.route line with its duration; a sampled share of other answers logs status and duration", async () => {
  const lines: Record<string, unknown>[] = [];
  const original = console.info;
  console.info = (line: unknown) => {
    if (typeof line === "string" && line.includes('"social.route"')) lines.push(JSON.parse(line) as Record<string, unknown>);
  };
  try {
    let draw = 0.05;
    const { kit: sampled } = kit({ metricSampleRate: 0.1, random: () => draw });
    const ok = sampled.route({ name: "GET /api/social/feed", auth: "none" }, async (context) => context.json({}));
    const refused = sampled.route({ name: "GET /api/social/feed/new", auth: "none" }, async () => {
      throw new SocialRouteError("invalid_parameter", { extra: { parameter: "since" } });
    });
    const broken = sampled.route({ name: "GET /api/social/items/{entry_id}", auth: "none" }, async () => {
      throw new TypeError("bug");
    });
    await ok(request(), testClient());
    await refused(request(), testClient());
    draw = 0.5;
    await ok(request(), testClient());
    const failure = await broken(request(), testClient());
    assert.deepEqual(lines.map((line) => [line.route, line.status, line.outcome, line.sampleRate]), [
      ["GET /api/social/feed", 200, "ok", 0.1],
      ["GET /api/social/feed/new", 400, "refused", 0.1],
      ["GET /api/social/items/{entry_id}", 503, "error", undefined],
    ]);
    for (const line of lines) assert.equal(typeof line.durationMs, "number");
    assert.equal(lines[2]?.requestId, failure.headers.get("x-request-id"));
    assert.deepEqual(lines.map((line) => line.requestId), ["req-1", "req-2", "req-4"]);
    // No value of the request ever reaches a line.
    assert.doesNotMatch(JSON.stringify(lines), /since|bug|Bearer/);
    // Rate 0 logs only failures.
    lines.length = 0;
    const { kit: silent } = kit({ metricSampleRate: 0, random: () => 0 });
    await silent.route({ name: "GET /api/social/feed", auth: "none" }, async (context) => context.json({}))(request(), testClient());
    assert.equal(lines.length, 0);
  } finally {
    console.info = original;
  }
});

test("optional auth keeps anonymous reads available and observes token failures without secrets", async (t) => {
  const previous = process.env.MISSION_CONTROL_METRICS;
  process.env.MISSION_CONTROL_METRICS = "on";
  t.after(() => { if (previous === undefined) delete process.env.MISSION_CONTROL_METRICS; else process.env.MISSION_CONTROL_METRICS = previous; });
  const records: Record<string, unknown>[] = [];
  t.mock.method(console, "info", (line: string) => { records.push(JSON.parse(line)); });
  const { kit: social } = kit({ verifyAccessToken: async () => { throw new Error("private-provider-message"); }, metricSampleRate: 0 });
  const read = social.route({ name: "GET /api/social/optional", auth: "optional" }, async (context) => context.json({ anonymous: context.caller === null }));
  const response = await read(request({ authorization: "Bearer private-token" }), testClient());
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { anonymous: true });
  assert.deepEqual(records.filter((record) => record.metric === "social.auth").map(({ outcome, cause }) => ({ outcome, cause })), [{ outcome: "anonymous", cause: "service_unavailable" }]);
  assert.equal(JSON.stringify(records).includes("private-"), false);
});

test("social quotas use the attested client network despite forged address headers", async () => {
  const { kit: social, limiter } = kit();
  const client = testClient("2001:db8:1:2::7");
  const route = social.route({ name: "POST /api/social/accounts", auth: "account", account: "required", bucket: "social_account_create" }, async (context) => {
    assert.equal(context.client, client);
    await context.consume("social_read");
    await context.consumeAccount("social_workspace_save");
    await context.consumeAccount("social_read");
    return context.json({ ok: true });
  });

  const response = await route(request({ ...signedIn(), "x-forwarded-for": "198.51.100.99", "x-real-ip": "192.0.2.99" }), client);

  assert.equal(response.status, 200);
  assert.deepEqual(limiter.calls, [
    { bucket: "social_account_create", subject: { ip: "2001:db8:1:2::/64" } },
    { bucket: "social_account_create", subject: { accountId: DID } },
    { bucket: "social_read", subject: { ip: "2001:db8:1:2::/64" } },
    { bucket: "social_workspace_save", subject: { accountId: ACCOUNT.account_id } },
    { bucket: "social_read", subject: { ip: "2001:db8:1:2::/64" } },
  ]);
});

test("failed wallet cookies share the attested IPv6 network budget despite forged headers", async () => {
  let lookups = 0;
  const policy = DEFAULT_RATE_POLICIES.social_auth_failure;
  const authFailures = new MemoryRateLimiter({
    clock: () => new Date("2026-11-16T00:00:00Z"),
    policies: { ...DEFAULT_RATE_POLICIES, social_auth_failure: { ...policy, windows: policy.windows.map(window => ({ ...window, limit: 1 })) } },
  });
  const { kit: social } = kit({ authFailures, walletSessions: { live: async () => { lookups++; return null; } } });
  const required = social.route({ name: "GET /api/social/test", auth: "account" }, async context => context.json({}));
  const optional = social.route({ name: "GET /api/social/test", auth: "optional" }, async context => context.json({ caller: context.caller }));
  const stale = request({ cookie: walletCookie(STALE_SESSION), "sec-fetch-site": "same-origin", "x-forwarded-for": "198.51.100.1" });

  await assertError(await required(stale, testClient("2001:db8:1:2::1")), "unauthorized", "private, no-store");
  await assertError(await required(stale, testClient("2001:db8:1:2::2")), "rate_limited");
  assert.deepEqual(await (await optional(stale, testClient("2001:db8:1:2::3"))).json(), { caller: null });
  assert.equal(lookups, 1);
  await assertError(await required(stale, testClient("2001:db8:1:3::1")), "unauthorized", "private, no-store");
  assert.equal(lookups, 2);
});
