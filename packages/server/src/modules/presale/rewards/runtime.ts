import { processSingleton } from "@blast/core/lib/process-singleton.ts";
import { databaseFor } from "@blast/core/modules/read-routing/databases.ts";
import { presaleRouteKit } from "@blast/server/modules/presale/route-kit/runtime.ts";
import { postgresPublishedManifests } from "@blast/core/modules/presale/rewards/manifests.ts";
import { createRewardManifestRoutes, type RewardManifestRoutes } from "@blast/core/modules/presale/rewards/routes.ts";

/**
 * The process's manifest route: the shared presale route kit and the primary
 * database (a manifest is served as soon as its round is recorded published).
 * The database is reached on first use, so a missing setting fails a request
 * as `service_unavailable`, never the module.
 */
export function presaleRewardManifestRoutes(): RewardManifestRoutes {
  return processSingleton("presale.reward-manifest-routes", () =>
    createRewardManifestRoutes({ kit: presaleRouteKit(), rounds: postgresPublishedManifests(databaseFor("consistent-read")) }));
}
