/**
 * Filesystem-backed database administration entry point.
 *
 * Application routes must import runtime primitives from `database/index.ts`,
 * not this Node CLI/test-only module.
 */
export { migrateDatabase, resetDatabase } from "./migrations.ts";
export { createPool } from "./pool.ts";
export { migrationDatabaseUrl } from "./topology.ts";
