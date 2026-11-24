import { errorLabel, recordMetric } from "@blast/core/lib/metrics.ts";
import { runtimeConfig } from "@blast/server/config/runtime-config.ts";
import { privyGateway } from "@blast/server/config/privy-gateway.ts";
import { createPrivySessionVerifier } from "@blast/server/lib/privy-adapter/adapter.ts";
import { PostgresRateLimitEnforcer } from "@blast/core/modules/database/postgres-rate-limits.ts";
import { databaseFor } from "@blast/core/modules/read-routing/databases.ts";

import { LaunchpadMutationError, launchpadErrorResponse, publicLaunchpadError } from "@blast/server/modules/launchpad-identity/errors.ts";
import type { LaunchpadMutationDependencies } from "@blast/server/modules/launchpad-identity/mutation.ts";
import { LaunchpadIdentityService } from "@blast/server/modules/launchpad-identity/service.ts";

export type LaunchpadRuntime = LaunchpadMutationDependencies & {
  identity: LaunchpadIdentityService;
};

/**
 * The production wiring every launchpad write route shares: the primary pool,
 * the shared rate-limit registry, the process's Privy gateway and the site
 * origin, all from the runtime config boot validated.
 */
export function launchpadRuntime(): LaunchpadRuntime {
  const config = runtimeConfig();
  const pool = databaseFor("write");
  const limiter = new PostgresRateLimitEnforcer({ pool, subjectPepper: config.subjectPepper });
  const verifier = createPrivySessionVerifier({
    appId: config.privy.appId,
    gateway: privyGateway(),
  });
  const identity = new LaunchpadIdentityService(pool, {
    limiter,
    subjectPepper: config.launchpadSubjectPepper,
    verifyPrivySession: (accessToken) => verifier.verifySession(accessToken),
  });
  return { expectedOrigin: config.siteOrigin, identity, limiter, pool };
}

/**
 * Runs a launchpad route with the runtime, or answers 503 when it cannot be
 * set up. The failure is reported as metric `launchpad.identity` (outcome
 * `config_unavailable`, a fixed `reason`) and one warning; neither carries a
 * setting's value or an error message.
 */
export async function withLaunchpadRuntime(
  operation: (runtime: LaunchpadRuntime) => Promise<Response>,
): Promise<Response> {
  let runtime: LaunchpadRuntime;
  try {
    runtime = launchpadRuntime();
  } catch (error) {
    const requestId = crypto.randomUUID();
    const reason = `setup_failed:${errorLabel(error)}`;
    recordMetric("launchpad.identity", { requestId, outcome: "config_unavailable", reason });
    console.warn(JSON.stringify({
      requestId,
      level: "warn",
      message: "Launchpad writes are unavailable until the runtime is configured.",
      reason,
    }));
    return launchpadErrorResponse(
      requestId,
      publicLaunchpadError(new LaunchpadMutationError("LAUNCHPAD_UNAVAILABLE")),
    );
  }
  try {
    return await operation(runtime);
  } catch (error) {
    return launchpadErrorResponse(crypto.randomUUID(), publicLaunchpadError(error));
  }
}
