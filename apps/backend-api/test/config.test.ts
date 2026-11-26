import { deploymentIdentity } from "@blast/core/lib/config/deployment-identity.ts";
import { capacityFixture } from "./capacity-fixture.ts";
import assert from "node:assert/strict";
import test from "node:test";
import { quotaNamespace } from "@blast/core/lib/web-security/redis-rate-limits.ts";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { backendConfig } from "../src/app/api/config.ts";
import { HINTS_FORBIDDEN } from "../src/app/hints/config.ts";
import { RUNTIME_TEST_ENVIRONMENT } from "../../../packages/server/test/fixtures/config/runtime-config.ts";
import { takeProcessSingleton } from "@blast/core/lib/process-singleton.ts";
import { parseRelayConfig } from "@blast/server/private/relay-config.ts";
import {
  createPartnerV1Read,
  type PartnerV1Handlers,
} from "@blast/server/modules/partner-api/v1/route.ts";
import { applyPartnerApiHeaders } from "@blast/server/modules/partner-api/v1/response.ts";
import { partnerResponseHeaders } from "@blast/core/modules/backend-api/partner-http.ts";
import {
  backendFirstPartyRead,
  backendPartnerRelay,
  createBackendRelay,
  firstPartyCanonicalPath,
} from "../../web/src/modules/partner-api/v1/relay.ts";
import { testClient } from "../../../packages/core/test/fixtures/lib/web-security/client-address.ts";

const neon = (login: string, endpoint: string) =>
  `postgresql://${login}:synthetic@${endpoint}-pooler.c-2.us-east-1.aws.neon.tech/blast?sslmode=verify-full`;
const base = {
  ...RUNTIME_TEST_ENVIRONMENT,
  DATABASE_URL: neon("blast_app", "ep-main-1"),
  DATABASE_REPLICA_URL: neon("blast_reader", "ep-read-2"),
  PARTNER_VERIFIER_DATABASE_URL: neon("blast_verifier", "ep-main-1"),
  BLAST_PARTNER_CAPACITY_CONFIG: capacityFixture(["fixture"]),
  BLAST_BACKEND_INGRESS_MODE: "direct",
  BLAST_REDIS_NAMESPACE: "mainnet:test:production",
  NODE_ENV: "production",
  BLAST_DEPLOYMENT_TARGET: "production",
  BLAST_QUOTA_REDIS_URL: "redis://127.0.0.1:6379",
  RATE_LIMIT_SUBJECT_PEPPER: "p".repeat(32),
  BLAST_BACKEND_GATEWAY_SECRET: "s".repeat(32),
};
test("backend boot stops on a missing runtime secret and names only the variable", () => {
  const expected = quotaNamespace(base.BLAST_REDIS_NAMESPACE, deploymentIdentity(base));
  const environment = { ...base, BLAST_BACKEND_EXPECTED_QUOTA_NAMESPACE: expected };
  assert.throws(
    () => backendConfig({ ...environment, CRON_SECRET: undefined }),
    /^Error: CRON_SECRET must be set\.$/,
  );
  assert.throws(
    () => backendConfig({ ...environment, DATABASE_REPLICA_URL: base.DATABASE_URL }),
    /^Error: DATABASE_REPLICA_URL must name the read replica, not the primary\.$/,
  );
  assert.equal(backendConfig(environment).runtime.cronSecret, base.CRON_SECRET);
});

// This fails if backend boot skipped the runtime config's new rules, or read the gas pool outside it.
test("backend boot stops on a new required value or a set but invalid one, and carries the parsed settings", () => {
  const environment = {
    ...base,
    BLAST_BACKEND_EXPECTED_QUOTA_NAMESPACE: quotaNamespace(
      base.BLAST_REDIS_NAMESPACE,
      deploymentIdentity(base),
    ),
  };
  assert.throws(
    () => backendConfig({ ...environment, BLAST_INFRA_API_KEY: undefined }),
    /^Error: BLAST_INFRA_API_KEY must be set\.$/,
  );
  assert.throws(
    () =>
      backendConfig({
        ...environment,
        BLAST_NETWORK: undefined,
        BLAST_DEPLOYMENT_FINGERPRINT: undefined,
      }),
    /^Error: BLAST_NETWORK and BLAST_DEPLOYMENT_FINGERPRINT must be set\.$/,
  );
  assert.throws(
    () => backendConfig({ ...environment, PRESALE_GAS_POOL_URL: "leak-pool" }),
    (error: Error) =>
      /^PRESALE_GAS_POOL_URL /.test(error.message) && !error.message.includes("leak"),
  );
  assert.equal(backendConfig(environment).runtime.gasPool, null);
  assert.deepEqual(
    backendConfig({ ...environment, PRESALE_GAS_POOL_URL: "https://gas.blast.test" }).runtime
      .gasPool,
    { url: "https://gas.blast.test", token: null },
  );
});

