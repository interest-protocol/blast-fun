import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import test from "node:test";
import {
  createEmbeddedSuiWalletResolver,
  createPrivyOnboardingAdapter,
  createPrivySessionVerifier,
  probePrivyProviderContract,
} from "@blast/server/lib/privy-adapter/adapter.ts";
import { PrivyAdapterError } from "@blast/core/lib/privy-adapter/errors.ts";
import {
  createSyntheticPrivyGateway,
  SYNTHETIC_PRIVY_DID,
  SYNTHETIC_SUI_ADDRESS,
  SYNTHETIC_X_SUBJECT,
  SYNTHETIC_GOOGLE_PRIVY_DID,
  SYNTHETIC_GOOGLE_SUI_ADDRESS,
  syntheticGoogleOnlyUser,
  syntheticPrivyUser,
} from "../../../../core/test/fixtures/lib/privy-adapter/fixtures.ts";
import { createPrivyHttpGateway, parsePrivyConfig, productionPrivyGateway } from "@blast/server/lib/privy-adapter/http-gateway.ts";
import { createPrivyTokenVerifier } from "@blast/core/lib/privy-adapter/token-verifier.ts";
import type { PrivyProviderGateway } from "@blast/core/lib/privy-adapter/types.ts";

const NOW = 2_000_000_000;
const APP_ID = "synthetic-privy-app";

const signingKeys = generateKeyPairSync("ec", { namedCurve: "P-256" });
const forgedKeys = generateKeyPairSync("ec", { namedCurve: "P-256" });
const verificationKey = signingKeys.publicKey.export({
  format: "pem",
  type: "spki",
}).toString();

function accessToken(
  claims: Record<string, unknown> = {},
  privateKey = signingKeys.privateKey,
): string {
  const header = Buffer.from(JSON.stringify({ alg: "ES256", typ: "JWT" })).toString(
    "base64url",
  );
  const payload = Buffer.from(
    JSON.stringify({
      aud: APP_ID,
      exp: NOW + 3_600,
      iat: NOW - 60,
      iss: "privy.io",
      sid: "synthetic-session-proof",
      sub: SYNTHETIC_PRIVY_DID,
      ...claims,
    }),
  ).toString("base64url");
  const signature = sign("sha256", Buffer.from(`${header}.${payload}`), {
    dsaEncoding: "ieee-p1363",
    key: privateKey,
  }).toString("base64url");
  return `${header}.${payload}.${signature}`;
}

function errorCode(error: unknown): string | undefined {
  return error instanceof PrivyAdapterError ? error.code : undefined;
}

test("verifies ES256 signature, issuer, audience, app ID, and expiry", async () => {
  const verify = createPrivyTokenVerifier({
    appId: APP_ID,
    now: () => NOW,
    verificationKey,
  });

  const claims = await verify(accessToken());
  assert.equal(claims.userId, SYNTHETIC_PRIVY_DID);
  assert.equal(claims.appId, APP_ID);

  await assert.rejects(verify(accessToken({}, forgedKeys.privateKey)), (error) => {
    assert.equal(errorCode(error), "INVALID_ACCESS_TOKEN");
    return true;
  });
  await assert.rejects(verify(accessToken({ exp: NOW - 60 })), (error) => {
    assert.equal(errorCode(error), "ACCESS_TOKEN_EXPIRED");
    return true;
  });
  for (const token of [
    accessToken({ iss: "attacker.example" }),
    accessToken({ aud: "another-privy-app" }),
    "not-a-jwt",
  ]) {
    await assert.rejects(verify(token), (error) => {
      assert.equal(errorCode(error), "INVALID_ACCESS_TOKEN");
      return true;
    });
  }
});

