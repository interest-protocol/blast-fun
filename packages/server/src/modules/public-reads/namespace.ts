import type { DeploymentIdentity } from "@blast/core/lib/config/deployment-identity.ts";
import { createHash } from "node:crypto";
import { redisNamespace } from "@blast/core/lib/redis.ts";
import { expectedDeployment } from "@blast/core/modules/launchpad-contract/provenance.ts";
import { readPresaleDeploymentIdentity } from "@blast/core/modules/presale/deployment/service.ts";

/** The shared public read caches; `social` holds Home Discover pages and the first For You page. */
export const PUBLIC_READ_SCOPES = ["presales", "prices", "market", "social"] as const;
export type PublicReadScope = (typeof PUBLIC_READ_SCOPES)[number];

/** Bind public data to both active products; presales-only deployments have no launchpad fingerprint. */
export function publicReadNamespace(scope: PublicReadScope, deployment: Pick<DeploymentIdentity, "target" | "branch">, environment: Readonly<Record<string, string | undefined>>): string {
  const launchpad = expectedDeployment(environment);
  const presale = readPresaleDeploymentIdentity(environment);
  if (presale.status === "unavailable" && presale.reason !== "missing") {
    throw new Error("Shared public caching requires a valid presale deployment identity.");
  }
  if (!launchpad && presale.status !== "ready") {
    throw new Error("Shared public caching requires the selected backend's deployment identity.");
  }
  const replica = environment.DATABASE_REPLICA_URL;
  if (!replica) throw new Error("Shared public caching requires a read replica.");
  const database = new URL(replica);
  const identity = createHash("sha256").update(JSON.stringify({
    launchpad,
    presale: presale.status === "ready" ? presale.identity : null,
    origin: environment.BLAST_INFRA_ORIGIN,
    target: deployment.target,
    branch: deployment.branch,
    replica: `${database.hostname}:${database.port}${database.pathname}`,
  })).digest("hex");
  return `${redisNamespace(environment.BLAST_REDIS_NAMESPACE)}:${identity}:${scope}`;
}