test("every name a hints instance refuses is one the API reads", () => {
  const expected = quotaNamespace(base.BLAST_REDIS_NAMESPACE, deploymentIdentity(base));
  const environment: Record<string, string | undefined> = {
    ...base,
    BLAST_BACKEND_EXPECTED_QUOTA_NAMESPACE: expected,
  };
  const read = new Set<string>();
  backendConfig(
    new Proxy(environment, { get: (target, name: string) => (read.add(name), target[name]) }),
  );
  // Never on any backend.
  const elsewhere = ["WATCHER_DATABASE_URL"];

  assert.deepEqual(
    HINTS_FORBIDDEN.filter((name) => !read.has(name) && !elsewhere.includes(name)),
    [],
  );
});

test("production backend requires the exact existing quota namespace", () => {
  assert.throws(() => backendConfig(base), /quota identity/);
  const expected = quotaNamespace(base.BLAST_REDIS_NAMESPACE, deploymentIdentity(base));
  assert.equal(
    backendConfig({ ...base, BLAST_BACKEND_EXPECTED_QUOTA_NAMESPACE: expected }).namespace,
    expected,
  );
  assert.throws(
    () =>
      backendConfig({
        ...base,
        BLAST_BACKEND_EXPECTED_QUOTA_NAMESPACE: expected,
        BLAST_DEPLOYMENT_TARGET: undefined,
      }),
    /quota identity/,
  );
  const preview = {
    ...base,
    BLAST_DEPLOYMENT_TARGET: "preview",
    BLAST_DEPLOYMENT_BRANCH: "develop",
  };
  assert.notEqual(
    quotaNamespace(preview.BLAST_REDIS_NAMESPACE, deploymentIdentity(preview)),
    expected,
  );
  assert.equal(
    backendConfig({
      ...preview,
      BLAST_BACKEND_EXPECTED_QUOTA_NAMESPACE: quotaNamespace(
        preview.BLAST_REDIS_NAMESPACE,
        deploymentIdentity(preview),
      ),
    }).namespace,
    quotaNamespace(preview.BLAST_REDIS_NAMESPACE, deploymentIdentity(preview)),
  );
});
test("first-party relay allows public reads and cannot forward private account or viewer routes", () => {
  assert.equal(firstPartyCanonicalPath("/api/social/prices"), "/api/v1/prices");
  assert.equal(firstPartyCanonicalPath("/api/launchpad/market/status"), "/api/v1/market/status");
  for (const path of [
    "/api/social/me",
    "/api/social/accounts",
    "/api/social/presales/viewer",
    "/api/social/presales-admin",
    "/api/partner/prices",
  ]) {
    assert.equal(firstPartyCanonicalPath(path), null);
  }
});

test("API accepts only the creator-claim attestation signer", () => {
  const environment = {
    ...base,
    BLAST_BACKEND_EXPECTED_QUOTA_NAMESPACE: quotaNamespace(
      base.BLAST_REDIS_NAMESPACE,
      deploymentIdentity(base),
    ),
    CREATOR_CLAIM_SIGNER_KEY: Ed25519Keypair.fromSecretKey(
      new Uint8Array(32).fill(7),
    ).getSecretKey(),
  };
  assert.doesNotThrow(() => backendConfig(environment));
  for (const name of [
    "PRESALE_SIGNER_KEY",
    "BLAST_WORKER_SIGNER_KEY",
    "LAUNCHPAD_REWARDS_SIGNER_KEY",
    "BLAST_BUYBACK_SIGNER_KEY",
    "UNKNOWN_SIGNER_KEY",
  ]) {
    assert.throws(
      () => backendConfig({ ...environment, [name]: "synthetic-worker-key" }),
      /must be absent/,
      name,
    );
  }
});

