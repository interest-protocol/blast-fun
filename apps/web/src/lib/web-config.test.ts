import assert from "node:assert/strict";
import test from "node:test";

import { BLAST_DEPLOYMENTS, deploymentFingerprint } from "@interest-protocol/blast-sdk/deployments";

import { processSingleton, takeProcessSingleton } from "@blast/core/lib/process-singleton.ts";

import { parseWebConfig } from "./web-config.ts";

type Environment = Readonly<Record<string, string | undefined>>;

const GATEWAY = "g".repeat(32);
const GATE = "gate-secret-that-is-at-least-32-characters";
const FINGERPRINT = deploymentFingerprint(BLAST_DEPLOYMENTS.mainnet!);
const production: Environment = {
  NODE_ENV: "production",
  VERCEL: "1",
  VERCEL_ENV: "production",
  VERCEL_TARGET_ENV: "production",
  VERCEL_GIT_COMMIT_REF: "main",
  BLAST_BACKEND_API_ORIGIN: "https://api.blast.test/",
  BLAST_BACKEND_GATEWAY_SECRET: GATEWAY,
  BLAST_REDIS_NAMESPACE: "mainnet:deploy_1-a",
  BLAST_GATE_SECRET: GATE,
  NEXT_PUBLIC_SITE_URL: "https://www.blast.test/",
};
const preview: Environment = {
  NODE_ENV: "production",
  VERCEL: "1",
  VERCEL_ENV: "preview",
  VERCEL_TARGET_ENV: "preview",
  VERCEL_GIT_COMMIT_REF: "feature-x",
};

// This fails if production parses to settings other than the ones it serves
// with: the relay namespace is the production golden vector, the gate signs
// with BLAST_GATE_SECRET, and every optional value is read once and normalized.
test("production parses every server setting the web process uses", () => {
  const config = parseWebConfig({
    ...production,
    BLAST_GATE_SECRET_PREVIOUS: "previous-gate-secret-at-least-32-characters",
    CRON_SECRET: "c".repeat(32),
    PRIVY_APP_ID: " privy-app ",
    BLAST_BOOSTS_URL: "https://boosts.blast.test",
    BLAST_NETWORK: "mainnet",
    BLAST_DEPLOYMENT_FINGERPRINT: FINGERPRINT,
  });

  assert.equal(config.relay.quotaNamespace, "b6bde0c65d448fa89f77f3eb6e1b43f7d3d8866f72bde7dd4d18d0b5c0d190b8");
  assert.equal(config.relay.siteOrigin, "https://www.blast.test");
  assert.deepEqual(config.gate, {
    keys: { signing: GATE, verifying: [GATE, "previous-gate-secret-at-least-32-characters"] },
    cronSecret: "c".repeat(32),
  });
  assert.equal(config.privyAppId, "privy-app");
  assert.equal(config.boostsUrl, "https://boosts.blast.test/");
  assert.deepEqual(config.expectedDeployment, { network: "mainnet", deployment: FINGERPRINT });
  assert.equal(config.signingChain?.network, "mainnet");
  assert.equal(config.presaleDeployment.status, "ready");
  assert.equal(config.development, false);
});

// This fails if production boots without one of its five required values, or
// if the refusal carries anything but the variable's name.
test("production refuses each of its five required values by name", () => {
  const missing: ReadonlyArray<readonly [string, string]> = [
    ["BLAST_BACKEND_API_ORIGIN", "BLAST_BACKEND_API_ORIGIN is required."],
    ["BLAST_BACKEND_GATEWAY_SECRET", "BLAST_BACKEND_GATEWAY_SECRET must be set."],
    ["BLAST_REDIS_NAMESPACE", "BLAST_REDIS_NAMESPACE must identify the network, deployment and environment."],
    ["BLAST_GATE_SECRET", "BLAST_GATE_SECRET must be set."],
    ["NEXT_PUBLIC_SITE_URL", "NEXT_PUBLIC_SITE_URL must be set."],
  ];
  for (const [name, message] of missing) {
    assert.throws(() => parseWebConfig({ ...production, [name]: undefined }), { message }, name);
    assert.throws(() => parseWebConfig({ ...production, [name]: "" }), { message }, `${name} empty`);
  }
});

// This fails if a preview without settings stops parsing, or if a hosted build
// without a gate secret signs with a key another instance cannot verify.
test("outside production every value is optional and an unset one turns its feature off", () => {
  const config = parseWebConfig(preview);
  assert.equal(config.relay.apiOrigin, null);
  assert.deepEqual(config.gate, { keys: null, cronSecret: null });
  assert.equal(config.privyAppId, null);
  assert.equal(config.boostsUrl, null);
  assert.equal(config.expectedDeployment, null);
  assert.equal(config.signingChain, null);
  assert.equal(config.development, false);
  assert.equal(config.liveSocket, null);
  assert.equal(parseWebConfig({ ...preview, PRIVY_APP_ID: "  " }).privyAppId, null);
});

