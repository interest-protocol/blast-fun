import assert from "node:assert/strict";
import test from "node:test";
import { deploymentIdentity } from "@blast/core/lib/config/deployment-identity.ts";
import { quotaNamespace } from "@blast/core/lib/web-security/redis-rate-limits.ts";
import { verifyGatewayRequest } from "@blast/core/modules/backend-api/gateway.ts";
import { verifyPrivateRequest } from "@blast/core/modules/backend-api/private-gateway.ts";
import { requiredSiteOrigin } from "@blast/core/lib/site-origin.ts";
import { privateBackendRelay } from "@blast/server/private/relay.ts";
import { parseRelayConfig } from "@blast/server/private/relay-config.ts";
import {
  backendFirstPartyRead,
  backendPartnerRelay,
} from "../../web/src/modules/partner-api/v1/relay.ts";
import { backendTransportConfig } from "../src/app/config/transport.ts";

const SITE = "https://www.blast.test";
const SECRET = "g".repeat(32);
const BASE = "mainnet:parity:production";
const shared = {
  NODE_ENV: "production",
  NEXT_PUBLIC_SITE_URL: `${SITE}/`,
  BLAST_REDIS_NAMESPACE: BASE,
  BLAST_BACKEND_API_ORIGIN: "https://api.blast.test",
  BLAST_BACKEND_GATEWAY_SECRET: SECRET,
};
const vercel = {
  ...shared,
  VERCEL: "1",
  VERCEL_ENV: "production",
  VERCEL_TARGET_ENV: "production",
  VERCEL_GIT_COMMIT_REF: "main",
};
const namespace = quotaNamespace(BASE, deploymentIdentity(vercel));
const backend = {
  ...shared,
  BLAST_DEPLOYMENT_TARGET: "production",
  BLAST_BACKEND_EXPECTED_QUOTA_NAMESPACE: namespace,
  BLAST_QUOTA_REDIS_URL: "redis://127.0.0.1:6379",
  RATE_LIMIT_SUBJECT_PEPPER: "p".repeat(32),
};

// This fails if the web relay config hashes the quota namespace or writes the
// site origin differently from the backend's boot config.
test("the web relay config and the backend boot config derive one namespace and one site origin", () => {
  const relay = parseRelayConfig(vercel);
  assert.equal(relay.quotaNamespace, namespace);
  assert.equal(backendTransportConfig(backend, "api").namespace, namespace);
  assert.equal(relay.siteOrigin, requiredSiteOrigin(backend));
});

const expected = {
  namespace: backendTransportConfig(backend, "api").namespace,
  siteOrigin: requiredSiteOrigin(backend),
};

// This fails if a request one of the web relays signs from its parsed config is
// refused by the backend's verifier under the backend's own identity.
test("a request signed by each web relay is accepted with the backend's identity", async (t) => {
  let privateVerified = false;
  const relay = privateBackendRelay(parseRelayConfig(vercel), {
    clientAddress: () => "192.0.2.7",
    async fetch(input, init) {
      const request = new Request(input, init);
      const body = new Uint8Array(await request.arrayBuffer());
      privateVerified = verifyPrivateRequest(request, body, SECRET, expected) !== null;
      return new Response(null, { headers: { "Cache-Control": "private, no-store" } });
    },
  });
  await relay(new Request(`${SITE}/api/social/activity`));
  assert.equal(privateVerified, true);

  const verifiedPaths: string[] = [];
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    if (verifyGatewayRequest(request, SECRET, expected.namespace) !== null) {
      verifiedPaths.push(new URL(request.url).pathname);
    }
    return Response.json({ source: "backend" });
  });
  const vercelHeaders = { "x-vercel-forwarded-for": "198.18.0.1" };
  await backendFirstPartyRead(
    new Request(`${SITE}/api/social/prices`, { headers: vercelHeaders }),
    parseRelayConfig(vercel),
  );
  await backendPartnerRelay(parseRelayConfig(vercel))(
    new Request(`${SITE}/api/v1/prices`, { headers: vercelHeaders }),
  );
  assert.equal(verifiedPaths.length, 2, verifiedPaths.join(","));
});

test("backend boot names what its identity is missing and never a value", () => {
  for (const change of [
    { BLAST_DEPLOYMENT_TARGET: undefined },
    { BLAST_DEPLOYMENT_TARGET: "" },
    { BLAST_DEPLOYMENT_TARGET: "preview" },
    { BLAST_BACKEND_EXPECTED_QUOTA_NAMESPACE: "f".repeat(64) },
  ]) {
    assert.throws(
      () => backendTransportConfig({ ...backend, ...change }, "api"),
      (error: Error) =>
        /quota identity/.test(error.message) &&
        !error.message.includes(SECRET) &&
        !error.message.includes(namespace),
      JSON.stringify(change),
    );
  }
});

test("a backend still carrying the old Vercel variables boots once its target is set", () => {
  assert.equal(
    backendTransportConfig(
      {
        ...backend,
        VERCEL_ENV: "production",
        VERCEL_TARGET_ENV: "production",
        VERCEL_GIT_COMMIT_REF: "main",
      },
      "api",
    ).namespace,
    namespace,
  );
  assert.throws(
    () =>
      backendTransportConfig(
        {
          ...backend,
          BLAST_DEPLOYMENT_TARGET: undefined,
          VERCEL_ENV: "production",
        },
        "api",
      ),
    /BLAST_DEPLOYMENT_TARGET/,
  );
});
