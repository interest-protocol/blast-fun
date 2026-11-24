import assert from "node:assert/strict";
import { test } from "node:test";

import { parseRelayConfig } from "./relay-config.ts";

type Environment = Readonly<Record<string, string | undefined>>;

const SECRET = "g".repeat(32);
const production: Environment = {
  NODE_ENV: "production",
  VERCEL: "1",
  VERCEL_ENV: "production",
  VERCEL_TARGET_ENV: "production",
  VERCEL_GIT_COMMIT_REF: "main",
  BLAST_BACKEND_API_ORIGIN: "https://api.blast.test/",
  BLAST_BACKEND_GATEWAY_SECRET: SECRET,
  BLAST_REDIS_NAMESPACE: "mainnet:deploy_1-a",
  NEXT_PUBLIC_SITE_URL: "https://www.blast.test/",
};
const preview: Environment = {
  NODE_ENV: "production",
  VERCEL: "1",
  VERCEL_ENV: "preview",
  VERCEL_TARGET_ENV: "preview",
  VERCEL_GIT_COMMIT_REF: "feature-x",
};

// This fails if the parsed namespace or site origin stops matching the bytes the
// backend compares: the namespace is the production golden vector in
// packages/core/src/lib/config/deployment-identity.test.ts.
test("production parses to the namespace and site origin the backend signs against", () => {
  const config = parseRelayConfig(production);

  assert.deepEqual(config, {
    apiOrigin: "https://api.blast.test",
    gatewaySecret: SECRET,
    hints: null,
    quotaNamespace: "b6bde0c65d448fa89f77f3eb6e1b43f7d3d8866f72bde7dd4d18d0b5c0d190b8",
    siteOrigin: "https://www.blast.test",
    ingress: { vercel: true, localRun: false },
  });
});

// This fails if production boots without one of its four relay values, or if
// the refusal carries anything but the variable's name.
test("production refuses each missing relay value by name", () => {
  const missing: ReadonlyArray<readonly [string, string]> = [
    ["BLAST_BACKEND_API_ORIGIN", "BLAST_BACKEND_API_ORIGIN is required."],
    ["BLAST_BACKEND_GATEWAY_SECRET", "BLAST_BACKEND_GATEWAY_SECRET must be set."],
    ["BLAST_REDIS_NAMESPACE", "BLAST_REDIS_NAMESPACE must identify the network, deployment and environment."],
    ["NEXT_PUBLIC_SITE_URL", "NEXT_PUBLIC_SITE_URL must be set."],
  ];
  for (const [name, message] of missing) {
    assert.throws(() => parseRelayConfig({ ...production, [name]: undefined }), { message }, name);
  }
});

// This fails if a preview without relay values stops parsing (the relays then
// answer 503) or stops signing the production site origin as its own.
test("outside production every relay value is optional", () => {
  assert.deepEqual(parseRelayConfig(preview), {
    apiOrigin: null,
    gatewaySecret: null,
    hints: null,
    quotaNamespace: null,
    siteOrigin: "https://www.blast.fun",
    ingress: { vercel: true, localRun: false },
  });
});

// This fails if a set value that does not parse is ignored in a preview, or if
// its refusal echoes the value.
test("a set but invalid value fails outside production too, naming only the variable", () => {
  const invalid: ReadonlyArray<readonly [Environment, string]> = [
    [{ BLAST_BACKEND_API_ORIGIN: "http://api.private.test" }, "BLAST_BACKEND_API_ORIGIN must be a bare HTTPS origin (HTTP only on loopback)."],
    [{ BLAST_BACKEND_GATEWAY_SECRET: "private-short" }, "BLAST_BACKEND_GATEWAY_SECRET must be at least 32 characters."],
    [{ BLAST_REDIS_NAMESPACE: "private namespace" }, "BLAST_REDIS_NAMESPACE must identify the network, deployment and environment."],
    [{ NEXT_PUBLIC_SITE_URL: "http://private.test" }, "NEXT_PUBLIC_SITE_URL must be a bare HTTPS origin (HTTP only on loopback)."],
  ];
  for (const [override, message] of invalid) {
    assert.throws(() => parseRelayConfig({ ...preview, ...override }), { message }, JSON.stringify(override));
  }
});
