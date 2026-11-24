import { processSingleton } from "@blast/core/lib/process-singleton.ts";
import { sharedSocialRouteKit, socialAccounts } from "@blast/server/modules/social/route-kit/shared-runtime.ts";
import { socialPortfolioDatabase } from "@blast/server/modules/social/portfolio/runtime.ts";
import { createSocialPnlRoutes } from "@blast/server/modules/social/portfolio/pnl-route.ts";

export function socialPnlRoutes(): ReturnType<typeof createSocialPnlRoutes> {
  return processSingleton("social.pnl-routes", () => createSocialPnlRoutes({
    kit: sharedSocialRouteKit(), wallets: socialAccounts(), database: socialPortfolioDatabase,
  }));
}
