import { requiredSiteOrigin } from "@blast/core/lib/site-origin.ts";
import { ingressTrust } from "@blast/core/lib/web-security/ingress.ts";
import { marketStreamEnabled } from "@blast/core/modules/launchpad-contract/market-stream.ts";
import { expectedDeployment } from "@blast/core/modules/launchpad-contract/provenance.ts";
import {
  blastInfraApiKey,
  blastInfraSocketUrl,
} from "@blast/core/modules/read-routing/blast-infra.ts";
import { validateBackendFleet } from "../config/fleet.ts";
import { backendTransportConfig, type Environment } from "../config/transport.ts";

/** API-only names: a hints instance with any of them set refuses to start. */
export const HINTS_FORBIDDEN = Object.freeze([
  "BLAST_BACKEND_GATEWAY_SECRET",
  "DATABASE_URL",
  "DATABASE_REPLICA_URL",
  "PARTNER_VERIFIER_DATABASE_URL",
  "DEFILLAMA_READ_DATABASE_URL",
  "WATCHER_DATABASE_URL",
  "PRESALE_ADMIN_TOKEN",
  "ADMIN_LOGIN_ADMISSION_TOKEN",
  "BLAST_PARTNER_CAPACITY_CONFIG",
]);

/** Stream replicas have their own capability secret and no partner/SQL configuration. */
export function hintsConfig(environment: Environment = process.env) {
  for (const name of HINTS_FORBIDDEN) {
    if (environment[name]?.trim()) {
      throw new Error(`${name} must be absent from a hints backend.`);
    }
  }
  const transport = backendTransportConfig(environment, "hints");
  const fleet = validateBackendFleet(environment, {
    role: "hints",
    maxHintStreams: transport.maxHintStreams,
    maxInflight: transport.maxInflight,
  });
  if (!blastInfraApiKey(environment)) {
    throw new Error("Hints backend requires an infra API key.");
  }
  blastInfraSocketUrl(environment);
  const marketEnabled = marketStreamEnabled(environment);
  const marketExpected = marketEnabled ? expectedDeployment(environment) : null;
  if (marketEnabled && !marketExpected) {
    throw new Error("Market streams require an explicit expected deployment.");
  }
  return {
    ...transport,
    fleet,
    marketEnabled,
    marketExpected,
    ingress: ingressTrust(environment),
    siteOrigin: requiredSiteOrigin(environment),
  };
}
