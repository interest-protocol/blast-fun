import { trackRequestWork } from "@blast/server/lib/request-work.ts";
import type { ClientAddress } from "@blast/core/lib/web-security/client-address.ts";

import { processSingleton } from "@blast/core/lib/process-singleton.ts";
import { runtimeConfig } from "@blast/server/config/runtime-config.ts";
import { PostgresRateLimitEnforcer } from "@blast/core/modules/database/postgres-rate-limits.ts";
import type {
  RateLimitPort,
} from "@blast/core/lib/web-security/rate-limits.ts";
import { databaseFor } from "@blast/core/modules/read-routing/databases.ts";
import { presaleEmbeddedWallets } from "@blast/server/modules/presale/embedded-wallets/runtime.ts";
import { presaleRouteKit } from "@blast/server/modules/presale/route-kit/runtime.ts";
import {
  createPresaleOutcomeRecorder,
  type PresaleOutcomeRecorder,
} from "./recorder.ts";
import { PostgresPresaleOutcomeStore } from "./repository.ts";
import { createPresaleOutcomeRoutes } from "./routes.ts";
import type { PresaleOutcomeStore } from "./store.ts";
import {
  createPresaleOutcomeVerifier,
  presaleOutcomeSource,
} from "./verifier.ts";
import { createPresaleVisitorRouteHandler } from "./visitor.ts";

/** The primary pool, resolved per call: an unconfigured database fails only that call (`service_unavailable`). */
const store: PresaleOutcomeStore = {
  recordCommitment: (commitment) =>
    new PostgresPresaleOutcomeStore(databaseFor("write")).recordCommitment(
      commitment,
    ),
  recordOutcome: (outcome) =>
    new PostgresPresaleOutcomeStore(databaseFor("write")).recordOutcome(
      outcome,
    ),
};

/**
 * The process's one presale outcome recorder: the presale identity's node
 * (`RuntimeConfig.presaleDeployment`, `.suiNodeUrl`), read with the
 * launchpad's per-process bound, the primary database, and the embedded
 * wallet resolver. The outcome route and the sponsored execute route (T-018,
 * `recordSponsoredCommit`) share it, so they share that bound.
 */
export function presaleOutcomeRecorder(): PresaleOutcomeRecorder {
  return processSingleton("presale.outcome-recorder", () => {
    let source: ReturnType<typeof presaleOutcomeSource> | undefined;
    return createPresaleOutcomeRecorder({
      store,
      verify: createPresaleOutcomeVerifier(
        async () => {
          const config = runtimeConfig();
          return (source ??= presaleOutcomeSource(config.presaleDeployment, config.suiNodeUrl));
        },
        { trackWork: trackRequestWork },
      ),
      embeddedWallet: (privyDid) =>
        trackRequestWork(presaleEmbeddedWallets().find(privyDid)),
    });
  });
}

/** `POST /api/presale/outcomes/commitments` and `POST /api/presale/outcomes` over the shared presale route kit. */
export function presaleOutcomeRouteHandlers() {
  return processSingleton("presale.outcome-routes", () =>
    createPresaleOutcomeRoutes({
      kit: presaleRouteKit(),
      expectedOrigin: runtimeConfig().siteOrigin,
      store,
      recorder: presaleOutcomeRecorder(),
    }),
  );
}

/**
 * `POST /api/presale/outcomes/visitor`: the shared rate-limit table with
 * `RATE_LIMIT_SUBJECT_PEPPER`, as the route kit uses it; a missing database
 * fails only a mint, as `service_unavailable`.
 */
export function presaleVisitorRouteHandler(): (
  request: Request,
  client: ClientAddress,
) => Promise<Response> {
  return processSingleton("presale.visitor-route", () => {
    let limiter: RateLimitPort | undefined;
    return createPresaleVisitorRouteHandler({
      expectedOrigin: runtimeConfig().siteOrigin,
      limiter: {
        consume(bucket, subject) {
          limiter ??= new PostgresRateLimitEnforcer({
            pool: databaseFor("write"),
            subjectPepper: runtimeConfig().subjectPepper,
          });
          return limiter.consume(bucket, subject);
        },
      },
    });
  });
}
