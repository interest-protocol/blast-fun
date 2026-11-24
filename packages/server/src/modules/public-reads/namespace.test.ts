import assert from "node:assert/strict";
import test from "node:test";
import { presaleIdentityFixture } from "../../../../core/test/fixtures/modules/presale/deployment/fixtures.ts";
import { publicReadNamespace } from "@blast/server/modules/public-reads/namespace.ts";

test("presales-only cache namespaces bind manifests, environments and sources without credentials", () => {
  const environment = {
    PRESALE_DEPLOYMENT_MANIFEST: JSON.stringify(presaleIdentityFixture()),
    DATABASE_REPLICA_URL: "postgresql://reader:private@reader.example:5432/production",
    BLAST_INFRA_ORIGIN: "https://api.blast.fun", BLAST_REDIS_NAMESPACE: "mainnet:preview",
  };
  const deployment = { target: "preview", branch: "develop" };
  const original = publicReadNamespace("presales", deployment, environment);
  assert.equal(original, publicReadNamespace("presales", deployment, { ...environment,
    DATABASE_REPLICA_URL: "postgresql://replacement:other-secret@reader.example:5432/production" }));
  assert.doesNotMatch(original, /private|reader|production|secret/);
  for (const change of [
    { BLAST_INFRA_ORIGIN: "https://other.example" }, { DATABASE_REPLICA_URL: "postgresql://reader:p@other.example/production" },
    { BLAST_REDIS_NAMESPACE: "mainnet:production" },
    { PRESALE_DEPLOYMENT_MANIFEST: JSON.stringify(presaleIdentityFixture({ publishCheckpoint: "999" })) },
  ]) assert.notEqual(original, publicReadNamespace("presales", deployment, { ...environment, ...change }));
  assert.notEqual(original, publicReadNamespace("presales", { ...deployment, branch: "other" }, environment));
  assert.notEqual(original, publicReadNamespace("prices", deployment, environment));
  assert.throws(() => publicReadNamespace("presales", deployment, { ...environment, PRESALE_DEPLOYMENT_MANIFEST: "" }), /identity/);
  assert.throws(() => publicReadNamespace("presales", deployment, { ...environment, PRESALE_DEPLOYMENT_MANIFEST: "{}" }), /identity/);
});