test("returns only normalized X identity and an existing canonical Sui wallet", async () => {
  const adapter = createPrivyOnboardingAdapter({
    appId: APP_ID,
    gateway: createSyntheticPrivyGateway("success"),
    now: () => NOW,
  });

  const proof = await adapter.verifyXIdentityAndResolveWallet(
    "synthetic-access-token",
  );
  assert.deepEqual(proof, {
    identity: {
      authProvider: "privy",
      avatarReference: "https://images.example.test/blast-pilot.png",
      callsignSuggestion: "BLAST_PILOT",
      displayNameSuggestion: "Blast Pilot",
      handle: "blast_pilot",
      privyDid: SYNTHETIC_PRIVY_DID,
      proofReference: "synthetic-session-proof",
      socialProvider: "x",
      verifiedAtEpochSeconds: 1_999_999_900,
      xSubject: SYNTHETIC_X_SUBJECT,
    },
    wallet: {
      address: SYNTHETIC_SUI_ADDRESS,
      chain: "sui",
      created: false,
      custodyProvider: "privy",
      privyDid: SYNTHETIC_PRIVY_DID,
      providerWalletReference: "wallet-synthetic-existing",
    },
  });
  assert.deepEqual(
    await adapter.verifyXIdentity("synthetic-access-token"),
    proof.identity,
  );
  assert.equal(JSON.stringify(proof).includes("must-never-escape"), false);
});

test("recognizes Privy's canonical wallet_client_type field", async () => {
  const fixture = createSyntheticPrivyGateway("success");
  const gateway: PrivyProviderGateway = {
    ...fixture,
    async getUser() {
      const user = syntheticPrivyUser();
      return {
        ...user,
        linked_accounts: user.linked_accounts.map((account) => {
          if (account.type !== "wallet") return account;
          const canonical = { ...account };
          delete canonical.wallet_client;
          return canonical;
        }),
      };
    },
  };
  const adapter = createPrivyOnboardingAdapter({
    appId: APP_ID,
    gateway,
    now: () => NOW,
  });

  const proof = await adapter.verifyXIdentityAndGetExistingWallet(
    "synthetic-access-token",
  );
  assert.equal(proof.wallet.address, SYNTHETIC_SUI_ADDRESS);
});

test("creates only a user-owned Sui wallet when one is absent", async () => {
  const calls: unknown[] = [];
  const fixture = createSyntheticPrivyGateway("success", { withWallet: false });
  const gateway: PrivyProviderGateway = {
    ...fixture,
    async createEmbeddedSuiWallet(input) {
      calls.push(input);
      return fixture.createEmbeddedSuiWallet(input);
    },
  };
  const adapter = createPrivyOnboardingAdapter({
    appId: APP_ID,
    gateway,
    now: () => NOW,
  });

  const proof = await adapter.verifyXIdentityAndResolveWallet(
    "synthetic-access-token",
  );
  assert.equal(proof.wallet.created, true);
  assert.deepEqual(calls, [
    { chainType: "sui", ownerPrivyDid: SYNTHETIC_PRIVY_DID },
  ]);
  assert.doesNotMatch(JSON.stringify(calls), /transaction|transfer|gas/i);
});

test("recovery lookup never creates a missing embedded wallet", async () => {
  let createCalls = 0;
  const fixture = createSyntheticPrivyGateway("success", { withWallet: false });
  const adapter = createPrivyOnboardingAdapter({
    appId: APP_ID,
    gateway: {
      ...fixture,
      async createEmbeddedSuiWallet(input) {
        createCalls += 1;
        return fixture.createEmbeddedSuiWallet(input);
      },
    },
    now: () => NOW,
  });

  await assert.rejects(
    adapter.verifyXIdentityAndGetExistingWallet("synthetic-access-token"),
    (error) => errorCode(error) === "WALLET_RESOLUTION_FAILED",
  );
  assert.equal(createCalls, 0);
});

test("maps malformed, expired, and timeout fixtures to safe errors", async () => {
  for (const [mode, expectedCode] of [
    ["malformed-token", "INVALID_ACCESS_TOKEN"],
    ["expired", "ACCESS_TOKEN_EXPIRED"],
    ["provider-timeout", "PROVIDER_TIMEOUT"],
  ] as const) {
    const adapter = createPrivyOnboardingAdapter({
      appId: APP_ID,
      gateway: createSyntheticPrivyGateway(mode),
      now: () => NOW,
    });
    await assert.rejects(
      adapter.verifyXIdentityAndResolveWallet("synthetic-access-token"),
      (error) => {
        assert.equal(errorCode(error), expectedCode);
        assert.equal(JSON.stringify(error).includes("must-never-escape"), false);
        return true;
      },
    );
  }
});

