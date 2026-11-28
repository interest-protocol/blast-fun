import { primaryPool } from "@blast/core/modules/database/pool.ts";
import type { RateLimitPort } from "@blast/core/lib/web-security/rate-limits.ts";
import { OPERATOR_COIN_SEGMENT_LIMIT } from "@blast/core/modules/backend-api/operator-routes.ts";
import type { RuntimeConfig } from "@blast/server/config/runtime-config.ts";
import {
  createAdminPartnerKeyRoute,
  partnerKeyAdminPorts,
} from "@blast/server/modules/partner-api-keys/admin-route.ts";
import { createAdminBondingFeatureRoute } from "@blast/server/modules/launchpad-discovery/admin-feature.ts";
import { createAdminPresaleRoute } from "@blast/server/modules/social/admin-presales/route.ts";
import { createAdminVerifiedMarkRoute } from "@blast/server/modules/social/admin-verified/route.ts";
import { adminFeedback } from "@blast/server/modules/feedback/routes.ts";
import { rewardBlacklistRoute } from "@blast/server/modules/social/rewards/blacklist-runtime.ts";
import { createAdminGasPoolHealthRoute } from "@blast/server/operators/gas-pool-health.ts";
import { createAdminLoginAdmissionRoute } from "@blast/server/operators/login-admission.ts";
import * as Context from "effect/Context";
import * as Layer from "effect/Layer";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServer from "effect/http/HttpServer";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import { OperatorApi } from "../../data/api/operators/OperatorApi.ts";
import {
  OperatorRequest,
  operatorHandlers,
  type OperatorHandlers,
} from "../../features/operators/handlers.ts";
import { refusal } from "../../transport/responses.ts";
import { EXACT_ROUTER_CONFIG, routingRequest } from "./routing-request.ts";

export function createOperatorHttp(operations: OperatorHandlers) {
  const routes = HttpApiBuilder.layer(OperatorApi).pipe(
    Layer.provide(
      operatorHandlers(operations, (cause) =>
        cause instanceof Response ? cause : refusal(503, "service_unavailable", 5),
      ),
    ),
    Layer.provide(HttpServer.layerServices),
  );
  const { handler, dispose } = HttpRouter.toWebHandler(routes, {
    disableLogger: true,
    routerConfig: { ...EXACT_ROUTER_CONFIG, maxParamLength: OPERATOR_COIN_SEGMENT_LIMIT * 3 },
  });
  return Object.assign(
    (request: Request) => handler(routingRequest(request), Context.make(OperatorRequest, request)),
    { dispose },
  );
}

/** Login admission spends admission's login quota (`createBackendApi` passes it). */
export function createBackendOperators(
  config: Pick<RuntimeConfig, "loginAdmissionToken" | "gasPool"> & Readonly<{ localRun: boolean }>,
  loginQuota: RateLimitPort,
) {
  const rewardBlacklist = rewardBlacklistRoute();
  return createOperatorHttp({
    "login-admission": createAdminLoginAdmissionRoute({
      secret: config.loginAdmissionToken,
      limiter: loginQuota,
    }),
    "partner-keys": createAdminPartnerKeyRoute(partnerKeyAdminPorts(primaryPool)),
    presales: createAdminPresaleRoute(primaryPool),
    "bonding-feature": createAdminBondingFeatureRoute(primaryPool),
    "verified-mark": createAdminVerifiedMarkRoute(primaryPool),
    feedback: adminFeedback,
    "reward-coins": rewardBlacklist,
    "reward-blacklist": rewardBlacklist,
    "gas-pool-health": createAdminGasPoolHealthRoute({
      origin: () => config.gasPool?.url,
      allowLocalHttp: config.localRun,
    }),
  });
}
