import { processSingleton } from "@blast/core/lib/process-singleton.ts";
import { runtimeConfig } from "@blast/server/config/runtime-config.ts";
import { trackRequestWork } from "@blast/server/lib/request-work.ts";
import { configuredLaunchReadChain } from "@blast/server/modules/launchpad-coin/chain.ts";
import { memoizeTradable, tradableNow } from "@blast/server/modules/launchpad-coin/read.ts";
import { coinPageDependencies } from "@blast/server/modules/launchpad-coin/runtime.ts";
import { createLaunchpadTelemetryRouteHandler } from "@blast/server/modules/launchpad-telemetry/route.ts";
import { createLaunchpadOutcomeCommitmentRouteHandler, createLaunchpadOutcomeRouteHandler, createOutcomeVerifier } from "@blast/server/modules/launchpad-telemetry/outcomes.ts";
import { launchpadOutcomeEmitter, launchpadPrivySessionWallet } from "@blast/server/modules/launchpad-telemetry/runtime.ts";
import type { PrivateHandlers } from "./handler.ts";

export const LAUNCHPAD_TELEMETRY_HANDLERS = {
  "launchpad.telemetry.view": (request, { client }) => handlers().view(request, client),
  "launchpad.telemetry.outcome": (request, { client }) => handlers().outcome(request, client),
  "launchpad.telemetry.commitment": (request, { client }) => handlers().commitment(request, client),
} satisfies PrivateHandlers;

function handlers() {
  return processSingleton("launchpad-telemetry.handlers", () => {
    const expectedOrigin = runtimeConfig().siteOrigin;
    const emitter = launchpadOutcomeEmitter();
    let chain: ReturnType<typeof configuredLaunchReadChain> | undefined;
    const verify = createOutcomeVerifier(() => (chain ??= configuredLaunchReadChain()), { trackWork: trackRequestWork });

    return {
      view: createLaunchpadTelemetryRouteHandler({
        expectedOrigin,
        verifyTradable: memoizeTradable(async (launchId) => tradableNow(launchId, await coinPageDependencies(), { trackWork: trackRequestWork })),
        emitter,
      }),
      outcome: createLaunchpadOutcomeRouteHandler({ expectedOrigin, verify, emitter, verifyPrivySession: launchpadPrivySessionWallet() }),
      commitment: createLaunchpadOutcomeCommitmentRouteHandler({ expectedOrigin, emitter }),
    };
  });
}