test("does not create a wallet until a verified X account exists", async () => {
  let createCalls = 0;
  const fixture = createSyntheticPrivyGateway("success", { withWallet: false });
  const gateway: PrivyProviderGateway = {
    ...fixture,
    async getUser() {
      return { id: SYNTHETIC_PRIVY_DID, linked_accounts: [] };
    },
    async createEmbeddedSuiWallet(input) {
      createCalls += 1;
      return fixture.createEmbeddedSuiWallet(input);
    },
  };
  const adapter = createPrivyOnboardingAdapter({
    appId: APP_ID,
    gateway,
    now: () => NOW,
  });

  await assert.rejects(
    adapter.verifyXIdentityAndResolveWallet("synthetic-access-token"),
    (error) => errorCode(error) === "IDENTITY_NOT_FOUND",
  );
  assert.equal(createCalls, 0);
});

test("HTTP gateway uses the documented read and Sui create contracts", async () => {
  const requests: Array<{ body: string | null; method: string; url: string }> = [];
  const fakeFetch: typeof fetch = async (input, init) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    requests.push({
      body: typeof init?.body === "string" ? init.body : null,
      method,
      url,
    });
    return Response.json(
      method === "POST"
        ? { address: SYNTHETIC_SUI_ADDRESS, chain_type: "sui", id: "created" }
        : syntheticPrivyUser(),
    );
  };
  const gateway = createPrivyHttpGateway({
    appId: APP_ID,
    appSecret: "synthetic-secret",
    baseUrl: "https://privy.example.test",
    fetch: fakeFetch,
    jwtVerificationKey: verificationKey,
  });

  await gateway.getUser(SYNTHETIC_PRIVY_DID);
  await gateway.createEmbeddedSuiWallet({
    chainType: "sui",
    ownerPrivyDid: SYNTHETIC_PRIVY_DID,
  });

  assert.deepEqual(requests, [
    {
      body: null,
      method: "GET",
      url: `https://privy.example.test/v1/users/${encodeURIComponent(SYNTHETIC_PRIVY_DID)}`,
    },
    {
      body: JSON.stringify({
        chain_type: "sui",
        owner: { user_id: SYNTHETIC_PRIVY_DID },
      }),
      method: "POST",
      url: "https://privy.example.test/v1/wallets",
    },
  ]);
  assert.doesNotMatch(JSON.stringify(requests), /transaction|transfer|gas/i);
});

test("provider probe is read-only and bounded", async () => {
  let createCalls = 0;
  const gateway: PrivyProviderGateway = {
    async createEmbeddedSuiWallet() {
      createCalls += 1;
      throw new Error("must not be called");
    },
    async getUser() {
      return new Promise(() => undefined);
    },
    async verifyAccessToken() {
      throw new Error("must not be called");
    },
  };

  await assert.rejects(
    probePrivyProviderContract(gateway, SYNTHETIC_PRIVY_DID, 10),
    (error) => errorCode(error) === "PROVIDER_TIMEOUT",
  );
  assert.equal(createCalls, 0);
});

function capturedMetrics(): { restore(): void; records: Array<Record<string, unknown>> } {
  const records: Array<Record<string, unknown>> = [];
  const original = console.info;
  console.info = (line: unknown) => {
    if (typeof line === "string" && line.startsWith("{")) records.push(JSON.parse(line));
  };
  return { records, restore: () => { console.info = original; } };
}

function scriptedGateway(
  responses: Array<(signal?: AbortSignal | null) => Response | Promise<Response>>,
  overrides: Partial<Parameters<typeof createPrivyHttpGateway>[0]> = {},
) {
  let calls = 0;
  const sleeps: number[] = [];
  const gateway = createPrivyHttpGateway({
    appId: APP_ID,
    appSecret: "synthetic-secret",
    baseUrl: "https://privy.example.test",
    fetch: async (_input, init) => {
      const next = responses[Math.min(calls, responses.length - 1)];
      calls += 1;
      return next(init?.signal);
    },
    jwtVerificationKey: verificationKey,
    random: () => 1,
    sleep: async (delayMs) => { sleeps.push(delayMs); },
    ...overrides,
  });
  return { gateway, sleeps, calls: () => calls };
}

const busy = (status: number, headers: Record<string, string> = {}) => () =>
  new Response("{}", { status, headers });
const ok = () => Response.json(syntheticPrivyUser());

