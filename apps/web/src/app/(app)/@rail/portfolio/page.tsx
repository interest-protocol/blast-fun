import { connection } from "next/server";
import { cache } from "react";

import { PortfolioAside } from "#web/components/social/portfolio/PortfolioAside.tsx";

const requestNow = cache((): number => Date.now());

/**
 * The right column of `/portfolio` (R3-74): "In right now" and the
 * Watchlist, read in the browser with the viewer's credentials (personal,
 * never in the server HTML). A visitor sees the Watchlist's empty card.
 */
export default async function PortfolioRail() {
  await connection();
  return <PortfolioAside nowMs={requestNow()} />;
}
