import { testClient } from "../../../../test/fixtures/lib/web-security/client-address.ts";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import test from "node:test";

import { createPrivyTokenVerifier } from "@blast/core/lib/privy-adapter/token-verifier.ts";
import { DEFAULT_RATE_POLICIES, type RateBucket, type RateLimitDecision, type RateLimitPort, type RateLimitSubject } from "@blast/core/lib/web-security/rate-limits.ts";
import { createPresaleValidator } from "../contracts/validate.ts";
import { PRESALE_ERRORS, type PresaleErrorCode } from "../contracts/errors.ts";
import {
  fixtureChainNode,
  presaleIdentityFixture,
  SUI_MAINNET_CHAIN_IDENTIFIER,
  SUI_TESTNET_CHAIN_IDENTIFIER,
} from "../../../../test/fixtures/modules/presale/deployment/fixtures.ts";
import { createPresaleDeploymentGate } from "../deployment/service.ts";
import { PrivyAdapterError } from "@blast/core/lib/privy-adapter/errors.ts";
import { PresaleRouteError, toPresaleRouteError } from "./errors.ts";
import {
  createPresaleRouteKit,
  exactKeys,
  readJsonBody,
  type PresaleRouteKitDependencies,
} from "./route.ts";

/**
 * T-008: the presale route kit (REQ-001, AC-004, AC-005). Routes are exercised
 * as Request -> Response handlers with a real Privy token verifier, the real
 * deployment gate over a fixture node, and an in-memory rate-limit port.
 */

const ORIGIN = "https://blast.fun";
const APP_ID = "presale-kit-app";
const NOW = Math.floor(Date.now() / 1_000);
const DID = "did:privy:presale-google-only";
const keys = generateKeyPairSync("ec", { namedCurve: "P-256" });
const verificationKey = keys.publicKey.export({ format: "pem", type: "spki" }).toString();
const validator = createPresaleValidator();

function token(claims: Record<string, unknown> = {}): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const header = encode({ alg: "ES256", typ: "JWT" });
  const payload = encode({ aud: APP_ID, exp: NOW + 3_600, iat: NOW - 60, iss: "privy.io", sid: "s-1", sub: DID, ...claims });
  const signature = sign("sha256", Buffer.from(`${header}.${payload}`), { dsaEncoding: "ieee-p1363", key: keys.privateKey });
  return `${header}.${payload}.${signature.toString("base64url")}`;
}

class MemoryLimiter implements RateLimitPort {
  readonly calls: { bucket: RateBucket; subject: RateLimitSubject }[] = [];
  refuse: { bucket: RateBucket; retryAfterSeconds: number } | null = null;
  async consume(bucket: RateBucket, subject: RateLimitSubject): Promise<RateLimitDecision> {
    this.calls.push({ bucket, subject });
    const refused = this.refuse?.bucket === bucket;
    return { allowed: !refused, bucket, policyVersion: 1, retryAfterSeconds: refused ? this.refuse!.retryAfterSeconds : 0 };
  }
}

const IDENTITY = { PRESALE_DEPLOYMENT_MANIFEST: JSON.stringify(presaleIdentityFixture()) };

function kit(overrides: Partial<PresaleRouteKitDependencies> = {}, limiter = new MemoryLimiter()) {
  let id = 0;
  return createPresaleRouteKit({
    expectedOrigin: ORIGIN,
    verifyAccessToken: createPrivyTokenVerifier({ appId: APP_ID, verificationKey }),
    limiter,
    deployment: createPresaleDeploymentGate({
      environment: IDENTITY,
      node: async () => fixtureChainNode(SUI_MAINNET_CHAIN_IDENTIFIER),
    }),
    createRequestId: () => `req-${++id}`,
    ...overrides,
  });
}

function request(path: string, init: RequestInit & { headers?: Record<string, string> } = {}): Request {
  return new Request(`${ORIGIN}${path}`, init);
}

