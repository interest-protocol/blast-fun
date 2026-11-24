import assert from "node:assert/strict";
import { test } from "node:test";

import { quotaNamespace } from "../web-security/redis-rate-limits.ts";
import { deploymentIdentity } from "./deployment-identity.ts";

type Environment = Readonly<Record<string, string | undefined>>;

const BASE = "mainnet:deploy_1-a";

// Generated from the deleted functions at d5c8c6270: audits/2026-11-10-blast-v2-untangle/scripts/u8_golden_vectors.ts.
const VECTORS: ReadonlyArray<readonly [string, string, ReadonlyArray<Environment>]> = [
  ["production", "b6bde0c65d448fa89f77f3eb6e1b43f7d3d8866f72bde7dd4d18d0b5c0d190b8", [
    { VERCEL: "1", VERCEL_ENV: "production", VERCEL_TARGET_ENV: "production", VERCEL_GIT_COMMIT_REF: "main" },
    { BLAST_DEPLOYMENT_TARGET: "production" },
    { BLAST_DEPLOYMENT_TARGET: "production", BLAST_DEPLOYMENT_BRANCH: "main", VERCEL_ENV: "production" },
  ]],
  ["preview", "3147155f730b294396688838092795ddacc3cabd2a19b9cb5e7544d81a7258e9", [
    { VERCEL: "1", VERCEL_ENV: "preview", VERCEL_TARGET_ENV: "preview", VERCEL_GIT_COMMIT_REF: "feature-x" },
    { BLAST_DEPLOYMENT_TARGET: "preview", BLAST_DEPLOYMENT_BRANCH: "feature-x" },
  ]],
  ["custom target", "a9b6358380e6c52a6c1e66ec858d6cc015bd7992470db12c61decd088c9eddba", [
    { VERCEL: "1", VERCEL_ENV: "preview", VERCEL_TARGET_ENV: "develop", VERCEL_GIT_COMMIT_REF: "develop" },
    { BLAST_DEPLOYMENT_TARGET: "develop", BLAST_DEPLOYMENT_BRANCH: "develop" },
  ]],
  ["local", "6a47c8e572d11a98aa74310e3a9e14c6f2d1977687439424ac6f63675c1a3234", [{}, { NODE_ENV: "production" }, { BLAST_WORKER_ENVIRONMENT: "development" }]],
  ["empty target", "21dfa389f560991cc4167e2ecfd1642d0e5ec318a15854b62273edb362d1e112", [
    { VERCEL: "1", VERCEL_ENV: "preview", VERCEL_TARGET_ENV: "", VERCEL_GIT_COMMIT_REF: "feature-x" },
  ]],
  ["empty branch", "6586a6e43dfb3ea2d286e03bc3148a6369480b926ea7284354c9c138096697d9", [
    { VERCEL: "1", VERCEL_ENV: "preview", VERCEL_TARGET_ENV: "preview", VERCEL_GIT_COMMIT_REF: "" },
  ]],
  ["target from VERCEL_ENV", "3147155f730b294396688838092795ddacc3cabd2a19b9cb5e7544d81a7258e9", [
    { VERCEL: "1", VERCEL_ENV: "preview", VERCEL_GIT_COMMIT_REF: "feature-x" },
  ]],
  ["no branch variable", "e876fb23151a855e82ed9a4223bc981231a1da42e94f4cf4ce05e4dfa4e8b18a", [
    { VERCEL: "1", VERCEL_ENV: "preview", VERCEL_TARGET_ENV: "preview" },
    { BLAST_DEPLOYMENT_TARGET: "preview" },
  ]],
  ["untrimmed", "8019ad43f07ba97ef5d9f6e4a16db95644e4b557c7dba112180354bf4abb3d67", [
    { VERCEL: "1", VERCEL_ENV: "preview", VERCEL_TARGET_ENV: " preview ", VERCEL_GIT_COMMIT_REF: " feature-x " },
    { BLAST_DEPLOYMENT_TARGET: " preview ", BLAST_DEPLOYMENT_BRANCH: " feature-x " },
  ]],
];

