import type { Pool } from "pg";

import { primaryPool, replicaPool } from "../database/pool.ts";
import { WORKLOAD_ROUTES, type DatabaseWorkload } from "./resources.ts";

/** The pool a database workload uses, as `WORKLOAD_ROUTES` says. The replica fails closed without its endpoint. */
export function databaseFor(workload: DatabaseWorkload): Pool {
  return WORKLOAD_ROUTES[workload].host === "replica" ? replicaPool() : primaryPool();
}