/** Asserts the published error shape: status, code, closed schema, headers (CL-10, CL-23). */
async function assertError(response: Response, code: PresaleErrorCode): Promise<Record<string, unknown>> {
  const body = (await response.json()) as { error: Record<string, unknown> };
  assert.equal(body.error.code, code, JSON.stringify(body));
  assert.equal(response.status, PRESALE_ERRORS[code].status);
  assert.deepEqual(validator.validate(`errors/${code}`, body).errors, []);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.match(response.headers.get("x-request-id") ?? "", /^req-\d+$/);
  const retryAfter = response.headers.get("retry-after");
  if (PRESALE_ERRORS[code].retryAfter) assert.match(retryAfter ?? "", /^[1-9][0-9]*$/, `${code} carries Retry-After`);
  else assert.equal(retryAfter, null, `${code} carries no Retry-After`);
  return body.error;
}

const proofRoute = (routes: ReturnType<typeof kit>) =>
  routes.route(
    { name: "GET /api/presale/presales/{presale_id}/proof", auth: "none", bucket: "presale_proof", deployment: "verified" },
    async (context) => context.json({ chain: context.deployment?.chainIdentifier }),
  );
const settingsRoute = (routes: ReturnType<typeof kit>) =>
  routes.route(
    { name: "PUT /api/account/settings", auth: "account", bucket: "presale_settings" },
    async (context) => {
      const body = exactKeys(await readJsonBody(context.request), ["explorer", "theme"]);
      return context.json({ ...body, saved: true, did: context.account?.did });
    },
  );
const settingsPut = (headers: Record<string, string> = {}, body: unknown = { explorer: "suiscan", theme: "dark" }) =>
  request("/api/account/settings", {
    method: "PUT",
    body: typeof body === "string" ? body : JSON.stringify(body),
    headers: { authorization: `Bearer ${token()}`, "content-type": "application/json", ...headers },
  });

test("with no identity, an identity route is 503 deployment_unavailable and an identity-free route still works", async () => {
  const node = fixtureChainNode(SUI_MAINNET_CHAIN_IDENTIFIER);
  const routes = kit({ deployment: createPresaleDeploymentGate({ environment: {}, node: async () => node }) });
  await assertError(await proofRoute(routes)(request("/api/presale/presales/0x1/proof"), testClient()), "deployment_unavailable");

  const saved = await settingsRoute(routes)(settingsPut(), testClient());
  assert.equal(saved.status, 200);
  assert.deepEqual(await saved.json(), { explorer: "suiscan", theme: "dark", saved: true, did: DID });
  assert.equal(saved.headers.get("cache-control"), "no-store");
  assert.equal(saved.headers.get("x-request-id"), "req-2");
});

test("an identity on another chain than the node's blocks the route with deployment_mismatch", async () => {
  const mismatched = kit({
    deployment: createPresaleDeploymentGate({ environment: IDENTITY, node: async () => fixtureChainNode(SUI_TESTNET_CHAIN_IDENTIFIER) }),
  });
  await assertError(await proofRoute(mismatched)(request("/api/presale/presales/0x1/proof"), testClient()), "deployment_mismatch");
  const hanging = kit({
    deployment: createPresaleDeploymentGate({
      environment: IDENTITY,
      node: async () => fixtureChainNode(SUI_MAINNET_CHAIN_IDENTIFIER, { hang: true }),
      nodeTimeoutMs: 50,
    }),
  });
  await assertError(await proofRoute(hanging)(request("/api/presale/presales/0x1/proof"), testClient()), "deployment_unavailable");
  const matching = await proofRoute(kit())(request("/api/presale/presales/0x1/proof"), testClient());
  assert.deepEqual(await matching.json(), { chain: SUI_MAINNET_CHAIN_IDENTIFIER });
});