test("public backend rejects signer material and implicit proxy trust", () => {
  const environment = {
    ...base,
    BLAST_BACKEND_EXPECTED_QUOTA_NAMESPACE: quotaNamespace(
      base.BLAST_REDIS_NAMESPACE,
      deploymentIdentity(base),
    ),
  };
  assert.throws(
    () =>
      backendConfig({
        ...environment,
        PRESALE_SIGNER_KEY: "synthetic-must-not-load",
      }),
    /must be absent/,
  );
  assert.throws(
    () => backendConfig({ ...environment, BLAST_BACKEND_INGRESS_MODE: undefined }),
    /explicit/,
  );
  assert.throws(
    () =>
      backendConfig({
        ...environment,
        BLAST_BACKEND_INGRESS_MODE: "trusted-proxy",
        BLAST_BACKEND_TRUSTED_PROXY_CIDRS: "10.0.0.0/8",
      }),
    /\/13\+ inside 10\.0\.0\.0\/8/,
  );
  assert.equal(
    backendConfig({
      ...environment,
      BLAST_BACKEND_INGRESS_MODE: "trusted-proxy",
      BLAST_BACKEND_TRUSTED_PROXY_CIDRS: "127.0.0.1/32,::1/128",
    }).ingress.mode,
    "trusted-proxy",
  );
});

test("missing or invalid backend configuration fails closed without local admission", async (t) => {
  const request = new Request("https://frontend.test/api/v1/prices");
  assert.equal((await backendPartnerRelay(parseRelayConfig({}))(request)).status, 503);
  assert.equal(
    (
      await backendFirstPartyRead(
        new Request("https://frontend.test/api/social/prices"),
        parseRelayConfig({}),
      )
    ).status,
    503,
  );
  const previous = process.env.BLAST_BACKEND_API_ORIGIN;
  t.after(() => {
    if (previous === undefined) {
      delete process.env.BLAST_BACKEND_API_ORIGIN;
    } else {
      process.env.BLAST_BACKEND_API_ORIGIN = previous;
    }
    takeProcessSingleton("relayConfig");
  });
  process.env.BLAST_BACKEND_API_ORIGIN = "https://user:private@backend.test/path";
  takeProcessSingleton("relayConfig");
  const response = await backendPartnerRelay()(request);
  assert.equal(response.status, 503);
  assert.equal((await response.text()).includes("private@"), false);
  assert.equal((await backendFirstPartyRead(request)).status, 503);
});

test("frontend relay preserves both wallet-cookie clearing headers", async () => {
  const headers = new Headers();
  headers.append(
    "set-cookie",
    "__Host-blast_wallet=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict",
  );
  headers.append(
    "set-cookie",
    "__Host-blast_wallet_hint=; Path=/; Max-Age=0; Secure; SameSite=Strict",
  );
  const relay = createBackendRelay("https://backend.test", "g".repeat(32), {
    firstParty: true,
    namespace: "a".repeat(64),
    clientAddress: () => "192.0.2.1",
    fetch: async () => new Response("{}", { headers }),
  });
  const response = await relay(new Request("https://frontend.test/api/launchpad/market/status"));
  assert.deepEqual(response.headers.getSetCookie(), headers.getSetCookie());
});

test("partner relay transport and configuration failures retain browser CORS and retry visibility", async () => {
  const origin = "https://partner.test";
  const request = new Request("https://frontend.test/api/v1/market/status", {
    headers: { origin },
  });
  const failed = createBackendRelay("https://backend.test", "g".repeat(32), {
    namespace: "a".repeat(64),
    clientAddress: () => "192.0.2.1",
    fetch: async () => {
      throw new Error("Synthetic transport failure.");
    },
  });
  const invalid = backendPartnerRelay(parseRelayConfig({}));
  for (const relay of [failed, invalid]) {
    const response = await relay(request);
    assert.equal(response.status, 503);
    assert.equal((await response.json()).error.code, "partner_api_unavailable");
    assert.equal(response.headers.get("access-control-allow-origin"), origin);
    assert.equal(response.headers.get("access-control-expose-headers"), "Retry-After");
    assert.equal(response.headers.get("access-control-allow-credentials"), null);
    assert.equal(response.headers.get("vary"), "Origin");
    assert.equal(response.headers.get("retry-after"), "5");
    assert.equal(response.headers.get("cache-control"), "private, no-store");
    assert.equal(response.headers.get("cdn-cache-control"), "no-store");
    assert.equal(response.headers.get("vercel-cdn-cache-control"), "no-store");
    const noOrigin = await relay(new Request(request.url));
    assert.equal(noOrigin.headers.get("access-control-allow-origin"), null);
  }
  const firstParty = createBackendRelay("https://backend.test", "g".repeat(32), {
    firstParty: true,
    namespace: "a".repeat(64),
    clientAddress: () => "192.0.2.1",
    fetch: async () => {
      throw new Error("Synthetic transport failure.");
    },
  });
  const privateFailure = await firstParty(
    new Request("https://frontend.test/api/social/prices", {
      headers: { origin },
    }),
  );
  assert.equal(privateFailure.status, 503);
  assert.equal((await privateFailure.json()).error.code, "service_unavailable");
  assert.equal(privateFailure.headers.get("access-control-allow-origin"), null);
  assert.equal(privateFailure.headers.get("access-control-expose-headers"), null);
});

