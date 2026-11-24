import assert from "node:assert/strict";
import test from "node:test";
import { deploymentIdentity } from "@blast/core/lib/config/deployment-identity.ts";
import { quotaNamespace } from "@blast/core/lib/web-security/redis-rate-limits.ts";

type Environment = Readonly<Record<string, string | undefined>>;

function namespace(environment: Environment): string {
  return quotaNamespace(environment.BLAST_REDIS_NAMESPACE, deploymentIdentity(environment));
}

test("quota namespaces isolate production, custom environments and preview branches despite a copied base", () => {
  const production = { BLAST_REDIS_NAMESPACE: "mainnet:v1", BLAST_DEPLOYMENT_TARGET: "production", BLAST_DEPLOYMENT_BRANCH: "main" };
  const preview = { ...production, BLAST_DEPLOYMENT_TARGET: "preview" };
  const key = namespace(production);

  assert.equal(key, namespace({ ...production, BLAST_DEPLOYMENT_BRANCH: "release" }));
  assert.notEqual(key, namespace(preview));
  assert.notEqual(key, namespace({ ...production, BLAST_DEPLOYMENT_TARGET: "Develop" }));
  assert.notEqual(namespace({ ...preview, BLAST_DEPLOYMENT_BRANCH: "one" }), namespace({ ...preview, BLAST_DEPLOYMENT_BRANCH: "two" }));
});