test("a Privy bearer token gives the DID; a missing, malformed or expired one is unauthorized", async () => {
  const route = settingsRoute(kit());
  await assertError(await route(settingsPut({ authorization: "" }), testClient()), "unauthorized");
  await assertError(await route(settingsPut({ authorization: "Bearer not.a.jwt" }), testClient()), "unauthorized");
  await assertError(await route(settingsPut({ authorization: `Bearer ${token({ exp: NOW - 10 })}` }), testClient()), "unauthorized");
  await assertError(await route(settingsPut({ authorization: `Bearer ${token({ aud: "other-app" })}` }), testClient()), "unauthorized");
  await assertError(await route(settingsPut({ authorization: `Basic ${token()}` }), testClient()), "unauthorized");
  assert.equal((await route(settingsPut(), testClient())).status, 200);
});

test("a present foreign Origin is origin_invalid; bearer tokens need no CSRF cookie; agent API keys skip the Origin rule", async () => {
  const route = settingsRoute(kit());
  await assertError(await route(settingsPut({ origin: "https://evil.example" }), testClient()), "origin_invalid");
  assert.equal((await route(settingsPut({ origin: ORIGIN }), testClient())).status, 200, "no double-submit cookie needed");
  assert.equal((await route(settingsPut(), testClient())).status, 200, "no Origin header is fine");

  const limiter = new MemoryLimiter();
  const agentKit = kit({ verifyApiKey: async (value) => (value === "agent-secret" ? { keyId: "key-7", did: null } : null) }, limiter);
  const create = agentKit.route(
    { name: "POST /api/presale/allowlists", auth: "account_or_api_key", bucket: "presale_allowlist" },
    async (context) => context.json({ principal: context.principal }, 201),
  );
  const fromAgent = await create(
    request("/api/presale/allowlists", { method: "POST", headers: { "x-blast-api-key": "agent-secret", origin: "https://agent.example" } }), testClient()
  );
  assert.equal(fromAgent.status, 201);
  assert.deepEqual(await fromAgent.json(), { principal: { kind: "api_key", keyId: "key-7", did: null } });
  assert.deepEqual(limiter.calls.at(-1)?.subject.apiKeyId, "key-7");
  // A present X-Blast-Api-Key is the credential: an unknown one is unauthorized, never a Privy fallback.
  await assertError(
    await create(request("/api/presale/allowlists", {
      method: "POST",
      headers: { "x-blast-api-key": "unknown", authorization: `Bearer ${token()}`, origin: "https://agent.example" },
    }), testClient()),
    "unauthorized",
  );
  // The key travels only in X-Blast-Api-Key: as a bearer token it is not a Privy token.
  await assertError(
    await create(request("/api/presale/allowlists", { method: "POST", headers: { authorization: "Bearer agent-secret" } }), testClient()),
    "unauthorized",
  );
  // A route that takes no API key ignores the header.
  await assertError(await settingsRoute(agentKit)(settingsPut({ authorization: "", "x-blast-api-key": "agent-secret" }), testClient()), "unauthorized");
  await assertError(
    await create(request("/api/presale/allowlists", { method: "POST", headers: { authorization: `Bearer ${token()}`, origin: "https://evil.example" } }), testClient()),
    "origin_invalid",
  );
  const fromAccount = await create(request("/api/presale/allowlists", { method: "POST", headers: { authorization: `Bearer ${token()}` } }), testClient());
  assert.deepEqual(await fromAccount.json(), { principal: { kind: "account", did: DID } });
});

