import type { MigratorVenue as SdkMigratorVenue } from "@interest-protocol/blast-sdk/migrators";

import { SUI_OBJECT_ID_SOURCE } from "@blast/core/lib/sui/ids.ts";

/** The DEX venues a launch migrates to: the migrators SDK's venues, in display order. */
export const MIGRATOR_VENUES = ["cetus", "bluefin"] as const satisfies readonly SdkMigratorVenue[];
export type MigratorVenue = (typeof MIGRATOR_VENUES)[number];

/** Every market a launch trades on: its bonding curve, then the DEX venues it migrates to. */
export const VENUES = ["blast_curve", ...MIGRATOR_VENUES] as const;
export type Venue = (typeof VENUES)[number];

/** Each migrator venue's pool product; keyed by exactly the SDK's venues. */
export const VENUE_PRODUCTS = { cetus: "Cetus CLMM", bluefin: "Bluefin Spot" } as const satisfies Record<SdkMigratorVenue, string>;

/** A pool key, `<venue>:<pool id>`, on any venue; groups 1 and 2 are the venue and the pool id. */
export const POOL_KEY = new RegExp(`^(${VENUES.join("|")}):(${SUI_OBJECT_ID_SOURCE})$`);

/** A migrated DEX pool's key, `<migrator venue>:<pool id>`. */
export const MIGRATOR_POOL_KEY = new RegExp(`^(${MIGRATOR_VENUES.join("|")}):(${SUI_OBJECT_ID_SOURCE})$`);

export function isVenue(venue: string): venue is Venue {
  return (VENUES as readonly string[]).includes(venue);
}

export function isMigratorVenue(venue: string): venue is MigratorVenue {
  return (MIGRATOR_VENUES as readonly string[]).includes(venue);
}
