import { connection } from "next/server";
import { cache } from "react";

import { WatchlistCard } from "#web/components/social/watchlist/WatchlistCard.tsx";

/**
 * The right column of `/notifications` (canonical UI §13, §5.5): the
 * viewer's Watchlist, read in the browser with the viewer's credentials
 * (personal, never in the server HTML). A visitor sees the empty card.
 */
const requestNow = cache((): number => Date.now());

export default async function NotificationsRail() {
  await connection();
  return <WatchlistCard nowMs={requestNow()} />;
}
