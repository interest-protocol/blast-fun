import { testClient } from "../../../../../core/test/fixtures/lib/web-security/client-address.ts";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import test from "node:test";

import { createPrivyTokenVerifier } from "@blast/core/lib/privy-adapter/token-verifier.ts";
import type { RateBucket, RateLimitDecision, RateLimitPort, RateLimitSubject } from "@blast/core/lib/web-security/rate-limits.ts";
import { PRESALE_ERRORS, type PresaleErrorCode } from "@blast/core/modules/presale/contracts/errors.ts";
import type { AccountWalletsResponse } from "@blast/core/modules/presale/contracts/web-api.ts";
import { createPresaleValidator } from "@blast/core/modules/presale/contracts/validate.ts";
import { fixtureChainNode, SUI_MAINNET_CHAIN_IDENTIFIER } from "../../../../../core/test/fixtures/modules/presale/deployment/fixtures.ts";
import { createPresaleDeploymentGate } from "@blast/core/modules/presale/deployment/service.ts";
import { PresaleRouteError } from "@blast/core/modules/presale/route-kit/errors.ts";
import { createPresaleRouteKit } from "@blast/core/modules/presale/route-kit/route.ts";
import { PostgresLinkedWalletStore } from "@blast/server/modules/presale/account/repository.ts";
import { createAccountWalletsRoutes, type LinkedWallet, type LinkedWalletStore } from "@blast/server/modules/presale/account/wallets.ts";

/**
 * T-011 (REQ-034, AC-136, AC-137, AC-107 support): `GET /api/account/wallets`
 * as a Request -> Response handler, with a real Privy token verifier over a
 * fixture key, an in-memory linked-wallet store, a fixture embedded-wallet
 * resolver and an in-memory rate-limit port. The Postgres store, the Privy
 * gateway and the real `presale_account_wallets` budget are in
 * wallets.integration.test.ts. Proxy-to-route authorization is covered in
 * wallets-gate.test.ts.
 */

const ORIGIN = "https://blast.fun";
const APP_ID = "presale-account-wallets-app";
const NOW = Math.floor(Date.now() / 1_000);
const DID = "did:privy:presale-wallets-user";
const PRIVY_EMBEDDED = `0x${"5a".repeat(32)}`;
const LINKED_EMBEDDED = `0x${"1e".repeat(32)}`;
const LINKED_SLUSH = `0x${"2f".repeat(32)}`;
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
  refuse: { retryAfterSeconds: number } | null = null;
  async consume(bucket: RateBucket, subject: RateLimitSubject): Promise<RateLimitDecision> {
    this.calls.push({ bucket, subject });
    const retryAfterSeconds = this.refuse?.retryAfterSeconds ?? 0;
    return { allowed: !this.refuse, bucket, policyVersion: 1, retryAfterSeconds };
  }
}

/** Linked wallets by DID, as the store returns them; every read is recorded. */
class MemoryStore implements LinkedWalletStore {
  readonly rows = new Map<string, LinkedWallet[]>();
  readonly reads: string[] = [];
  async list(did: string): Promise<LinkedWallet[]> {
    this.reads.push(did);
    return this.rows.get(did) ?? [];
  }
}

/** The Privy embedded wallet by DID (null without one); `outage` throws like a Privy outage on a cache miss. */
function embeddedWallets(addresses: Record<string, string | null>, options: { outage?: boolean } = {}) {
  const calls: string[] = [];
  return {
    calls,
    async find(did: string) {
      calls.push(did);
      if (options.outage) throw new PresaleRouteError("identity_unavailable");
      return addresses[did] ?? null;
    },
  };
}

function routes(options: {
  store?: LinkedWalletStore;
  limiter?: MemoryLimiter;
  embedded?: ReturnType<typeof embeddedWallets>;
} = {}) {
  const kit = createPresaleRouteKit({
    expectedOrigin: ORIGIN,
    verifyAccessToken: createPrivyTokenVerifier({ appId: APP_ID, verificationKey }),
    limiter: options.limiter ?? new MemoryLimiter(),
    deployment: createPresaleDeploymentGate({
      environment: {},
      node: async () => fixtureChainNode(SUI_MAINNET_CHAIN_IDENTIFIER),
    }),
  });
  return createAccountWalletsRoutes({
    kit,
    store: options.store ?? new MemoryStore(),
    embeddedWallets: options.embedded ?? embeddedWallets({ [DID]: PRIVY_EMBEDDED }),
  });
}

function get(headers: Record<string, string> = { authorization: `Bearer ${token()}` }): Request {
  return new Request(`${ORIGIN}/api/account/wallets`, { headers });
}

/** A 200 body, checked against the published response schema. */
async function walletsBody(response: Response): Promise<AccountWalletsResponse> {
  const body = (await response.json()) as AccountWalletsResponse;
  assert.equal(response.status, 200, JSON.stringify(body));
  assert.deepEqual(validator.validate("account-wallets-response", body).errors, []);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.ok(response.headers.get("x-request-id"));
  return body;
}

/** Asserts a published error: status, code, closed schema and the kit's headers. */
async function assertError(response: Response, code: PresaleErrorCode): Promise<void> {
  const body = (await response.json()) as { error: { code: string } };
  assert.equal(body.error.code, code, JSON.stringify(body));
  assert.equal(response.status, PRESALE_ERRORS[code].status);
  assert.deepEqual(validator.validate(`errors/${code}`, body).errors, []);
  assert.equal(response.headers.get("cache-control"), "no-store");
}

