import { sharedRouteLimiter } from "@blast/core/modules/web-security/route-limits.ts";
import { runtimeConfig } from "@blast/server/config/runtime-config.ts";
import { gateRefreshResponse } from "../lib/web-security/gate-refresh.ts";
import type { PrivateHandlers } from "./handler.ts";

/** Browser bootstrap business and durable attempt counting have one backend owner. */
export const FRONTEND_SECURITY_HANDLERS = {
  "frontend.gate.refresh": (request, { client }) => {
    const config = runtimeConfig();
    return gateRefreshResponse(request, client, {
      expectedOrigin: config.siteOrigin,
      keys: config.gateKeys,
      limiter: () => sharedRouteLimiter(),
    });
  },
} satisfies PrivateHandlers;