test("HTTP gateway retries 429/502/503/504 honouring Retry-After and reports privy.request", async () => {
  const metrics = capturedMetrics();
  try {
    const { gateway, sleeps, calls } = scriptedGateway([
      busy(429, { "Retry-After": "1" }),
      busy(503),
      ok,
    ]);
    await gateway.getUser(SYNTHETIC_PRIVY_DID);
    assert.equal(calls(), 3);
    assert.deepEqual(sleeps, [1_000, 500]);
    const metric = metrics.records.find((record) => record.metric === "privy.request");
    assert.equal(metric?.endpoint, "users");
    assert.equal(metric?.status, "200");
    assert.equal(metric?.retries, 2);
    assert.equal(typeof metric?.durationMs, "number");
    assert.doesNotMatch(JSON.stringify(metrics.records), /synthetic-secret|did:privy/);
  } finally {
    metrics.restore();
  }

  for (const status of [502, 504]) {
    const { gateway, calls } = scriptedGateway([busy(status), ok]);
    await gateway.createEmbeddedSuiWallet({ chainType: "sui", ownerPrivyDid: SYNTHETIC_PRIVY_DID });
    assert.equal(calls(), 2);
  }
});

test("HTTP gateway retries at most twice and adds at most two seconds of waiting", async () => {
  const exhausted = scriptedGateway([busy(503)]);
  await assert.rejects(exhausted.gateway.getUser(SYNTHETIC_PRIVY_DID),
    (error) => errorCode(error) === "PROVIDER_UNAVAILABLE");
  assert.equal(exhausted.calls(), 3);
  assert.ok(exhausted.sleeps.reduce((sum, delay) => sum + delay, 0) <= 2_000);

  const tooLong = scriptedGateway([busy(429, { "Retry-After": "5" }), ok]);
  await assert.rejects(tooLong.gateway.getUser(SYNTHETIC_PRIVY_DID),
    (error) => errorCode(error) === "PROVIDER_UNAVAILABLE");
  assert.equal(tooLong.calls(), 1);
  assert.deepEqual(tooLong.sleeps, []);

  const budget = scriptedGateway([
    busy(429, { "Retry-After": "1" }),
    busy(503, { "Retry-After": "2" }),
    ok,
  ]);
  await assert.rejects(budget.gateway.getUser(SYNTHETIC_PRIVY_DID),
    (error) => errorCode(error) === "PROVIDER_UNAVAILABLE");
  assert.equal(budget.calls(), 2);
  assert.deepEqual(budget.sleeps, [1_000]);

  const dated = scriptedGateway([
    busy(429, { "Retry-After": new Date(Date.now() + 60_000).toUTCString() }),
    ok,
  ]);
  await assert.rejects(dated.gateway.getUser(SYNTHETIC_PRIVY_DID),
    (error) => errorCode(error) === "PROVIDER_UNAVAILABLE");
  assert.equal(dated.calls(), 1);

  for (const status of [400, 401, 404, 500]) {
    const final = scriptedGateway([busy(status), ok]);
    await assert.rejects(final.gateway.getUser(SYNTHETIC_PRIVY_DID),
      (error) => errorCode(error) === "PROVIDER_UNAVAILABLE");
    assert.equal(final.calls(), 1);
  }

  const timeout = scriptedGateway([(signal) => new Promise<Response>((_resolve, reject) => {
    signal?.addEventListener("abort", () => reject(new Error("aborted")));
  })], { timeoutMs: 5 });
  await assert.rejects(timeout.gateway.getUser(SYNTHETIC_PRIVY_DID),
    (error) => errorCode(error) === "PROVIDER_TIMEOUT");
  assert.equal(timeout.calls(), 1);
});

test("HTTP gateway bounds concurrent Privy calls and sheds load after the queue timeout", async () => {
  const { createSemaphore } = await import("@blast/server/lib/concurrency.ts");
  const limiter = createSemaphore(1);
  let unblock: () => void = () => undefined;
  const held = new Promise<Response>((resolve) => { unblock = () => resolve(ok()); });
  let calls = 0;
  const gateway = createPrivyHttpGateway({
    appId: APP_ID,
    appSecret: "synthetic-secret",
    baseUrl: "https://privy.example.test",
    fetch: async () => { calls += 1; return calls === 1 ? held : ok(); },
    jwtVerificationKey: verificationKey,
    limiter,
    queueTimeoutMs: 20,
  });
  const first = gateway.getUser(SYNTHETIC_PRIVY_DID);
  const started = performance.now();
  await assert.rejects(gateway.getUser(SYNTHETIC_PRIVY_DID),
    (error) => errorCode(error) === "PROVIDER_UNAVAILABLE");
  assert.ok(performance.now() - started < 1_000);
  assert.equal(calls, 1);
  const queued = gateway.getUser(SYNTHETIC_PRIVY_DID);
  unblock();
  await first;
  await queued;
  assert.equal(calls, 2);
  assert.equal(limiter.active, 0);
});

