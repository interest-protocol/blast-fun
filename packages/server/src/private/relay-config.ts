import { deploymentIdentity, type DeploymentIdentity } from "@blast/core/lib/config/deployment-identity.ts";
import { optionalSecret, requiredSecret } from "@blast/core/lib/config/secret.ts";
import { trustedUrl } from "@blast/core/lib/config/trusted-origin.ts";
import { processSingleton } from "@blast/core/lib/process-singleton.ts";
import { normalizeSiteOrigin, requiredSiteOrigin } from "@blast/core/lib/site-origin.ts";
import { quotaNamespace } from "@blast/core/lib/web-security/redis-rate-limits.ts";
import { frontendIngress, type FrontendIngress } from "@blast/core/modules/backend-api/frontend-ingress.ts";
import { backendOrigin } from "@blast/core/modules/backend-api/relay-client.ts";

type Environment = Readonly<Record<string, string | undefined>>;

/** One backend role the web process signs requests for. */
export type RelayUpstream = Readonly<{ origin: string; secret: string }>;

/**
 * What the web process's backend relays (`private/relay.ts`, `cron/relay.ts`,
 * the partner relay) read from the environment, parsed once. Production
 * requires the API upstream, the quota namespace and the site origin; outside
 * production an unset value is null and the relay that needs it answers 503.
 * A set value that does not parse always fails.
 */
export type RelayConfig = Readonly<{
  /** `BLAST_BACKEND_API_ORIGIN`, as a bare origin; the cron relay needs only this. */
  apiOrigin: string | null;
  /** `BLAST_BACKEND_GATEWAY_SECRET`, signing everything but streams. */
  gatewaySecret: string | null;
  /** `BLAST_BACKEND_HINTS_ORIGIN` and `BLAST_BACKEND_HINTS_GATEWAY_SECRET`: both or neither; streams go only here. */
  hints: RelayUpstream | null;
  /** Hashed from the raw `BLAST_REDIS_NAMESPACE` and the deployment identity; the backend compares it. */
  quotaNamespace: string | null;
  /** `NEXT_PUBLIC_SITE_URL`, normalized and signed as text; the backend compares it. */
  siteOrigin: string;
  ingress: FrontendIngress;
}>;

/** The web process's relay config, parsed from `process.env` on first use. */
export function relayConfig(): RelayConfig {
  return processSingleton("relayConfig", () => parseRelayConfig(process.env));
}

export function parseRelayConfig(environment: Environment): RelayConfig {
  const identity = deploymentIdentity(environment);
  const gatewaySecret = identity.production
    ? requiredSecret(environment, "BLAST_BACKEND_GATEWAY_SECRET")
    : optionalSecret(environment, "BLAST_BACKEND_GATEWAY_SECRET");
  const hints = hintsUpstream(environment);
  if (hints !== null && hints.secret === gatewaySecret) {
    throw new Error("BLAST_BACKEND_HINTS_GATEWAY_SECRET must differ from BLAST_BACKEND_GATEWAY_SECRET.");
  }

  return {
    apiOrigin: backendOrigin(environment, "BLAST_BACKEND_API_ORIGIN", identity.production),
    gatewaySecret,
    hints,
    quotaNamespace: relayQuotaNamespace(environment, identity),
    siteOrigin: signedSiteOrigin(environment, identity.production),
    ingress: frontendIngress(environment),
  };
}

function hintsUpstream(environment: Environment): RelayUpstream | null {
  const origin = backendOrigin(environment, "BLAST_BACKEND_HINTS_ORIGIN", false);
  const secret = optionalSecret(environment, "BLAST_BACKEND_HINTS_GATEWAY_SECRET");
  if (origin === null && secret === null) {
    return null;
  }
  if (origin === null) {
    throw new Error("BLAST_BACKEND_HINTS_ORIGIN must be set with BLAST_BACKEND_HINTS_GATEWAY_SECRET.");
  }
  if (secret === null) {
    throw new Error("BLAST_BACKEND_HINTS_GATEWAY_SECRET must be set with BLAST_BACKEND_HINTS_ORIGIN.");
  }
  return { origin, secret };
}

function relayQuotaNamespace(environment: Environment, identity: DeploymentIdentity): string | null {
  if (!environment.BLAST_REDIS_NAMESPACE && !identity.production) {
    return null;
  }
  return quotaNamespace(environment.BLAST_REDIS_NAMESPACE, identity);
}

/** Production has no default; previews and local runs keep the production origin as theirs. */
function signedSiteOrigin(environment: Environment, production: boolean): string {
  const origin = production
    ? requiredSiteOrigin(environment)
    : normalizeSiteOrigin(environment.NEXT_PUBLIC_SITE_URL);
  // Validated, never rewritten: the backend compares the signed text.
  trustedUrl("NEXT_PUBLIC_SITE_URL", origin, { shape: "origin", http: "loopback" });
  return origin;
}
