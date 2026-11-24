import { primaryPool } from "@blast/core/modules/database/pool.ts";
import { processSingleton } from "@blast/core/lib/process-singleton.ts";
import { autocommitReader } from "@blast/core/modules/database/transaction.ts";
import { sharedSocialRouteKit } from "@blast/server/modules/social/route-kit/shared-runtime.ts";
import { createSocialNotificationRoutes } from "@blast/server/modules/social/notifications/route.ts";

/** The process's notification handlers over the shared social kit; reads on the primary. */
export function socialNotificationRoutes(): ReturnType<typeof createSocialNotificationRoutes> {
  return processSingleton("social.notification-routes", () =>
    createSocialNotificationRoutes({
      kit: sharedSocialRouteKit(),
      database: () => autocommitReader(primaryPool(), "social", { label: "social.notifications" }),
    }));
}
