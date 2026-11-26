import assert from "node:assert/strict";
import test from "node:test";

import { BLAST_DEPLOYMENTS, deploymentFingerprint } from "@interest-protocol/blast-sdk/deployments";
import { deploymentIdentity } from "@blast/core/lib/config/deployment-identity.ts";
import { quotaNamespace } from "@blast/core/lib/web-security/redis-rate-limits.ts";
import { PUBLIC_READ_SCOPES, publicReadNamespace } from "@blast/server/modules/public-reads/namespace.ts";
import { parseRuntimeConfig } from "./runtime-config.ts";
import { RUNTIME_TEST_ENVIRONMENT } from "../../test/fixtures/config/runtime-config.ts";

const base = RUNTIME_TEST_ENVIRONMENT;
const short = "x".repeat(31);

test("a missing required value stops boot and names only the variable", () => {
  assert.throws(
    () => parseRuntimeConfig({ ...base, LAUNCHPAD_SUBJECT_PEPPER: undefined }),
    /^Error: LAUNCHPAD_SUBJECT_PEPPER must be set\.$/,
  );
  assert.throws(
    () => parseRuntimeConfig({ ...base, PRIVY_APP_SECRET: "" }),
    /^Error: PRIVY_APP_SECRET must be set\.$/,
  );
});

test("a secret under 32 characters stops boot, optional or not, without echoing it", () => {
  for (const name of ["PRESALE_ADMIN_TOKEN", "BLAST_GATE_SECRET_PREVIOUS"]) {
    assert.throws(
      () => parseRuntimeConfig({ ...base, [name]: short }),
      (error: Error) =>
        error.message === `${name} must be at least 32 characters.` && !error.message.includes(short),
    );
  }
});

test("unset optionals pass, and secrets are kept exactly as set", () => {
  const padded = ` ${"p".repeat(32)} `;
  const config = parseRuntimeConfig({ ...base, RATE_LIMIT_SUBJECT_PEPPER: padded });

  assert.equal(config.subjectPepper, padded);
  assert.deepEqual(config.gateKeys, { signing: base.BLAST_GATE_SECRET, verifying: [base.BLAST_GATE_SECRET] });
});

test("the login admission token must differ from the admin token", () => {
  assert.throws(
    () => parseRuntimeConfig({ ...base, ADMIN_LOGIN_ADMISSION_TOKEN: base.PRESALE_ADMIN_TOKEN }),
    /^Error: ADMIN_LOGIN_ADMISSION_TOKEN must differ from PRESALE_ADMIN_TOKEN\.$/,
  );
});

const SPONSOR = "0x" + "5".repeat(64);
const REPLICA = "postgresql://reader:leak-replica-password@reader.example:5432/production";

// This fails if a required value could be left unset and the API still booted on a silent default.
test("each new required value stops boot when unset, naming only the variable", () => {
  const pair = /^BLAST_NETWORK \(mainnet\) and BLAST_DEPLOYMENT_FINGERPRINT \(64 lowercase hex\) are set together\.$/;
  for (const [unset, message] of [
    [["BLAST_NETWORK", "BLAST_DEPLOYMENT_FINGERPRINT"], /^BLAST_NETWORK and BLAST_DEPLOYMENT_FINGERPRINT must be set\.$/],
    [["BLAST_NETWORK"], pair],
    [["BLAST_DEPLOYMENT_FINGERPRINT"], pair],
    [["BLAST_INFRA_ORIGIN"], /^BLAST_INFRA_ORIGIN is required for market reads\.$/],
    [["BLAST_INFRA_API_KEY"], /^BLAST_INFRA_API_KEY must be set\.$/],
    [["BLAST_REDIS_NAMESPACE"], /^BLAST_REDIS_NAMESPACE must identify the network, deployment and environment\.$/],
  ] as const) {
    const environment = { ...base, ...Object.fromEntries(unset.map((name) => [name, undefined])) };
    assert.throws(() => parseRuntimeConfig(environment), (error: Error) => message.test(error.message), unset.join(", "));
  }
});

// This fails if an unset optional turned its feature on, or stopped boot.
test("unset optionals leave their features off", () => {
  const config = parseRuntimeConfig(base);
  assert.equal(config.sponsor, null);
  assert.equal(config.gasPool, null);
  assert.equal(config.defillama, null);
  assert.equal(config.creatorClaimSigner, null);
  assert.equal(config.launchAssetBlobToken, null);
  assert.equal(config.tradeFee, null);
  assert.equal(config.publicReadNamespaces, null, "no replica: public reads go uncached");
  assert.equal(config.bridge.forwarding, null);
  assert.equal(config.bridge.relayerAddress, null);
  assert.equal(config.cardImages.store.blobToken, null);
  assert.equal(config.social.routeMetricSampleRate, undefined);
  assert.equal(config.social.createDraftLimit, 25);
  assert.deepEqual(config.presaleSettingsDefaults, { explorer: "suivision", theme: "system" });
  assert.equal(config.infra.readOrigin, null);
  // The card store's token never turns on launch assets, and a blank one is unset.
  assert.equal(parseRuntimeConfig({ ...base, BLOB_READ_WRITE_TOKEN: "card-token" }).launchAssetBlobToken, null);
  assert.equal(parseRuntimeConfig({ ...base, LAUNCH_ASSET_BLOB_READ_WRITE_TOKEN: "  " }).launchAssetBlobToken, null);
  assert.equal(parseRuntimeConfig({ ...base, LAUNCH_ASSET_BLOB_READ_WRITE_TOKEN: " launch-token " }).launchAssetBlobToken, "launch-token");
});

