import {
  databaseEndpoint,
  requirePooled,
  sameDatabaseHost,
} from "@blast/core/modules/database/topology.ts";

/** Financial planning uses the indexer's primary login. */
export function rewardsPlannerPooledUrl(environment: NodeJS.ProcessEnv = process.env): string {
  const name = "REWARDS_PLANNER_DATABASE_URL";
  const planner = databaseEndpoint(name, environment[name], environment);
  if (!planner) {
    throw new Error(`${name} is required.`);
  }
  requirePooled(name, planner);
  if (planner.login !== "blast_indexer") {
    throw new Error(`${name} must use blast_indexer.`);
  }
  const primary = databaseEndpoint("DATABASE_URL", environment.DATABASE_URL, environment);
  if (primary && (!sameDatabaseHost(planner, primary) || planner.database !== primary.database)) {
    throw new Error(`${name} must name the primary database.`);
  }
  return planner.url;
}