test("rejects HTTP avatars even when a loopback mock origin is configured", async () => {
  const withAvatar = (url: string): PrivyProviderGateway => {
    const fixture = createSyntheticPrivyGateway("success");
    return {
      ...fixture,
      async getUser() {
        const user = syntheticPrivyUser();
        return {
          ...user,
          linked_accounts: user.linked_accounts.map((account) =>
            account.type === "twitter_oauth"
              ? { ...account, profile_picture_url: url }
              : account,
          ),
        };
      },
    };
  };
  const avatarFor = async (url: string) =>
    (await createPrivyOnboardingAdapter({
      appId: APP_ID,
      gateway: withAvatar(url),
      now: () => NOW,
    }).verifyXIdentity("synthetic-access-token")).avatarReference;

  const previous = process.env.X_AVATAR_ORIGIN;
  try {
    delete process.env.X_AVATAR_ORIGIN;
    assert.equal(await avatarFor("http://127.0.0.1:4010/avatars/1.png"), null);

    process.env.X_AVATAR_ORIGIN = "http://127.0.0.1:4010";
    assert.equal(
      await avatarFor("http://127.0.0.1:4010/avatars/1.png"),
      null,
    );
    assert.equal(await avatarFor("http://127.0.0.1:4011/avatars/1.png"), null);
    assert.equal(await avatarFor("http://images.example.test/a.png"), null);
    assert.equal(
      await avatarFor("https://images.example.test/a.png"),
      "https://images.example.test/a.png",
    );

    process.env.X_AVATAR_ORIGIN = "http://images.example.test";
    assert.equal(await avatarFor("http://images.example.test/a.png"), null);
  } finally {
    if (previous === undefined) delete process.env.X_AVATAR_ORIGIN;
    else process.env.X_AVATAR_ORIGIN = previous;
  }
});

test("session verifier normalizes any verified Privy session without requiring X", async () => {
  const withWallet = createPrivySessionVerifier({
    appId: APP_ID,
    gateway: createSyntheticPrivyGateway("success"),
    now: () => NOW,
  });
  assert.deepEqual(await withWallet.verifySession("synthetic-access-token"), {
    privyDid: SYNTHETIC_PRIVY_DID,
    suiWalletAddress: SYNTHETIC_SUI_ADDRESS,
  });

  const gateway = createSyntheticPrivyGateway("success", { withWallet: false });
  const withoutX: PrivyProviderGateway = {
    ...gateway,
    async getUser() {
      return { id: SYNTHETIC_PRIVY_DID, linked_accounts: [{ type: "email", address: "pilot@example.test" }] };
    },
  };
  const session = await createPrivySessionVerifier({ appId: APP_ID, gateway: withoutX, now: () => NOW })
    .verifySession("synthetic-access-token");
  assert.deepEqual(session, { privyDid: SYNTHETIC_PRIVY_DID, suiWalletAddress: null });
  assert.deepEqual(Object.keys(session).sort(), ["privyDid", "suiWalletAddress"], "no provider payload escapes");
});

test("session verifier maps invalid, expired, and provider failures to safe errors", async () => {
  const cases = [
    ["malformed-token", "INVALID_ACCESS_TOKEN"],
    ["expired", "ACCESS_TOKEN_EXPIRED"],
    ["provider-timeout", "PROVIDER_TIMEOUT"],
  ] as const;
  for (const [mode, code] of cases) {
    const verifier = createPrivySessionVerifier({
      appId: APP_ID,
      gateway: createSyntheticPrivyGateway(mode),
      now: () => NOW,
    });
    await assert.rejects(verifier.verifySession("synthetic-access-token"), (error) => {
      assert.equal(errorCode(error), code, mode);
      return true;
    });
  }
  const crashing: PrivyProviderGateway = {
    ...createSyntheticPrivyGateway("success"),
    async getUser() {
      throw new Error("socket hang up with did:privy:synthetic-blast-user");
    },
  };
  await assert.rejects(
    createPrivySessionVerifier({ appId: APP_ID, gateway: crashing, now: () => NOW })
      .verifySession("synthetic-access-token"),
    (error) => {
      assert.equal(errorCode(error), "PROVIDER_UNAVAILABLE");
      assert.doesNotMatch(String((error as Error).message), /did:privy/);
      return true;
    },
  );
  const otherUser: PrivyProviderGateway = {
    ...createSyntheticPrivyGateway("success"),
    async getUser() {
      return { id: "did:privy:someone-else", linked_accounts: [] };
    },
  };
  await assert.rejects(
    createPrivySessionVerifier({ appId: APP_ID, gateway: otherUser, now: () => NOW })
      .verifySession("synthetic-access-token"),
    (error) => errorCode(error) === "PROVIDER_RESPONSE_INVALID",
  );
  await assert.rejects(
    createPrivySessionVerifier({ appId: APP_ID, gateway: createSyntheticPrivyGateway("success"), now: () => NOW })
      .verifySession(""),
    (error) => errorCode(error) === "INVALID_ACCESS_TOKEN",
  );
});

