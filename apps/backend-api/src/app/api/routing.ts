import { publicErrorResponse } from "@blast/core/lib/http-errors.ts";
import type { ClientAddress } from "@blast/core/lib/web-security/client-address.ts";
import type { RateLimitPort } from "@blast/core/lib/web-security/rate-limits.ts";
import {
  INTERNAL_READ_PREFIX,
  type GatewayContext,
} from "@blast/core/modules/backend-api/gateway.ts";
import { operatorRoute } from "@blast/core/modules/backend-api/operator-routes.ts";
import type { PartnerV1Handlers } from "@blast/server/modules/partner-api/v1/route.ts";

import type { PartnerPreparation } from "../../transport/contracts.ts";
import type { AdmissionDependencies } from "./admission/contract.ts";
import {
  createAdmission,
  partnerClassificationRequired,
  refusePartnerRoute,
} from "./admission/unified.ts";
import { createReadHandlers } from "./reads.ts";

export type BackendApiDependencies = AdmissionDependencies &
  Readonly<{
    handlers: (limiter: RateLimitPort) => PartnerV1Handlers;
    /** Operator routes, given admission's login quota; they never build a limiter of their own. */
    operators?: (
      quota: Readonly<{ login: RateLimitPort }>,
    ) => ((request: Request) => Promise<Response | null>) & { dispose?: () => Promise<void> };
  }>;

/** Compose caller routing from admission and read dispatch. */
export function createBackendApi(dependencies: BackendApiDependencies) {
  const admission = createAdmission(dependencies);
  const reads = createReadHandlers(dependencies.handlers);
  const operators = dependencies.operators?.({ login: admission.operatorLoginQuota });

  return Object.assign(handle, {
    preparePartner,
    async dispose() {
      await Promise.all([reads.dispose(), operators?.dispose?.()]);
    },
  });

  async function handle(
    request: Request,
    client: ClientAddress,
    gatewayAuthenticated = false,
    gateway?: GatewayContext,
  ): Promise<Response> {
    const path = new URL(request.url).pathname;
    // The transport admits partner reads through preparePartner, which needs recognition.
    if (path.startsWith("/api/v1/")) {
      return partnerClassificationRequired();
    }
    if (path === "/api/admin" || path.startsWith("/api/admin/")) {
      return admission.claimUnspentProof(
        (operatorRoute(path) && (await operators?.(request))) ??
          publicErrorResponse("not_found", "Not found.", 404),
        gateway,
      );
    }
    if (path.startsWith(INTERNAL_READ_PREFIX + "/")) {
      const outcome = await admission.admit(request, {
        kind: "first-party",
        client,
        gatewayAuthenticated,
        gateway,
      });
      return outcome.kind === "admitted" ? reads.readFirstParty(outcome) : outcome.response;
    }
    return admission.claimUnspentProof(await refusePartnerRoute(request), gateway);
  }

  async function preparePartner(
    request: Request,
    client: ClientAddress,
    gateway?: GatewayContext,
  ): Promise<PartnerPreparation | null> {
    if (!admission.recognizesPartners || !new URL(request.url).pathname.startsWith("/api/v1/")) {
      return null;
    }
    const granted = await admission.admit(request, { kind: "partner", client, gateway });
    if (granted.kind === "answered") {
      return { response: granted.response };
    }
    return {
      handle: async () => {
        const outcome = await granted.consumeQuota();
        return outcome.kind === "admitted" ? reads.readPartner(outcome) : outcome.response;
      },
      release: granted.release,
    };
  }
}
