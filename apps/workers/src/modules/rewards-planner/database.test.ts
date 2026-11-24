import assert from "node:assert/strict";
import test from "node:test";

import { rewardsPlannerPooledUrl } from "./database.ts";

test("financial planning requires the pooled indexer login on the primary database", () => {
  const primary = "postgresql://blast_app:test@ep-bold-1-pooler.c-2.us-east-1.aws.neon.tech/blast?sslmode=verify-full";
  const environment = { BLAST_WORKER_ENVIRONMENT: "production", DATABASE_URL: primary };
  const indexer = primary.replace("blast_app", "blast_indexer");
  const planner = (url: string) => rewardsPlannerPooledUrl({ ...environment, REWARDS_PLANNER_DATABASE_URL: url });

  assert.equal(planner(indexer), indexer);
  assert.throws(() => rewardsPlannerPooledUrl(environment), /REWARDS_PLANNER_DATABASE_URL is required/);
  assert.throws(() => planner(primary), /must use blast_indexer/);
  assert.throws(() => planner(indexer.replace("ep-bold-1", "ep-calm-2")), /primary database/);
  assert.throws(() => planner(indexer.replace("/blast?", "/other?")), /primary database/);
  assert.throws(() => planner(indexer.replace("-pooler", "")), /pooled/);
});