// This fails if a set but invalid value booted (as a default, or as the feature off), or if its message repeated the value.
test("a set but invalid value stops boot, naming the variable and never the value", () => {
  const rows: ReadonlyArray<readonly [string, Readonly<Record<string, string>>]> = [
    ["PRESALE_SUI_GRPC_URL", { PRESALE_SUI_GRPC_URL: "http://leak-node.example/" }],
    ["BLAST_INFRA_ORIGIN", { BLAST_INFRA_ORIGIN: "ftp://leak-origin.example" }],
    ["BLAST_INFRA_API_KEY", { BLAST_INFRA_API_KEY: "leak-key" }],
    ["BLAST_INFRA_READ_MODE", { BLAST_INFRA_READ_MODE: "leak-mode" }],
    ["BLAST_REDIS_NAMESPACE", { BLAST_REDIS_NAMESPACE: "!leak-namespace" }],
    ["BLAST_NETWORK", { BLAST_NETWORK: "leak-network" }],
    ["SOCIAL_CREATE_DRAFT_LIMIT", { SOCIAL_CREATE_DRAFT_LIMIT: "leak-limit" }],
    ["SOCIAL_CREATE_FEE_POLICY", { SOCIAL_CREATE_FEE_POLICY: "leak,1,2" }],
    ["SOCIAL_ROUTE_METRIC_SAMPLE_RATE", { SOCIAL_ROUTE_METRIC_SAMPLE_RATE: "7.25" }],
    ["SOCIAL_TRADE_PROVIDERS", { SOCIAL_TRADE_PROVIDERS: "LEAKDEX" }],
    ["PRESALE_DEFAULT_EXPLORER", { PRESALE_DEFAULT_EXPLORER: "leak-explorer" }],
    ["PRESALE_DEFAULT_THEME", { PRESALE_DEFAULT_THEME: "leak-theme" }],
    ["PRESALE_SPONSOR_ADDRESS", { PRESALE_SPONSOR_ADDRESS: "leak-address" }],
    ["PRESALE_SPONSOR_MAX_GAS_MIST", { PRESALE_SPONSOR_ADDRESS: SPONSOR, PRESALE_SPONSOR_MAX_GAS_MIST: "leak-gas" }],
    ["PRESALE_SPONSOR_SWAP_TARGETS", { PRESALE_SPONSOR_ADDRESS: SPONSOR, PRESALE_SPONSOR_SWAP_TARGETS: "leak-targets" }],
    ["PRESALE_SPONSOR_DAILY_CAP", { PRESALE_SPONSOR_DAILY_CAP: "leak-cap" }],
    ["PRESALE_SPONSOR_EXEC_DAILY_CAP", { PRESALE_SPONSOR_EXEC_DAILY_CAP: "leak-cap" }],
    ["BLAST_TRADE_FEE_BPS", { BLAST_TRADE_FEE_BPS: "leak-bps", BLAST_TRADE_FEE_RECEIVER: SPONSOR }],
    ["BLAST_TRADE_FEE_RECEIVER", { BLAST_TRADE_FEE_BPS: "50", BLAST_TRADE_FEE_RECEIVER: "leak-receiver" }],
    ["PRESALE_BRIDGE_FORWARDING", { PRESALE_BRIDGE_FORWARDING: "leak-forwarding" }],
    ["PRESALE_BRIDGE_RELAYER_ADDRESS", { PRESALE_BRIDGE_RELAYER_ADDRESS: "leak-relayer" }],
    ["CREATOR_CLAIM_SIGNER_KEY", { CREATOR_CLAIM_SIGNER_KEY: "suiprivkey1leak" }],
    ["DEFILLAMA_PROFILE", { DEFILLAMA_READ_DATABASE_URL: REPLICA, DEFILLAMA_PROFILE: "{\"leak\":1}" }],
    ["CARD_IMAGE_BLOB_ACCESS", { CARD_IMAGE_BLOB_ACCESS: "leak-access" }],
    ["CARD_RENDER_CONCURRENCY", { CARD_RENDER_CONCURRENCY: "leak-concurrency" }],
    ["PRESALE_GAS_POOL_URL", { PRESALE_GAS_POOL_URL: "leak-pool" }],
  ];
  for (const [name, overrides] of rows) {
    assert.throws(
      () => parseRuntimeConfig({ ...base, ...overrides }),
      (error: Error) => {
        assert.match(error.message, new RegExp(name), name);
        for (const value of Object.values(overrides)) {
          if (value !== SPONSOR && value !== "50") assert.equal(error.message.includes(value), false, `${name} repeated its value`);
        }
        assert.equal(error.message.includes("leak"), false, `${name} repeated its value`);
        return true;
      },
      name,
    );
  }
});

// This fails if a namespace hash moved: the API would read other counters and cache entries than before.
test("quota and public read namespaces hash exactly as their functions do", () => {
  const environment = { ...base, BLAST_DEPLOYMENT_FINGERPRINT: deploymentFingerprint(BLAST_DEPLOYMENTS.mainnet!), DATABASE_REPLICA_URL: REPLICA, BLAST_DEPLOYMENT_TARGET: "preview", BLAST_DEPLOYMENT_BRANCH: "feature-x" };
  const config = parseRuntimeConfig(environment);
  const identity = deploymentIdentity(environment);
  assert.equal(config.quotaNamespace, quotaNamespace(base.BLAST_REDIS_NAMESPACE, identity));
  assert.equal(config.quotaNamespace, quotaNamespace("mainnet:test", { target: identity.target, branch: identity.branch }));
  assert.ok(config.publicReadNamespaces, "a released deployment with a replica caches public reads");
  for (const scope of PUBLIC_READ_SCOPES) {
    assert.equal(config.publicReadNamespaces[scope], publicReadNamespace(scope, identity, environment));
  }
});
