import { processSingleton } from "@blast/core/lib/process-singleton.ts";
import { primaryPool } from "@blast/core/modules/database/pool.ts";
import { autocommitReader } from "@blast/core/modules/database/transaction.ts";
import { socialFeedDatabase } from "@blast/server/modules/social/feed/runtime.ts";
import { sharedSocialRouteKit } from "@blast/server/modules/social/route-kit/shared-runtime.ts";
import { createSocialBuyAlertRoutes } from "@blast/server/modules/social/buy-alerts/route.ts";

/** The process's followed buy alert handlers: followed wallets on the primary (a follow just written counts), cards on the replica. */
export function socialBuyAlertRoutes(): ReturnType<typeof createSocialBuyAlertRoutes> {
  return processSingleton("social.buy-alert-routes", () =>
    createSocialBuyAlertRoutes({
      kit: sharedSocialRouteKit(),
      primary: () => autocommitReader(primaryPool(), "social", { label: "social.buy-alerts" }),
      replica: socialFeedDatabase,
    }));
}
