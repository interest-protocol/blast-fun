import { primaryPool } from "@blast/core/modules/database/pool.ts";
import { processSingleton } from "@blast/core/lib/process-singleton.ts";
import { runtimeConfig } from "@blast/server/config/runtime-config.ts";
import { SocialRouteError } from "@blast/core/modules/social/route-kit/errors.ts";
import { createAdminRewardBlacklistRoute } from "@blast/server/modules/social/rewards/blacklist-route.ts";

export function rewardBlacklistRoute() {
  return processSingleton("admin.reward-blacklist-route", () =>
    createAdminRewardBlacklistRoute({
      pool: primaryPool,
      scope() {
        const deployment = runtimeConfig().presaleDeployment;
        if (deployment.status !== "ready") throw new SocialRouteError("service_unavailable");
        return {
          network: deployment.identity.network,
          originalPackageId: deployment.identity.presale.originalPackageId,
        };
      },
    }),
  );
}