test("unknown and removed partner URLs keep local404/CORS parity and never reach the backend", async () => {
  let forwarded = 0;
  const origin = "https://partner.test";
  const relay = createBackendRelay("https://backend.test", "g".repeat(32), {
    namespace: "a".repeat(64),
    clientAddress: () => "192.0.2.1",
    fetch: async () => {
      forwarded++;
      return Response.json({ unexpected: true });
    },
  });
  const local = createPartnerV1Read({} as PartnerV1Handlers);
  for (const path of ["/api/v1/unknown", "/api/partner/prices"]) {
    const request = new Request("https://frontend.test" + path, {
      headers: { origin },
    });
    const expected = applyPartnerApiHeaders(
      await local(request, testClient()),
      partnerResponseHeaders(origin),
    );
    const answer = await relay(request);
    assert.equal(answer.status, 404);
    assert.equal(answer.status, expected.status);
    const body = await answer.json();
    const original = await expected.json();
    assert.equal(body.error.code, original.error.code);
    assert.equal(body.error.message, original.error.message);
    for (const name of [
      "access-control-allow-origin",
      "access-control-expose-headers",
      "vary",
      "cache-control",
    ]) {
      assert.equal(answer.headers.get(name), expected.headers.get(name), name);
    }
  }
  const firstParty = createBackendRelay("https://backend.test", "g".repeat(32), {
    firstParty: true,
    namespace: "a".repeat(64),
    clientAddress: () => "192.0.2.1",
    fetch: async () => {
      forwarded++;
      return Response.json({ unexpected: true });
    },
  });
  const privateRead = await firstParty(
    new Request("https://frontend.test/api/social/me", { headers: { origin } }),
  );
  assert.equal(privateRead.status, 403);
  assert.equal(privateRead.headers.get("access-control-allow-origin"), null);
  assert.equal(forwarded, 0);
});

test("connected activity stream capacity is explicit and bounded by the relay budget", () => {
  const environment = {
    ...base,
    BLAST_BACKEND_EXPECTED_QUOTA_NAMESPACE: quotaNamespace(
      base.BLAST_REDIS_NAMESPACE,
      deploymentIdentity(base),
    ),
  };
  assert.equal(backendConfig(environment).maxHintStreams, 200);
  assert.equal(
    backendConfig({ ...environment, BLAST_BACKEND_MAX_HINT_STREAMS: "1" }).maxHintStreams,
    1,
  );
  assert.equal(
    backendConfig({ ...environment, BLAST_BACKEND_MAX_HINT_STREAMS: "200" }).maxHintStreams,
    200,
  );
  assert.equal(
    backendConfig({ ...environment, BLAST_BACKEND_MAX_HINT_STREAMS: "1024" }).maxHintStreams,
    1_024,
  );
  for (const value of ["0", "1025", "1.5", "NaN", "Infinity", ""]) {
    assert.throws(
      () =>
        backendConfig({
          ...environment,
          BLAST_BACKEND_MAX_HINT_STREAMS: value,
        }),
      /stream capacity/,
    );
  }
});

test("any identity can cap long private work; production keeps its default off Render", () => {
  const production = {
    ...base,
    BLAST_BACKEND_EXPECTED_QUOTA_NAMESPACE: quotaNamespace(
      base.BLAST_REDIS_NAMESPACE,
      deploymentIdentity(base),
    ),
  };
  assert.equal(backendConfig(production).maxPrivateWorkMs, undefined);
  const develop = {
    ...base,
    BLAST_DEPLOYMENT_TARGET: "develop",
    BLAST_DEPLOYMENT_BRANCH: "develop",
  };
  const environment = {
    ...develop,
    BLAST_BACKEND_EXPECTED_QUOTA_NAMESPACE: quotaNamespace(
      develop.BLAST_REDIS_NAMESPACE,
      deploymentIdentity(develop),
    ),
  };
  assert.equal(
    backendConfig({
      ...environment,
      BLAST_BACKEND_MAX_PRIVATE_WORK_MS: "280000",
    }).maxPrivateWorkMs,
    280_000,
  );
  for (const value of ["", "0", "179999", "280001", "300000", "NaN", "Infinity", "180000.5"]) {
    assert.throws(
      () =>
        backendConfig({
          ...environment,
          BLAST_BACKEND_MAX_PRIVATE_WORK_MS: value,
        }),
      /private work/,
    );
  }
  assert.equal(
    backendConfig({
      ...production,
      BLAST_BACKEND_MAX_PRIVATE_WORK_MS: "280000",
    }).maxPrivateWorkMs,
    280_000,
  );
  assert.throws(
    () =>
      backendConfig({
        ...environment,
        BLAST_DEPLOYMENT_BRANCH: "feature",
        BLAST_BACKEND_MAX_PRIVATE_WORK_MS: "280000",
      }),
    /quota identity/,
  );
  const feature = { ...develop, BLAST_DEPLOYMENT_BRANCH: "feature" };
  assert.equal(
    backendConfig({
      ...feature,
      BLAST_BACKEND_EXPECTED_QUOTA_NAMESPACE: quotaNamespace(
        feature.BLAST_REDIS_NAMESPACE,
        deploymentIdentity(feature),
      ),
      BLAST_BACKEND_MAX_PRIVATE_WORK_MS: "280000",
    }).maxPrivateWorkMs,
    280_000,
  );
});