test("review M2: every API key lookup counts per client IP first; a full budget is rate_limited and reads nothing", async () => {
  const attempts = new MemoryLimiter();
  let lookups = 0;
  const agentKit = kit({
    apiKeyLimiter: attempts,
    verifyApiKey: async (value) => {
      lookups += 1;
      return value === "agent-secret" ? { keyId: "key-7", did: null } : null;
    },
  });
  const create = agentKit.route(
    { name: "POST /api/presale/allowlists", auth: "account_or_api_key", bucket: "presale_allowlist" },
    async (context) => context.json({ principal: context.principal }, 201),
  );
  const call = (key: string) =>
    create(request("/api/presale/allowlists", { method: "POST", headers: { "x-blast-api-key": key, "x-forwarded-for": "198.51.100.23" } }), testClient("198.51.100.23"));
  assert.equal((await call("agent-secret")).status, 201);
  await assertError(await call("forged"), "unauthorized");
  assert.deepEqual(attempts.calls, [
    { bucket: "presale_api_key_ip", subject: { ip: "198.51.100.23" } },
    { bucket: "presale_api_key_ip", subject: { ip: "198.51.100.23" } },
  ]);
  assert.equal(lookups, 2);
  attempts.refuse = { bucket: "presale_api_key_ip", retryAfterSeconds: 9 };
  const limited = await call("forged-again");
  await assertError(limited.clone(), "rate_limited");
  assert.equal(limited.headers.get("retry-after"), "9");
  assert.equal(lookups, 2, "a full budget reads no key");
  // A request without the header (a Privy account) never counts here.
  const before = attempts.calls.length;
  await create(request("/api/presale/allowlists", { method: "POST", headers: { authorization: `Bearer ${token()}` } }), testClient());
  assert.equal(attempts.calls.length, before);
  // The policy: 300 a minute per IP, above an agent's 120 allowlist reads a minute.
  assert.deepEqual(DEFAULT_RATE_POLICIES.presale_api_key_ip.windows, [{ limit: 300, windowSeconds: 60 }]);
  assert.equal(DEFAULT_RATE_POLICIES.presale_api_key_ip.subjectScope, "ip");
});

test("rate buckets are counted per account or per IP and refuse with rate_limited and Retry-After", async () => {
  const limiter = new MemoryLimiter();
  const routes = kit({}, limiter);
  await settingsRoute(routes)(settingsPut({ "x-forwarded-for": "203.0.113.9" }), testClient("203.0.113.9"));
  await proofRoute(routes)(request("/api/presale/presales/0x1/proof", { headers: { "x-forwarded-for": "203.0.113.9" } }), testClient("203.0.113.9"));
  assert.deepEqual(limiter.calls, [
    { bucket: "presale_settings", subject: { accountId: DID, ip: "203.0.113.9" } },
    { bucket: "presale_proof", subject: { ip: "203.0.113.9" } },
  ]);
  limiter.refuse = { bucket: "presale_settings", retryAfterSeconds: 42 };
  const refused = await settingsRoute(routes)(settingsPut(), testClient());
  await assertError(refused, "rate_limited");
  assert.equal(refused.headers.get("retry-after"), "42");
});

test("WP3: a spec's bucket list counts in order (IP, account, platform-wide) and the first full one refuses", async () => {
  const limiter = new MemoryLimiter();
  const routes = kit({}, limiter);
  const sponsorLike = routes.route(
    { name: "POST /api/presale/sponsor", auth: "account", bucket: ["presale_sponsor_ip", "presale_sponsor", "presale_sponsor_global"] },
    async (context) => context.json({ ok: true }),
  );
  const post = () =>
    sponsorLike(request("/api/presale/sponsor", {
      method: "POST",
      headers: { authorization: `Bearer ${token()}`, "x-forwarded-for": "203.0.113.9", "content-type": "application/json" },
      body: "{}",
    }), testClient("203.0.113.9"));
  assert.equal((await post()).status, 200);
  assert.deepEqual(limiter.calls.map((call) => call.bucket), ["presale_sponsor_ip", "presale_sponsor", "presale_sponsor_global"]);
  assert.deepEqual(limiter.calls[0]?.subject, { accountId: DID, ip: "203.0.113.9" });
  limiter.calls.length = 0;
  limiter.refuse = { bucket: "presale_sponsor_ip", retryAfterSeconds: 7 };
  const refused = await post();
  await assertError(refused, "rate_limited");
  assert.equal(refused.headers.get("retry-after"), "7");
  assert.deepEqual(limiter.calls.map((call) => call.bucket), ["presale_sponsor_ip"], "a full IP budget spends neither the account's nor the platform's");
  assert.throws(
    () => routes.route({ name: "GET /api/presale/presales/{presale_id}/proof", auth: "none", bucket: ["presale_proof", "presale_sponsor"] }, async (context) => context.json({})),
    /presale_sponsor counts per account/,
  );
});

