/**
 * The discovery views' names, the launch lifecycles and Near graduation's key,
 * browser-safe so the web response parser and the rail share them with the
 * server read (`discovery.ts` re-exports them).
 */

export const DISCOVERY_VIEWS = ["new", "near_graduation", "graduated"] as const;
export type DiscoveryView = (typeof DISCOVERY_VIEWS)[number];

export const LAUNCH_LIFECYCLES = ["opening_round", "live", "migration_ready", "migrated"] as const;
export type LaunchLifecycle = (typeof LAUNCH_LIFECYCLES)[number];

/** Atomic Quote left to the graduation target, saturating at 0: Near graduation's key. */
export function quoteRemaining(quoteReserve: bigint, graduationTarget: bigint): bigint {
  return graduationTarget > quoteReserve ? graduationTarget - quoteReserve : 0n;
}
