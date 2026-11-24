import type { CoinActionSlots } from "../coin/CoinExecution";
import { CurveTradeUnavailable } from "./CurveTradeRail";
import { CoinTrade } from "./CoinTrade";
import type { TradeAvailability, TradeUnavailable } from "./server-availability";
import { VenueTradeUnavailable } from "./VenueTradeRail";
import { isMigratorVenue } from "@blast/core/modules/launchpad-contract/venues.ts";

/** Why the venue rail cannot sign for `venue` here: the venue dispatch first, then the app's deployment. */
export function venueTradeReason(venue: string, availability: TradeUnavailable): string {
  if (!isMigratorVenue(venue)) {
    return `This launch trades on ${venue}, which this app cannot trade yet. Its pool and history stay readable here; nothing can be signed.`;
  }
  return availability.reason;
}

/**
 * The coin page's `trade` slot for both routes: the curve rail for the
 * bonding curve, and the venue rail for the pool the launch recorded at
 * migration (the page offers it only for a Migrated launch on a supported
 * recorded route). The venue is never chosen here. Without a released,
 * connected deployment, each says why nothing can be signed.
 */
export function coinTradeActions(availability: TradeAvailability): CoinActionSlots {
  return {
    trade: (context) => {
      if (availability.status === "available" && (context.venue === "blast_curve" || isMigratorVenue(context.venue))) {
        return <CoinTrade />;
      }
      const unavailable = availability.status === "unavailable" ? availability : { status: "unavailable" as const, reason: "This venue is not supported." };
      return context.venue === "blast_curve" ? <CurveTradeUnavailable reason={unavailable.reason} /> : <VenueTradeUnavailable reason={venueTradeReason(context.venue, unavailable)} />;
    },
  };
}
