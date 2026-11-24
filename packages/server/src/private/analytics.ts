import { processSingleton } from "@blast/core/lib/process-singleton.ts";
import { runtimeConfig } from "@blast/server/config/runtime-config.ts";
import { createAccountActivityService } from "../modules/analytics/activity.ts";
import type { PrivateHandlers } from "./handler.ts";

export const ANALYTICS_HANDLERS = {
  "analytics.account.activity": (request) =>
    processSingleton("analytics.account-activity", () =>
      createAccountActivityService(runtimeConfig().accountActivity),
    ).handle(request),
} satisfies PrivateHandlers;