test("account_or_wallet: a same-origin wallet session cookie signs in as sui:<address>; a token wins; cross-origin and dead cookies refuse", async () => {
  const limiter = new MemoryLimiter();
  const address = `0x${"ab".repeat(32)}`;
  const cookie = `__Host-blast_wallet=${"A".repeat(43)}`;
  let lookups = 0;
  const routes = kit({
    walletSessions: { live: async () => (lookups += 1, lookups === 2 ? null : { address }) },
  }, limiter);
  const sponsor = routes.route(
    { name: "POST /api/presale/sponsor", auth: "account_or_wallet", bucket: "presale_sponsor" },
    async (context) => context.json({ account: context.account, wallet: context.wallet }),
  );
  const post = (headers: Record<string, string>) =>
    sponsor(request("/api/presale/sponsor", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: "{}" }), testClient());
  const wallet = await post({ cookie, origin: ORIGIN, "sec-fetch-site": "same-origin" });
  assert.deepEqual(await wallet.json(), { account: null, wallet: { address } });
  assert.deepEqual(limiter.calls[0]?.subject, { accountId: `sui:${address}`, ip: testClient().rateKey });
  const privy = await post({ cookie, origin: ORIGIN, authorization: `Bearer ${token()}` });
  assert.deepEqual(await privy.json(), { account: { did: DID }, wallet: null }, "a Privy token wins over the cookie");
  await assertError(await post({ cookie }), "origin_invalid");
  await assertError(await post({ cookie, origin: ORIGIN, "sec-fetch-site": "same-site" }), "origin_invalid");
  await assertError(await post({ cookie, origin: ORIGIN }), "unauthorized");
  await assertError(await post({ origin: ORIGIN }), "unauthorized");
  assert.equal(lookups, 2, "only same-origin cookies are looked up");
  const accountOnly = routes.route(
    { name: "POST /api/presale/sponsor", auth: "account", bucket: "presale_sponsor" },
    async (context) => context.json({}),
  );
  await assertError(
    await accountOnly(request("/api/presale/sponsor", { method: "POST", headers: { cookie, origin: ORIGIN }, body: "{}" }), testClient()),
    "unauthorized",
  );
});

test("bodies are exact-key JSON under 64 KiB", async () => {
  const route = settingsRoute(kit());
  await assertError(await route(settingsPut({ "content-type": "text/plain" }), testClient()), "invalid_request");
  await assertError(await route(settingsPut({}, "{not json"), testClient()), "invalid_request");
  await assertError(await route(settingsPut({}, { explorer: "suiscan", theme: "dark", extra: 1 }), testClient()), "invalid_request");
  await assertError(await route(settingsPut({}, { explorer: "suiscan" }), testClient()), "invalid_request");
  await assertError(await route(settingsPut({}, [1, 2]), testClient()), "invalid_request");
  await assertError(await route(settingsPut({}, { explorer: "x".repeat(65_536), theme: "dark" }), testClient()), "body_too_large");
  await assertError(await route(settingsPut({ "content-length": "70000" }, { explorer: "suiscan", theme: "dark" }), testClient()), "body_too_large");
  assert.equal((await route(settingsPut({ "content-type": "application/json; charset=utf-8" }), testClient())).status, 200);
});

