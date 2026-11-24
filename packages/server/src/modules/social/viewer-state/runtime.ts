import { processSingleton } from "@blast/core/lib/process-singleton.ts";
import { sharedSocialRouteKit } from "@blast/server/modules/social/route-kit/shared-runtime.ts";
import { createSocialViewerStateRoute } from "@blast/server/modules/social/viewer-state/route.ts";

/**
 * The process's `POST /api/social/viewer-state` handler over the shared
 * social kit. It reads through the kit's transaction, on the primary (never
 * the replica), so the caller's own writes show at once.
 */
export function socialViewerStateRoute(): ReturnType<typeof createSocialViewerStateRoute> {
  return processSingleton("social.viewer-state-route", () => createSocialViewerStateRoute({ kit: sharedSocialRouteKit() }));
}
