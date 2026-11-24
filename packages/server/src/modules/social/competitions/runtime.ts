import { primaryPool } from "@blast/core/modules/database/pool.ts";
import { autocommitReader } from "@blast/core/modules/database/transaction.ts";
import { sharedSocialRouteKit } from "@blast/server/modules/social/route-kit/shared-runtime.ts";
import { createCompetitionRankRoute, createCompetitionRoutes } from "./route.ts";

export function competitionRoutes() {
  return createCompetitionRoutes({
    kit: sharedSocialRouteKit(),
    database: () =>
      autocommitReader(primaryPool(), "social", {
        label: "social.competitions",
        prepare: true,
      }),
  });
}

/** The viewer's own rank, on the primary as the board is (the board's privacy checks are live there). */
export function competitionRankRoute() {
  return createCompetitionRankRoute({
    kit: sharedSocialRouteKit(),
    database: () =>
      autocommitReader(primaryPool(), "social", {
        label: "social.competitions.rank",
        prepare: true,
      }),
  });
}
