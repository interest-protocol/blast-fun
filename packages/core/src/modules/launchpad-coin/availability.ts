import { openingRoundEndMs, type LaunchLifecycle as SdkLifecycle } from "@interest-protocol/blast-sdk/launchpad";

import type { LaunchLifecycle } from "@blast/core/modules/launchpad-contract/discovery.ts";
import type { FreshLaunch, RecordedRoute } from "@blast/core/modules/launchpad-coin/fresh-types.ts";

/**
 * What the coin page's execution slot may offer, decided from the fresh
 * launch object only; indexed facts never authorize an action. The trade,
 * bid and migration verticals render inside the matching state:
 *
 * - `unverified`: no fresh launch object, so nothing can be offered;
 * - `opening-round`: bids gather, curve Buy/Sell is closed until settlement;
 * - `curve`: curve Buy/Sell;
 * - `migration-ready`: curve Buy/Sell is closed for good; Complete migration
 *   only when `route.supported`;
 * - `venue`: Buy/Sell on the recorded route's venue pool `poolKey`;
 * - `venue-unavailable`: migrated, but the venue cannot be traded here; the
 *   curve never reopens.
 */
export type ExecutionAvailability =
  | Readonly<{ kind: "unverified"; reason: string }>
  | Readonly<{ kind: "opening-round"; endsAtMs: bigint | null }>
  | Readonly<{ kind: "curve" }>
  | Readonly<{ kind: "migration-ready"; route: RecordedRoute }>
  | Readonly<{ kind: "venue"; route: RecordedRoute; poolKey: string }>
  | Readonly<{ kind: "venue-unavailable"; route: RecordedRoute; reason: string }>;

/** The venue pool as the page could read it: its key when blast-infra answered with data. */
export type VenueReadiness = Readonly<{ poolKey: string } | { unavailable: string }>;

export const LIFECYCLE_FROM_SDK: Readonly<Record<SdkLifecycle, LaunchLifecycle>> = {
  OpeningRound: "opening_round",
  Live: "live",
  MigrationReady: "migration_ready",
  Migrated: "migrated",
};

const UNVERIFIED: Readonly<Record<"absent" | "foreign", string>> = {
  absent: "The Sui node has no launch object with this ID.",
  foreign: "The object with this ID is not a launch of this Blast deployment.",
};

export function executionAvailability(
  input: Readonly<{ fresh: FreshLaunch; coinType: string | null; venue: VenueReadiness | null }>,
): ExecutionAvailability {
  const { fresh } = input;
  if (fresh.status === "unavailable") return { kind: "unverified", reason: fresh.reason };
  if (fresh.status !== "read") return { kind: "unverified", reason: UNVERIFIED[fresh.status] };
  if (input.coinType !== null && fresh.launch.memeType !== input.coinType) {
    return { kind: "unverified", reason: "The launch object names a different coin than blast-infra." };
  }
  switch (fresh.launch.lifecycle) {
    case "OpeningRound":
      return { kind: "opening-round", endsAtMs: openingRoundEndMs(fresh.launch) };
    case "Live":
      return { kind: "curve" };
    case "MigrationReady":
      return { kind: "migration-ready", route: fresh.route };
    case "Migrated": {
      const { route } = fresh;
      if (!route.supported) return { kind: "venue-unavailable", route, reason: route.reason ?? "unsupported route" };
      if (!input.venue || "unavailable" in input.venue) {
        return { kind: "venue-unavailable", route, reason: input.venue?.unavailable ?? "no venue pool recorded" };
      }
      return { kind: "venue", route, poolKey: input.venue.poolKey };
    }
  }
}

/** Whether the page shows the coin as tradable now: the first-view denominator's condition. */
export function isTradable(availability: ExecutionAvailability): boolean {
  return availability.kind === "curve" || availability.kind === "venue";
}