test("failures map to published codes only, and causes never reach the body", async () => {
  const routes = kit();
  const failing = (error: unknown) =>
    routes.route({ name: "GET /api/account/settings", auth: "none", bucket: "presale_proof" }, async () => {
      throw error;
    })(request("/api/account/settings"), testClient());
  const unavailable = await failing(new Error("timeout exceeded when trying to connect"));
  await assertError(unavailable, "service_unavailable");
  assert.equal(unavailable.headers.get("retry-after"), "5");
  const leaked = await failing(new Error("private key suiprivkey1qsecret and token eyJabc"));
  const text = JSON.stringify(await assertError(leaked, "service_unavailable"));
  assert.doesNotMatch(text, /suiprivkey|eyJabc/);
  // A code the route does not publish is never answered.
  await assertError(await failing(new PresaleRouteError("not_eligible")), "service_unavailable");
  // Route-specific fields sit inside `error` (CL-10).
  const unconfirmed = await routes.route(
    { name: "POST /api/presale/sponsor/{reservation_id}/execute", auth: "none" },
    async () => {
      throw new PresaleRouteError("execution_unconfirmed", { extra: { digest: "5uhRGwvhv4Wbk1JTEnRUhVXN3ULpUPfcDvjXKHfrSjNx" } });
    },
  )(request("/api/presale/sponsor/r-1/execute", { method: "POST" }), testClient());
  assert.deepEqual(await assertError(unconfirmed, "execution_unconfirmed"), {
    code: "execution_unconfirmed",
    message: "The transaction outcome could not be confirmed.",
    digest: "5uhRGwvhv4Wbk1JTEnRUhVXN3ULpUPfcDvjXKHfrSjNx",
  });
  // One Privy mapping (Q-002): missing settings are the deployment's fault, an outage is Privy's.
  assert.equal(toPresaleRouteError(new PrivyAdapterError("INVALID_CONFIGURATION")).code, "service_unavailable");
  assert.equal(toPresaleRouteError(new PrivyAdapterError("PROVIDER_TIMEOUT")).code, "identity_unavailable");
  assert.equal(toPresaleRouteError(new PrivyAdapterError("PROVIDER_UNAVAILABLE")).code, "identity_unavailable");
  assert.equal(toPresaleRouteError(new PrivyAdapterError("ACCESS_TOKEN_EXPIRED")).code, "unauthorized");
  const budget = new PresaleRouteError("budget_exceeded", { extra: { reason: "daily_limit" }, now: new Date("2026-10-02T23:00:00.000Z") });
  assert.equal(budget.retryAfterSeconds, 3_600, "budget_exceeded waits until the next UTC day");
  // Q-013: the default follows `reason`. Only the daily limit runs to the next UTC day; the open-reservation
  // cap has no default, because only its emitter knows when the earliest reservation expires.
  // Q-018: the type requires it; the runtime check stays as a backstop for casts.
  // @ts-expect-error open_reservations needs retryAfterSeconds
  assert.throws(() => new PresaleRouteError("budget_exceeded", { extra: { reason: "open_reservations" } }), /open_reservations needs an explicit Retry-After/);
  const untyped = { extra: { reason: "open_reservations" }, now: new Date("2026-10-02T23:00:00.000Z") } as unknown as { extra: { reason: "daily_limit" } };
  assert.throws(() => new PresaleRouteError("budget_exceeded", untyped), /open_reservations needs an explicit Retry-After/);
  const open = new PresaleRouteError("budget_exceeded", { extra: { reason: "open_reservations" }, retryAfterSeconds: 42 });
  assert.equal(open.retryAfterSeconds, 42);
  assert.equal(new PresaleRouteError("identity_unavailable").retryAfterSeconds, 5);
});

test("unexpected failures log the response reference without leaking the cause message", async (t) => {
  const lines: Record<string, unknown>[] = [];
  t.mock.method(console, "info", (line: string) => lines.push(JSON.parse(line) as Record<string, unknown>));
  const route = kit().route({ name: "GET /api/account/settings", auth: "none" }, async () => {
    throw new TypeError("authorization=private-token");
  });
  const response = await route(request("/api/account/settings"), testClient());
  await assertError(response, "service_unavailable");
  const logged = lines.find((line) => line.metric === "presale.route");
  assert.equal(logged?.requestId, response.headers.get("x-request-id"));
  assert.equal(logged?.status, 503);
  assert.equal(logged?.cause, "TypeError");
  assert.doesNotMatch(JSON.stringify(lines), /private-token|authorization/);
});

