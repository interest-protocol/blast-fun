import type { ClientAddress } from "@blast/core/lib/web-security/client-address.ts";
import { deploymentFingerprint } from "@interest-protocol/blast-sdk/deployments";
import { PRESALE_PAUSE_BITS } from "@interest-protocol/blast-sdk/presale";
import { SuiGrpcClient } from "@mysten/sui/grpc";
import { reserveAfterResponse } from "@blast/server/lib/request-work.ts";
import { boundedFetch } from "@blast/server/lib/bounded-fetch.ts";

import { processSingleton } from "@blast/core/lib/process-singleton.ts";
import { runtimeConfig } from "@blast/server/config/runtime-config.ts";
import { PostgresRateLimitEnforcer } from "@blast/core/modules/database/postgres-rate-limits.ts";
import { databaseFor } from "@blast/core/modules/read-routing/databases.ts";
import { presaleNodeUrl } from "@blast/core/modules/presale/deployment/node.ts";
import { presaleDeploymentGate, presaleSigningIdentity } from "@blast/server/modules/presale/deployment/runtime.ts";
import { presaleEmbeddedWallets } from "@blast/server/modules/presale/embedded-wallets/runtime.ts";
import { presaleOutcomeRecorder } from "../presale/outcomes/runtime.ts";
import { PresaleRouteError } from "@blast/core/modules/presale/route-kit/errors.ts";
import { signingCheck, type SponsorIntent } from "@blast/core/modules/sponsor/intents.ts";
import {
  presaleRateLimiter,
  presaleRouteKit,
} from "@blast/server/modules/presale/route-kit/runtime.ts";
import {
  createSponsorChain,
  createSponsorTransactionLookup,
  type SponsorChain,
  type SponsorTransactionLookup,
} from "./chain.ts";
import { createPresaleSponsorExecuteRoute } from "./execute.ts";
import { createSponsorSignatureVerifier } from "./signature.ts";
import {
  PostgresSponsorExecutions,
  type SponsorExecutionStore,
} from "./executions.ts";
import { gasPoolExecutor } from "./pool-execute.ts";
import { PostgresSponsorReservations } from "./reservations.ts";
import {
  createPresaleSponsorRoute,
  createSponsorService,
  requireSponsorConfig,
  type PresaleSponsorService,
  type PresaleSponsorServiceDependencies,
} from "./service.ts";

function authorizeSponsorSigning(intent: SponsorIntent, signal?: AbortSignal) {
  const gate = presaleDeploymentGate();
  const check = signingCheck(intent);
  if (!check.identity) return gate.authorize({ signal });
  return presaleSigningIdentity(gate, {
    signal,
    presalePauseBit: check.pauseBit === null ? undefined : PRESALE_PAUSE_BITS[check.pauseBit],
  });
}

/**
 * The sponsor's production dependencies: the shared deployment gate, the
 * embedded wallet resolver, the presale node (the deployment gate's node),
 * the primary database, and the settings parsed at boot (without a sponsor,
 * each request is `service_unavailable`).
 */
function presaleSponsorDependencies(): PresaleSponsorServiceDependencies {
  return processSingleton("presale.sponsor-dependencies", () => {
    const config = runtimeConfig();
    const deployment = presaleDeploymentGate();
    let chain: SponsorChain | undefined;
    let limiter: PostgresRateLimitEnforcer | undefined;
    /** Read after the gate authorized the identity, so the state is ready. */
    const node = (): SponsorChain => {
      if (chain) return chain;
      const baseUrl = presaleNodeUrl(deployment.state, config.suiNodeUrl);
      if (!baseUrl || deployment.state.status !== "ready")
        throw new PresaleRouteError("deployment_unavailable");
      const { identity } = deployment.state;
      chain = createSponsorChain({
        client: new SuiGrpcClient({
          network: identity.network,
          baseUrl,
          format: "text",
          fetch: boundedFetch(8000),
        }),
        identity,
      });
      return chain;
    };
    return {
      deployment,
      authorizeSigning: authorizeSponsorSigning,
      wallets: presaleEmbeddedWallets(),
      chain: {
        creatorKind: (...args) => node().creatorKind!(...args),
        presaleTypes: (...args) => node().presaleTypes(...args),
        rewardRounds: (...args) => node().rewardRounds(...args),
        vestingSchedules: (...args) => node().vestingSchedules(...args),
        gasContext: (...args) => node().gasContext(...args),
        simulate: (...args) => node().simulate(...args),
      },
      reservations: new PostgresSponsorReservations(databaseFor("write")),
      executions: {
        today(accountKey) {
          limiter ??= new PostgresRateLimitEnforcer({
            pool: databaseFor("write"),
            subjectPepper: config.subjectPepper,
          });
          return limiter.peek("presale_sponsor_exec", { accountId: accountKey });
        },
      },
      // The sponsor's per-IP, per-account daily and platform-wide budgets, counted after the dry run.
      limits: presaleRateLimiter(),
      config: () => requireSponsorConfig(config.sponsor),
    };
  });
}