test("a Blast Account with an embedded and a Slush wallet gets both, plus a different Privy embedded wallet", async () => {
  const store = new MemoryStore();
  store.rows.set(DID, [
    { address: LINKED_SLUSH, kind: "slush", primary: true },
    { address: LINKED_EMBEDDED, kind: "embedded", primary: false },
  ]);
  const embedded = embeddedWallets({ [DID]: PRIVY_EMBEDDED });
  assert.deepEqual(await walletsBody(await routes({ store, embedded }).GET(get(), testClient())), {
    wallets: [
      { address: LINKED_SLUSH, kind: "slush", primary: true },
      { address: LINKED_EMBEDDED, kind: "embedded", primary: false },
      { address: PRIVY_EMBEDDED, kind: "embedded", primary: false },
    ],
  });
  assert.deepEqual(store.reads, [DID]);
  assert.deepEqual(embedded.calls, [DID]);
});

test("the Privy embedded wallet already linked to the Blast Account is listed once, as linked", async () => {
  const store = new MemoryStore();
  store.rows.set(DID, [
    { address: PRIVY_EMBEDDED, kind: "embedded", primary: true },
    { address: LINKED_SLUSH, kind: "slush", primary: false },
  ]);
  assert.deepEqual(await walletsBody(await routes({ store }).GET(get(), testClient())), {
    wallets: [
      { address: PRIVY_EMBEDDED, kind: "embedded", primary: true },
      { address: LINKED_SLUSH, kind: "slush", primary: false },
    ],
  });
});

test("an account without a Blast Account profile gets only its embedded wallet, as primary", async () => {
  assert.deepEqual(await walletsBody(await routes().GET(get(), testClient())), {
    wallets: [{ address: PRIVY_EMBEDDED, kind: "embedded", primary: true }],
  });
});

test("an account with neither a profile nor an embedded wallet gets an empty list; a profile alone gets its wallets", async () => {
  const embedded = embeddedWallets({});
  assert.deepEqual(await walletsBody(await routes({ embedded }).GET(get(), testClient())), { wallets: [] });

  const store = new MemoryStore();
  store.rows.set(DID, [{ address: LINKED_SLUSH, kind: "slush", primary: true }]);
  assert.deepEqual(await walletsBody(await routes({ store, embedded }).GET(get(), testClient())), {
    wallets: [{ address: LINKED_SLUSH, kind: "slush", primary: true }],
  });
});

test("a missing or invalid token is 401 unauthorized, and nothing is read or counted", async () => {
  const store = new MemoryStore();
  const limiter = new MemoryLimiter();
  const embedded = embeddedWallets({ [DID]: PRIVY_EMBEDDED });
  const wallets = routes({ store, limiter, embedded });
  await assertError(await wallets.GET(get({}), testClient()), "unauthorized");
  await assertError(await wallets.GET(get({ authorization: "Bearer not-a-token" }), testClient()), "unauthorized");
  await assertError(await wallets.GET(get({ authorization: `Bearer ${token({ aud: "another-app" })}` }), testClient()), "unauthorized");
  await assertError(await wallets.GET(get({ authorization: `Bearer ${token({ exp: NOW - 3_600 })}` }), testClient()), "unauthorized");
  await assertError(await wallets.GET(get({ authorization: token() }), testClient()), "unauthorized");
  assert.deepEqual(store.reads, []);
  assert.deepEqual(embedded.calls, []);
  assert.equal(limiter.calls.length, 0, "an anonymous request spends no account budget");
});

test("every request counts in presale_account_wallets for its account; a refusal is rate_limited with Retry-After", async () => {
  const store = new MemoryStore();
  const limiter = new MemoryLimiter();
  const wallets = routes({ store, limiter });
  await walletsBody(await wallets.GET(get(), testClient()));
  await walletsBody(await wallets.GET(get({ authorization: `Bearer ${token({ sid: "s-2" })}` }), testClient()));
  assert.deepEqual(limiter.calls.map((call) => [call.bucket, call.subject.accountId]), [
    ["presale_account_wallets", DID],
    ["presale_account_wallets", DID],
  ]);

  limiter.refuse = { retryAfterSeconds: 42 };
  const refused = await wallets.GET(get(), testClient());
  await assertError(refused, "rate_limited");
  assert.equal(refused.headers.get("retry-after"), "42");
  assert.equal(store.reads.length, 2, "a refused request reads nothing");
});

test("a Privy outage on an uncached DID is a 503 with Retry-After, never a partial list", async () => {
  const store = new MemoryStore();
  store.rows.set(DID, [{ address: LINKED_SLUSH, kind: "slush", primary: true }]);
  const embedded = embeddedWallets({}, { outage: true });
  const response = await routes({ store, embedded }).GET(get(), testClient());
  // The route publishes no identity_unavailable, so the kit answers service_unavailable.
  await assertError(response, "service_unavailable");
  assert.match(response.headers.get("retry-after") ?? "", /^[1-9][0-9]*$/);
});

test("the Postgres store resolves its pool per call, so a database configuration error is service_unavailable", async () => {
  let resolved = 0;
  const store = new PostgresLinkedWalletStore(() => {
    resolved += 1;
    throw new Error("DATABASE_URL is required.");
  });
  const wallets = routes({ store });
  assert.equal(resolved, 0, "building the handler resolves no pool");
  await assertError(await wallets.GET(get({}), testClient()), "unauthorized");
  assert.equal(resolved, 0, "an anonymous request resolves no pool");
  await assertError(await wallets.GET(get(), testClient()), "service_unavailable");
  assert.equal(resolved, 1);
});