test("the Fast MCTP fallback requires Bridge and the hosted dev environment", () => {
  const enabled = { NEXT_PUBLIC_MAYAN_BRIDGE_ENABLED: "1" };
  assert.equal(parseWebConfig({ ...preview, ...enabled }).bridgeFastMctp, false);
  assert.equal(parseWebConfig({ ...production, ...enabled }).bridgeFastMctp, false);
  assert.equal(parseWebConfig({ ...preview, VERCEL_TARGET_ENV: "dev" }).bridgeFastMctp, false);
  assert.equal(parseWebConfig({ ...preview, ...enabled, VERCEL_TARGET_ENV: "dev" }).bridgeFastMctp, true);
});

// This fails if the direct socket can be configured without the secret its
// tickets are signed with, or on a plain ws:// host.
test("the live socket needs a wss:// /v1/socket URL and the hints upstream", () => {
  const hints = { ...preview, BLAST_BACKEND_HINTS_ORIGIN: "https://hints.blast.test", BLAST_BACKEND_HINTS_GATEWAY_SECRET: "h".repeat(32) };
  assert.deepEqual(parseWebConfig({ ...hints, BLAST_LIVE_SOCKET_URL: "wss://live.blast.test/v1/socket" }).liveSocket,
    { url: "wss://live.blast.test/v1/socket", origin: "wss://live.blast.test" });
  const url = "BLAST_LIVE_SOCKET_URL must be a wss:// URL ending in /v1/socket.";
  for (const [override, message] of [
    [{ BLAST_LIVE_SOCKET_URL: "ws://live.blast.test/v1/socket" }, url],
    [{ BLAST_LIVE_SOCKET_URL: "wss://live.blast.test/v1/socket?x=1" }, url],
  ] as const) assert.throws(() => parseWebConfig({ ...hints, ...override }), { message });
  assert.throws(() => parseWebConfig({ ...preview, BLAST_LIVE_SOCKET_URL: "wss://live.blast.test/v1/socket" }), /needs BLAST_BACKEND_HINTS_ORIGIN/);
});

// This fails if `next dev` loses its per-process gate key (every API call would
// answer 503) or the dev server's CSP allowances.
test("a local development run gets a per-process gate key", () => {
  const first = parseWebConfig({ NODE_ENV: "development" });
  assert.ok(first.gate.keys);
  assert.deepEqual(parseWebConfig({ NODE_ENV: "development" }).gate.keys, first.gate.keys);
  assert.equal(first.development, true);
});

// This fails if a set value that does not parse is ignored in a preview (where
// it used to be skipped), or if its refusal echoes the value.
test("a set but invalid value fails outside production too, naming only the variable", () => {
  const invalid: ReadonlyArray<readonly [Environment, string]> = [
    [{ BLAST_GATE_SECRET: "private-short-gate" }, "BLAST_GATE_SECRET must be at least 32 characters."],
    [{ BLAST_GATE_SECRET: GATE, BLAST_GATE_SECRET_PREVIOUS: "private-short-prev" }, "BLAST_GATE_SECRET_PREVIOUS must be at least 32 characters."],
    [{ CRON_SECRET: "private-short-cron" }, "CRON_SECRET must be at least 32 characters."],
    [{ BLAST_BOOSTS_URL: "http://private.boosts.test" }, "BLAST_BOOSTS_URL must be an HTTPS URL on a public host name."],
    [{ BLAST_NETWORK: "mainnet" }, "BLAST_NETWORK (mainnet) and BLAST_DEPLOYMENT_FINGERPRINT (64 lowercase hex) are set together."],
    [{ BLAST_NETWORK: "private-net", BLAST_DEPLOYMENT_FINGERPRINT: FINGERPRINT }, "BLAST_NETWORK (mainnet) and BLAST_DEPLOYMENT_FINGERPRINT (64 lowercase hex) are set together."],
    [{ BLAST_BACKEND_API_ORIGIN: "http://private.api.test" }, "BLAST_BACKEND_API_ORIGIN must be a bare HTTPS origin (HTTP only on loopback)."],
  ];
  for (const [override, message] of invalid) {
    assert.throws(() => parseWebConfig({ ...preview, ...override }), { message }, JSON.stringify(override));
  }
});

// This fails if `webConfig()` re-reads the environment per call (a value
// changed after boot would split one process's decisions).
test("the server reads and validates its configuration once", async (t) => {
  const { webConfig } = await import("./server-config.ts");
  const saved = takeProcessSingleton("webConfig");
  const previousBoosts = process.env.BLAST_BOOSTS_URL;
  t.after(() => {
    takeProcessSingleton("webConfig");
    if (saved !== undefined) processSingleton("webConfig", () => saved);
    if (previousBoosts === undefined) delete process.env.BLAST_BOOSTS_URL;
    else process.env.BLAST_BOOSTS_URL = previousBoosts;
  });
  process.env.BLAST_BOOSTS_URL = "https://boosts.blast.test";
  const first = webConfig();
  process.env.BLAST_BOOSTS_URL = "https://other.blast.test";
  assert.equal(webConfig(), first);
  assert.equal(webConfig().boostsUrl, "https://boosts.blast.test/");
});