const BASES: ReadonlyArray<readonly [string, string]> = [
  ["plain", "c5ca554c3ac81e4d9bd45977085b43b211a9987c4931c825564f71fa29f897bf"],
  ["with:colon", "6ba4400c27f2219dd1ddb9e0dc09f6fe28e7b7fab9d59726ae4f0e1109b6c216"],
  ["with_underscore", "c835425292670af696dfa5df3cc3d0568b8db154bb741d63814608718219105e"],
  ["with-dash", "dd670ab88693c3f3bc4667132fe5b24dec5e30de863c9f2c64d6b62c32335d6a"],
  ["a:b_c-d", "45ebbfeb08667057f9f76230ba0e86dc478848565ca2a6765f6ad5f6709021aa"],
];

test("quota namespaces hash byte-identically to the deleted function", () => {
  for (const [name, expected, environments] of VECTORS) {
    for (const environment of environments) {
      assert.equal(quotaNamespace(BASE, deploymentIdentity(environment)), expected, `${name}: ${JSON.stringify(environment)}`);
    }
  }
});

test("base namespaces with separators hash byte-identically", () => {
  for (const [base, expected] of BASES) {
    assert.equal(quotaNamespace(base, { target: "production", branch: null }), expected, base);
  }
});

test("an unset or malformed base namespace is refused", () => {
  for (const base of [undefined, "", "with space"]) {
    assert.throws(() => quotaNamespace(base, { target: "local", branch: "local" }), /BLAST_REDIS_NAMESPACE/);
  }
});

test("each host marker selects its own identity", () => {
  assert.deepEqual(deploymentIdentity({ VERCEL: "1", VERCEL_ENV: "production", NODE_ENV: "production" }), {
    target: "production", branch: null, production: true, localRun: false,
  });
  assert.deepEqual(deploymentIdentity({ VERCEL: "1", VERCEL_ENV: "preview", VERCEL_GIT_COMMIT_REF: "x", NODE_ENV: "production" }), {
    target: "preview", branch: "x", production: false, localRun: false,
  });
  assert.deepEqual(deploymentIdentity({ BLAST_WORKER_ENVIRONMENT: "production", NODE_ENV: "production" }), {
    target: "production", branch: null, production: true, localRun: false,
  });
  assert.deepEqual(deploymentIdentity({ BLAST_DEPLOYMENT_TARGET: "production", NODE_ENV: "production" }), {
    target: "production", branch: null, production: true, localRun: false,
  });
  assert.deepEqual(deploymentIdentity({}), { target: "local", branch: "local", production: false, localRun: true });
});

test("a production NODE_ENV with no identity variable is non-production and does not throw", () => {
  assert.deepEqual(deploymentIdentity({ NODE_ENV: "production" }), {
    target: "local", branch: "local", production: false, localRun: false,
  });
});

test("VERCEL_ENV outside Vercel with no target fails closed", () => {
  assert.throws(() => deploymentIdentity({ VERCEL_ENV: "production" }), /BLAST_DEPLOYMENT_TARGET/);
  assert.throws(() => deploymentIdentity({ VERCEL: "0", VERCEL_ENV: "production" }), /BLAST_DEPLOYMENT_TARGET/);
  assert.equal(deploymentIdentity({ VERCEL_ENV: "production", BLAST_DEPLOYMENT_TARGET: "production" }).production, true);
});

test("a production worker hashes as production, where the deleted function hashed it as local", () => {
  assert.equal(
    quotaNamespace(BASE, deploymentIdentity({ BLAST_WORKER_ENVIRONMENT: "production" })),
    "b6bde0c65d448fa89f77f3eb6e1b43f7d3d8866f72bde7dd4d18d0b5c0d190b8",
  );
});

test("a production marker the selected host contradicts fails closed", () => {
  for (const environment of [
    { VERCEL: "1", VERCEL_ENV: "preview", BLAST_WORKER_ENVIRONMENT: "production" },
    { BLAST_WORKER_ENVIRONMENT: "development", VERCEL_ENV: "production" },
    { BLAST_WORKER_ENVIRONMENT: "", VERCEL_ENV: "production" },
    { BLAST_DEPLOYMENT_TARGET: "preview", VERCEL_ENV: "production" },
    { BLAST_DEPLOYMENT_TARGET: "", VERCEL_ENV: "production" },
  ]) {
    assert.throws(() => deploymentIdentity(environment), /markers disagree/, JSON.stringify(environment));
  }
});

test("a worker's own selection wins over a stray VERCEL_ENV", () => {
  assert.equal(deploymentIdentity({ BLAST_WORKER_ENVIRONMENT: "production", VERCEL_ENV: "preview" }).production, true);
});
