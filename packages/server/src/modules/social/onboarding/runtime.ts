import { processSingleton } from "@blast/core/lib/process-singleton.ts";
import { sharedSocialRouteKit } from "@blast/server/modules/social/route-kit/shared-runtime.ts";
import { createSocialOnboardingRoutes } from "@blast/server/modules/social/onboarding/routes.ts";

/** The process's onboarding handlers over the shared social kit (primary pool). */
export function socialOnboardingRoutes(): ReturnType<typeof createSocialOnboardingRoutes> {
  return processSingleton("social.onboarding-routes", () => createSocialOnboardingRoutes({ kit: sharedSocialRouteKit() }));
}
