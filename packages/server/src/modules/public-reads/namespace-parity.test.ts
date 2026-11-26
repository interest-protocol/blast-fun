import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { BLAST_DEPLOYMENTS, deploymentFingerprint } from "@interest-protocol/blast-sdk/deployments";
import { expectedDeployment } from "@blast/core/modules/launchpad-contract/provenance.ts";
import { readPresaleDeploymentIdentity } from "@blast/core/modules/presale/deployment/service.ts";
import { presaleIdentityFixture } from "../../../../core/test/fixtures/modules/presale/deployment/fixtures.ts";
import { partnerRecognitionNamespace } from "../partner-api-keys/recognition-namespace.ts";
import { PUBLIC_READ_SCOPES, publicReadNamespace } from "./namespace.ts";

const BASE = "mainnet:deploy_1-a";
const DEPLOYMENT = { target: "preview", branch: "feature-x" };
const COMMON = {
  BLAST_REDIS_NAMESPACE: BASE,
  BLAST_INFRA_ORIGIN: "https://api.blast.test",
  DATABASE_REPLICA_URL: "postgresql://reader:private@reader.example:5432/production",
};
const PRESALE = { ...COMMON, PRESALE_DEPLOYMENT_MANIFEST: JSON.stringify(presaleIdentityFixture()) };
const SCOPES = PUBLIC_READ_SCOPES;

// Generated from the deleted functions at d5c8c6270: audits/2026-11-10-blast-v2-untangle/scripts/u8_golden_vectors.ts.
// Re-recorded for #856, whose fixture identity is mainnet-shaped: the hashed input changed, the function did not.
const VECTORS: ReadonlyArray<readonly [string, string, Readonly<Record<string, string>>]> = [
  ["presale only", "03dbff8c8f4d8867ca0437c9acb19cd03f35b54ac95db4142023657233cd479a", PRESALE],
  ["origin text with a trailing slash stays raw", "955faaf1e930208bc6ebd3a93d2b3eb5d6d5351c6ba8d8b2d79fb968b99741c0", { ...PRESALE, BLAST_INFRA_ORIGIN: "https://api.blast.test/" }],
  ["replica credentials do not change the hash", "03dbff8c8f4d8867ca0437c9acb19cd03f35b54ac95db4142023657233cd479a", { ...PRESALE, DATABASE_REPLICA_URL: "postgresql://other:secret@reader.example:5432/production" }],
  ["replica without a port", "29a885cf70af092934ff715d1ef7b9dd429eecb1e4dcedbe94010de0468a67ce", { ...PRESALE, DATABASE_REPLICA_URL: "postgresql://reader:private@reader.example/production" }],
];

test("public read namespaces hash to the recorded vectors", () => {
  for (const [name, expected, environment] of VECTORS) {
    for (const scope of SCOPES) {
      assert.equal(publicReadNamespace(scope, DEPLOYMENT, environment), `${BASE}:${expected}:${scope}`, `${name}: ${scope}`);
    }
  }
});

// A selected launchpad also resolves presale from the SDK manifest, so this hash moves with the SDK: pin the key order instead.
test("a selected deployment hashes launchpad, presale, origin, target, branch, replica in that order", () => {
  const environment = {
    ...COMMON,
    BLAST_NETWORK: "mainnet",
    BLAST_DEPLOYMENT_FINGERPRINT: deploymentFingerprint(BLAST_DEPLOYMENTS.mainnet!),
  };
  const presale = readPresaleDeploymentIdentity(environment);
  assert.equal(presale.status, "ready");
  const identity = createHash("sha256").update(JSON.stringify({
    launchpad: expectedDeployment(environment),
    presale: presale.status === "ready" ? presale.identity : null,
    origin: COMMON.BLAST_INFRA_ORIGIN,
    target: DEPLOYMENT.target,
    branch: DEPLOYMENT.branch,
    replica: "reader.example:5432/production",
  })).digest("hex");

  for (const scope of SCOPES) {
    assert.equal(publicReadNamespace(scope, DEPLOYMENT, environment), `${BASE}:${identity}:${scope}`);
  }
});

test("partner recognition matches the deleted function, default and override", () => {
  assert.equal(partnerRecognitionNamespace(undefined, "a9b6358380e6c52a6c1e66ec858d6cc015bd7992470db12c61decd088c9eddba"), "a9b6358380e6c52a6c1e66ec858d6cc015bd7992470db12c61decd088c9eddba");
  assert.equal(partnerRecognitionNamespace("cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc", "a9b6358380e6c52a6c1e66ec858d6cc015bd7992470db12c61decd088c9eddba"), "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc");
});
