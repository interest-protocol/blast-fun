import { ingressTrust } from "@blast/core/lib/web-security/ingress.ts";
import {
  partnerVerifierPooledUrl,
  primaryPooledUrl,
  replicaPooledUrl,
} from "@blast/core/modules/database/topology.ts";
import { parseRuntimeConfig } from "@blast/server/config/runtime-config.ts";
import { partnerCapacity } from "@blast/server/modules/partner-api-keys/capacity.ts";
import { validateBackendFleet } from "../config/fleet.ts";
import { backendTransportConfig, type Environment } from "../config/transport.ts";

/** Standalone hosting must reproduce the existing Vercel quota identity exactly. */
export function backendConfig(environment: Environment = process.env) {
  const config = backendTransportConfig(environment, "api");
  // Render (which sets `RENDER`) kills an instance at most 300 s after SIGTERM. The API drains for its
  // longest private budget plus 10 s, and uncapped budgets reach 300 s, so on Render it must be capped.
  if (environment.RENDER && config.maxPrivateWorkMs === undefined) {
    throw new Error(
      "On Render the API requires BLAST_BACKEND_MAX_PRIVATE_WORK_MS (at most 280000), so its drain fits the 300-second shutdown limit.",
    );
  }
  const capacity = partnerCapacity(environment.BLAST_PARTNER_CAPACITY_CONFIG);
  const partnerReservedInflight =
    Math.floor(capacity.internalMaxInflight / capacity.maxReplicas) +
    capacity.tenants.reduce(
      (total, tenant) => total + Math.floor(tenant.maxInflight / capacity.maxReplicas),
      0,
    );
  if (partnerReservedInflight >= config.maxInflight - config.maxAdminInflight) {
    throw new Error("Partner concurrency reservations exceed backend capacity.");
  }
  const fleet = validateBackendFleet(environment, {
    role: "api",
    maxHintStreams: config.maxHintStreams,
    maxInflight: config.maxInflight,
    maxApiReplicas: capacity.maxReplicas,
  });
  const ingress = ingressTrust(environment);
  // Pools open on first use and read their own URLs; boot checks the endpoints now.
  primaryPooledUrl(environment);
  replicaPooledUrl(environment);
  partnerVerifierPooledUrl(environment);
  const runtime = parseRuntimeConfig(environment);
  return { ...config, ingress, partnerReservedInflight, fleet, runtime };
}