test("on Render the API refuses to start unless its drain fits the 300-second shutdown limit", () => {
  const production = {
    ...base,
    BLAST_BACKEND_EXPECTED_QUOTA_NAMESPACE: quotaNamespace(
      base.BLAST_REDIS_NAMESPACE,
      deploymentIdentity(base),
    ),
    RENDER: "true",
  };
  assert.throws(
    () => backendConfig(production),
    /On Render the API requires BLAST_BACKEND_MAX_PRIVATE_WORK_MS/,
  );
  assert.equal(
    backendConfig({ ...production, BLAST_BACKEND_MAX_PRIVATE_WORK_MS: "280000" }).maxPrivateWorkMs,
    280_000,
  );
  // The cap's ceiling is what makes it fit: 280 s of work plus the 10 s margin is a 290 s drain.
  assert.throws(
    () => backendConfig({ ...production, BLAST_BACKEND_MAX_PRIVATE_WORK_MS: "290000" }),
    /180000–280000/,
  );
});

test("extra trusted sites are optional, each keyed by its own namespace, and fail boot by name only", () => {
  const expected = quotaNamespace(base.BLAST_REDIS_NAMESPACE, deploymentIdentity(base));
  const production = { ...base, BLAST_BACKEND_EXPECTED_QUOTA_NAMESPACE: expected };
  assert.deepEqual(backendConfig(production).extraSites, []);
  assert.deepEqual(backendConfig({ ...production, BLAST_BACKEND_EXTRA_SITES: " " }).extraSites, []);

  const dev = { origin: "https://dev.blast.test", target: "dev", branch: "dev" };
  const config = backendConfig({ ...production, BLAST_BACKEND_EXTRA_SITES: JSON.stringify([dev]) });
  assert.equal(config.namespace, expected, "the primary namespace is unchanged");
  // The same hash the dev web relay signs from its own deployment identity.
  const devNamespace = parseRelayConfig({
    ...RUNTIME_TEST_ENVIRONMENT,
    BLAST_REDIS_NAMESPACE: base.BLAST_REDIS_NAMESPACE,
    VERCEL: "1",
    VERCEL_ENV: "preview",
    VERCEL_TARGET_ENV: "dev",
    VERCEL_GIT_COMMIT_REF: "dev",
  }).quotaNamespace;
  assert.deepEqual(config.extraSites, [{ siteOrigin: dev.origin, namespace: devNamespace }]);
  assert.notEqual(devNamespace, expected);

  for (const value of [
    "not json",
    "[]",
    JSON.stringify(dev),
    JSON.stringify([{ ...dev, origin: "https://dev.blast.test/" }]),
    JSON.stringify([{ ...dev, origin: "http://dev.blast.test" }]),
    JSON.stringify([{ ...dev, origin: "https://blast.test" }]),
    JSON.stringify([{ ...dev, target: "production" }]),
    JSON.stringify([{ ...dev, branch: "" }]),
    JSON.stringify([{ ...dev, extra: true }]),
    JSON.stringify([dev, { ...dev, origin: "https://other.blast.test" }]),
    JSON.stringify([dev, { ...dev, target: "qa" }, { ...dev, target: "a" }, { ...dev, target: "b" }, { ...dev, target: "c" }]),
  ]) {
    assert.throws(
      () => backendConfig({ ...production, BLAST_BACKEND_EXTRA_SITES: value }),
      (error: Error) =>
        error.message.startsWith("BLAST_BACKEND_EXTRA_SITES must be") &&
        !error.message.includes("dev.blast.test"),
      value,
    );
  }
});