/** The process's `POST /api/presale/sponsor` handler over `presaleSponsorDependencies` and the shared route kit. */
export function presaleSponsorRoute(): (request: Request, client: ClientAddress) => Promise<Response> {
  return processSingleton("presale.sponsor-route", () =>
    createPresaleSponsorRoute({
      ...presaleSponsorDependencies(),
      kit: presaleRouteKit(),
    }),
  );
}

/**
 * The same sponsor, in-process: the social swap path's `trade` intent
 * (social feed R3-31) sponsors the kind it built, with no HTTP hop.
 */
export function sponsorService(): PresaleSponsorService {
  return processSingleton("presale.sponsor-service", () =>
    createSponsorService(presaleSponsorDependencies()),
  );
}

/**
 * The process's `POST /api/presale/sponsor/{reservation_id}/execute` handler:
 * the shared route kit, the reservation table on the primary database,
 * the sponsor service's execute call (`PRESALE_GAS_POOL_URL`, `PRESALE_GAS_POOL_TOKEN`),
 * the presale node for digest lookups, and the shared outcome recorder, run
 * after the response. The database is resolved per call, so a missing one
 * fails only the requests that reach it.
 */
export function presaleSponsorExecuteRoute(): (
  request: Request,
  client: ClientAddress,
) => Promise<Response> {
  return processSingleton("presale.sponsor-execute-route", () => {
    const config = runtimeConfig();
    const store = (): SponsorExecutionStore =>
      new PostgresSponsorExecutions(databaseFor("write"));
    return createPresaleSponsorExecuteRoute({
      kit: presaleRouteKit(),
      executions: {
        find: (...args) => store().find(...args),
        submit: (...args) => store().submit(...args),
        expire: (...args) => store().expire(...args),
        revoke: (...args) => store().revoke(...args),
        settle: (...args) => store().settle(...args),
        unconfirm: (...args) => store().unconfirm(...args),
      },
      async authorizeSubmission(row, signal) {
        if (!signingCheck(row.intent).identity) return;
        const state = presaleDeploymentGate().state;
        const manifest = state.status === "ready" ? state.identity.manifest : undefined;
        if (manifest && row.deploymentFingerprint !== deploymentFingerprint(manifest)) {
          throw new PresaleRouteError("reservation_expired");
        }
        await authorizeSponsorSigning(row.intent, signal).catch(() => {
          throw new PresaleRouteError("service_unavailable");
        });
      },
      pool: () => gasPoolExecutor(config.gasPool),
      transactions: presaleSponsorTransactionLookup(),
      verifySignature: createSponsorSignatureVerifier(presaleNodeClient),
      outcomes: presaleOutcomeRecorder(),
      reserveBackground: reserveAfterResponse,
      limits: presaleRateLimiter(),
    });
  });
}

/**
 * The presale identity's node (the runtime config's `presaleDeployment` and
 * `suiNodeUrl`), built on first use. Without a ready identity it throws.
 */
function presaleNodeClient(): SuiGrpcClient {
  return processSingleton("presale.sponsor-node", () => {
    const config = runtimeConfig();
    const state = config.presaleDeployment;
    const baseUrl = presaleNodeUrl(state, config.suiNodeUrl);
    if (!baseUrl || state.status !== "ready")
      throw new Error("The presale node is not configured.");
    return new SuiGrpcClient({
      network: state.identity.network,
      baseUrl,
      format: "text",
      fetch: boundedFetch(8000),
    });
  });
}

/**
 * Execute's digest lookup on the presale identity's node. Without a ready
 * identity each lookup rejects, which the route treats as not found.
 */
export function presaleSponsorTransactionLookup(): SponsorTransactionLookup {
  let lookup: SponsorTransactionLookup | undefined;
  return Object.freeze({
    async effects(digest: string, options?: { signal?: AbortSignal }) {
      lookup ??= createSponsorTransactionLookup(presaleNodeClient());
      return lookup.effects(digest, options);
    },
  });
}
