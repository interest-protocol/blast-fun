
import { privyGateway } from "@blast/server/config/privy-gateway.ts";
import { runtimeConfig } from "@blast/server/config/runtime-config.ts";
import { createPrivySessionVerifier } from "@blast/server/lib/privy-adapter/adapter.ts";
import { trackRequestWork } from "@blast/server/lib/request-work.ts";
import { PostgresRateLimitEnforcer } from "@blast/core/modules/database/postgres-rate-limits.ts";
import { databaseFor } from "@blast/core/modules/read-routing/databases.ts";

import { createLaunchpadTelemetryEmitter, type LaunchpadTelemetryEmitter } from "@blast/server/modules/launchpad-telemetry/emitter.ts";
import { LAUNCHPAD_STORAGE_TIMEOUTS } from "@blast/server/modules/launchpad-telemetry/gate.ts";
import type { PrivySessionWallet } from "@blast/server/modules/launchpad-telemetry/outcomes.ts";
import { LaunchpadTelemetryService } from "@blast/server/modules/launchpad-telemetry/service.ts";

/**
 * The production emitter the outcome routes share. The pool and limiter are
 * resolved per call inside the emitter, so an unconfigured or unavailable
 * database becomes a 503 for that request and nothing else.
 */
export function launchpadOutcomeEmitter(): LaunchpadTelemetryEmitter {
  return createLaunchpadTelemetryEmitter(() => {
    const pool = databaseFor("write");
    return new LaunchpadTelemetryService(pool, {
      limiter: new PostgresRateLimitEnforcer({
        pool,
        subjectPepper: runtimeConfig().subjectPepper,
        timeouts: LAUNCHPAD_STORAGE_TIMEOUTS,
      }),
    });
  }, { trackWork: trackRequestWork });
}

/**
 * Verifies a report's Privy access token with the identity module's verifier
 * (`createPrivySessionVerifier`) over the process's Privy gateway.
 */
export function launchpadPrivySessionWallet(): PrivySessionWallet {
  return async (accessToken) => {
    const session = await trackRequestWork(createPrivySessionVerifier({
      appId: runtimeConfig().privy.appId,
      gateway: privyGateway(),
    }).verifySession(accessToken));
    return { suiWalletAddress: session.suiWalletAddress };
  };
}