test("optional auth ignores a missing or invalid bearer token (CL-22)", async () => {
  const outcome = kit().route({ name: "POST /api/presale/outcomes", auth: "optional", bucket: "presale_outcome" }, async (context) =>
    context.json({ did: context.account?.did ?? null }, 201),
  );
  const anonymous = await outcome(request("/api/presale/outcomes", { method: "POST", headers: { authorization: "Bearer junk" } }), testClient());
  assert.deepEqual(await anonymous.json(), { did: null });
  const signedIn = await outcome(request("/api/presale/outcomes", { method: "POST", headers: { authorization: `Bearer ${token()}` } }), testClient());
  assert.deepEqual(await signedIn.json(), { did: DID });
});

test("a route spec that cannot keep the published contract is refused when it is built", () => {
  const routes = kit();
  const noop = async () => new Response(null);
  assert.throws(() => routes.route({ name: "GET /api/presale/bridge/quote", auth: "none", bucket: "presale_settings" }, noop), /account/);
  assert.throws(() => routes.route({ name: "GET /api/presale/bridge/quote", auth: "account", bucket: "presale_bridge_quote" }, noop), /unauthorized/);
  assert.throws(
    () => routes.route({ name: "GET /api/presale/bridge/quote", auth: "none", bucket: "presale_bridge_quote", deployment: "verified" }, noop),
    /deployment_unavailable/,
  );
});


test("presale quotas use the verified IPv6 network despite forged forwarding headers", async () => {
  const limiter = new MemoryLimiter();
  const client = testClient("2001:db8:12:34::7");
  const route = kit({}, limiter).route(
    { name: "POST /api/presale/outcomes", auth: "none", bucket: "presale_outcome" },
    async (context) => {
      assert.equal(context.client, client);
      await context.consume("presale_outcome_commit");
      return context.json({ ok: true });
    },
  );

  const response = await route(request("/api/presale/outcomes", {
    method: "POST",
    headers: { "x-forwarded-for": "198.51.100.99", "x-real-ip": "192.0.2.44" },
  }), client);

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
  assert.deepEqual(limiter.calls, [
    { bucket: "presale_outcome", subject: { ip: "2001:db8:12:34::/64" } },
    { bucket: "presale_outcome_commit", subject: { ip: "2001:db8:12:34::/64" } },
  ]);
});

test("API-key lookup budgets share the verified IPv6 network before reading credentials", async () => {
  const attempts = new MemoryLimiter();
  let lookups = 0;
  const route = kit({
    apiKeyLimiter: attempts,
    verifyApiKey: async () => {
      lookups += 1;
      return null;
    },
  }).route(
    { name: "POST /api/presale/allowlists", auth: "account_or_api_key", bucket: "presale_allowlist" },
    async (context) => context.json({ ok: true }),
  );

  await assertError(await route(request("/api/presale/allowlists", {
    method: "POST",
    headers: { "x-blast-api-key": "forged", "x-forwarded-for": "198.51.100.1" },
  }), testClient("2001:db8:12:34::1")), "unauthorized");
  attempts.refuse = { bucket: "presale_api_key_ip", retryAfterSeconds: 9 };
  const refused = await route(request("/api/presale/allowlists", {
    method: "POST",
    headers: { "x-blast-api-key": "another-forged-key", "x-forwarded-for": "198.51.100.2" },
  }), testClient("2001:db8:12:34::99"));

  await assertError(refused.clone(), "rate_limited");
  assert.equal(refused.headers.get("retry-after"), "9");
  assert.equal(lookups, 1);
  assert.deepEqual(attempts.calls, [
    { bucket: "presale_api_key_ip", subject: { ip: "2001:db8:12:34::/64" } },
    { bucket: "presale_api_key_ip", subject: { ip: "2001:db8:12:34::/64" } },
  ]);
});
