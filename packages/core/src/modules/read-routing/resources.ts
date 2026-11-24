/**
 * The one table of where each workload goes. Writes, reads that decide or
 * must see a write, social and moderation records go to the pooled primary.
 * Search and thesis joins read chain identity from blast-infra's versioned
 * `chain_read_v1` views on the pooled read replica. blast-infra is the only chain indexer and serves
 * market facts and market reads from its own `/v1`, to this server only (the
 * browser reads them through the same-origin `/api/launchpad/market` routes);
 * the web app never recomputes them in SQL. `databaseFor` (databases.ts)
 * routes a workload named as data through this table; code that always reads
 * one compute calls `primaryPool()` or `replicaPool()` (database/pool.ts).
 *
 * Freshness is chain time: how long ago the source's committed checkpoint
 * was produced (`chain_read_v1.watermark` for the database, each `/v1`
 * answer's `provenance` for blast-infra), so it includes blast-infra's own
 * delay. A replica resource's
 * policy says how old its data may be (`maxLagMs`) and what happens past it.
 * Only when the primary's checkpoint is strictly ahead of the replica's and
 * the primary is itself within `maxLagMs` (`replica-lag`) does
 * `onLag: "primary"` read the primary; `onLag: "stale"` serves the replica
 * stale up to `maxStaleMs`, Unavailable beyond. Otherwise (`indexer-lag`:
 * the primary is equal, or ahead but also outside `maxLagMs`) both stay on
 * the replica, stale (search Unavailable past `maxStaleMs`). readChainJoin
 * applies the rule.
 * A blast-infra resource past `maxLagMs` is served stale.
 */
export const WORKLOAD_ROUTES = Object.freeze({
  write: Object.freeze({ host: "primary" }),
  "consistent-read": Object.freeze({ host: "primary" }),
  social: Object.freeze({ host: "primary" }),
  moderation: Object.freeze({ host: "primary" }),
  "discovery-market-facts": Object.freeze({ host: "blast-infra", maxLagMs: 30_000 }),
  market: Object.freeze({ host: "blast-infra", maxLagMs: 30_000 }),
  search: Object.freeze({ host: "replica", maxLagMs: 10_000, onLag: "stale", maxStaleMs: 120_000 }),
  "thesis-join": Object.freeze({ host: "replica", maxLagMs: 5_000, onLag: "primary" }),
} as const);

export type Workload = keyof typeof WORKLOAD_ROUTES;
type WorkloadsOn<Host> = {
  [Name in Workload]: (typeof WORKLOAD_ROUTES)[Name]["host"] extends Host ? Name : never;
}[Workload];
export type ReplicaResource = WorkloadsOn<"replica">;
export type MarketResource = WorkloadsOn<"blast-infra">;
export type DatabaseWorkload = WorkloadsOn<"primary" | "replica">;

// The shared read types belong to the launchpad read contract.
export type { Provenance, RoutedRead } from "../launchpad-contract/read.ts";
