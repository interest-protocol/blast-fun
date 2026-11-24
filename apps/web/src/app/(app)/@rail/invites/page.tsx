import { connection } from "next/server";
import { cache } from "react";

import { WatchlistCard } from "#web/components/social/watchlist/WatchlistCard.tsx";

const requestNow = cache((): number => Date.now());

/** The right column of `/invites` (the Invites board): the viewer's Watchlist, read in the browser. */
export default async function InvitesRail() {
  await connection();
  return <WatchlistCard nowMs={requestNow()} />;
}