test("resolveEmbeddedSuiWallet needs no X account, caches the address, and never creates a wallet", async () => {
  const cache = new Map<string, string>();
  const calls: string[] = [];
  let user: unknown = syntheticGoogleOnlyUser();
  let outage = false;
  const gateway: PrivyProviderGateway = {
    async getUser(did) {
      calls.push(`getUser:${did}`);
      if (outage) throw new PrivyAdapterError("PROVIDER_UNAVAILABLE");
      return user;
    },
    async createEmbeddedSuiWallet() {
      calls.push("create");
      throw new Error("the resolver must never create a wallet");
    },
    async verifyAccessToken() {
      throw new Error("the resolver never verifies tokens");
    },
  };
  const resolver = createEmbeddedSuiWalletResolver({
    cache: {
      get: async (did) => cache.get(did) ?? null,
      put: async (did, address) => void cache.set(did, address),
    },
    gateway,
  });

  assert.equal(await resolver.resolveEmbeddedSuiWallet(SYNTHETIC_GOOGLE_PRIVY_DID), SYNTHETIC_GOOGLE_SUI_ADDRESS);
  assert.deepEqual([...cache], [[SYNTHETIC_GOOGLE_PRIVY_DID, SYNTHETIC_GOOGLE_SUI_ADDRESS]]);
  outage = true;
  assert.equal(
    await resolver.resolveEmbeddedSuiWallet(SYNTHETIC_GOOGLE_PRIVY_DID),
    SYNTHETIC_GOOGLE_SUI_ADDRESS,
    "a cached user resolves during an outage",
  );
  assert.deepEqual(calls, [`getUser:${SYNTHETIC_GOOGLE_PRIVY_DID}`]);

  const other = "did:privy:synthetic-no-wallet";
  user = { ...syntheticGoogleOnlyUser({ wallet: false }), id: other };
  await assert.rejects(resolver.resolveEmbeddedSuiWallet(other), (error) => errorCode(error) === "PROVIDER_UNAVAILABLE");
  outage = false;
  assert.equal(await resolver.resolveEmbeddedSuiWallet(other), null, "no embedded Sui wallet");
  assert.equal(cache.has(other), false, "an absent wallet is not cached");
  user = { ...syntheticGoogleOnlyUser(), id: "did:privy:someone-else" };
  await assert.rejects(resolver.resolveEmbeddedSuiWallet(other), (error) => errorCode(error) === "PROVIDER_RESPONSE_INVALID");
  await assert.rejects(resolver.resolveEmbeddedSuiWallet("not-a-did"), (error) => errorCode(error) === "INVALID_ACCESS_TOKEN");
  assert.equal(calls.includes("create"), false);
});

test("environment mock origins cannot redirect the production Privy gateway", async (t) => {
  const requested: string[] = [];
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL) => {
    requested.push(String(input));
    return Response.json(syntheticPrivyUser());
  });
  const gateway = productionPrivyGateway(parsePrivyConfig({NODE_ENV: "production", PRIVY_APP_ID: APP_ID, PRIVY_APP_SECRET: "secret", PRIVY_JWT_VERIFICATION_KEY: String(verificationKey), PRIVY_API_BASE_URL: "http://127.0.0.1:9999"}));
  await gateway.getUser(SYNTHETIC_PRIVY_DID);
  assert.deepEqual(requested, [`https://api.privy.io/v1/users/${encodeURIComponent(SYNTHETIC_PRIVY_DID)}`]);
});
