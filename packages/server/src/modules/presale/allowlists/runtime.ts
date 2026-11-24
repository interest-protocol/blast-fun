import { runtimeConfig } from "@blast/server/config/runtime-config.ts";
import { boundedFetch } from "@blast/server/lib/bounded-fetch.ts";
import { SuiGrpcClient } from "@mysten/sui/grpc";
import type { RateLimitPort } from "@blast/core/lib/web-security/rate-limits.ts";

import { processSingleton } from "@blast/core/lib/process-singleton.ts";
import { databaseFor } from "@blast/core/modules/read-routing/databases.ts";
import { createPresaleApiKeyVerifier } from "../api-keys/repository.ts";
import { presaleNodeUrl } from "@blast/core/modules/presale/deployment/node.ts";
import { presaleDeploymentGate } from "@blast/server/modules/presale/deployment/runtime.ts";
import { presaleRouteKit } from "@blast/server/modules/presale/route-kit/runtime.ts";
import { createAllowlistBindingRoutes, type AllowlistBindingRoutes } from "./binding-routes.ts";
import { createAllowlistCsvRead } from "./csv.ts";
import { presaleEligibilityReader } from "./eligibility.ts";
import { creationPolicyQuotes, CREATION_POLICY_TIMEOUT_MS } from "./policy.ts";
import { createAllowlistRoutes, type AllowlistRoutes } from "./routes.ts";

/**
 * The deployment identity's node as a Core API client, created on first use
 * and shared by every allowlist route in the process; null when no identity
 * or no node fits (`presaleNodeUrl`).
 */
function presaleAllowlistNode(timeoutMs = 8_000): SuiGrpcClient | null {
  return processSingleton(`presale.allowlist-node:${timeoutMs}`, () => {
    const state = presaleDeploymentGate().state;
    const baseUrl = presaleNodeUrl(state, runtimeConfig().suiNodeUrl);
    return {
      client: baseUrl && state.status === "ready" ? new SuiGrpcClient({ network: state.identity.network, baseUrl, format: "text", fetch: boundedFetch(timeoutMs) }) : null,
    };
  }).client;
}

/**
 * The production allowlist routes: the presale route kit with agent API keys
 * verified against `presale_api_keys`, the primary pool, and the creation
 * policy read from the deployment identity's node (no identity, no warning).
 */
export function presaleAllowlistRoutes(): AllowlistRoutes {
  return processSingleton("presale.allowlist-routes", () => {
    const pool = () => databaseFor("write");
    return createAllowlistRoutes({
      kit: presaleRouteKit({ verifyApiKey: createPresaleApiKeyVerifier(pool) }),
      pool,
      allowedQuotes: creationPolicyQuotes({ state: presaleDeploymentGate().state, client: () => presaleAllowlistNode(CREATION_POLICY_TIMEOUT_MS) }),
    });
  });
}

/**
 * The production bind and proof routes: the presale route kit with agent API
 * keys, the primary pool, and sales read through the SDK's `PresaleClient`
 * on the same node (none configured: `deployment_unavailable`).
 */
export function presaleAllowlistBindingRoutes(): AllowlistBindingRoutes {
  return processSingleton("presale.allowlist-binding-routes", () => {
    const pool = () => databaseFor("write");
    return createAllowlistBindingRoutes({
      kit: presaleRouteKit({ verifyApiKey: createPresaleApiKeyVerifier(pool) }),
      pool,
      eligibility: presaleEligibilityReader({ client: presaleAllowlistNode }),
    });
  });
}

/**
 * The proof route for partner v1 reads. Admission already charged
 * `presale_proof` to the partner key, so the kit draws from `limiter`.
 */
export function presaleAllowlistProofRoute(limiter: RateLimitPort): AllowlistBindingRoutes["proof"] {
  return createAllowlistBindingRoutes({
    kit: presaleRouteKit({ limiter }),
    pool: () => databaseFor("write"),
    eligibility: presaleEligibilityReader({ client: presaleAllowlistNode }),
  }).proof;
}

/** Bulk downloads are exposed only through authenticated partner admission. */
export function presaleAllowlistCsvRoute() {
  return processSingleton("presale.allowlist-csv", () => {
    const readEligibility = presaleEligibilityReader({ client: presaleAllowlistNode });
    return createAllowlistCsvRead({
      pool: () => databaseFor("write"),
      async eligibility(presaleId, signal) {
        const identity = await presaleDeploymentGate().authorize({ signal });
        return readEligibility(identity, presaleId);
      },
    });
  });
}
