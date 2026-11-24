import type { Metadata } from "next";
import { connection } from "next/server";
import { cache } from "react";

import { PortfolioScreen } from "#web/components/social/portfolio/PortfolioScreen.tsx";

export const metadata: Metadata = { title: "Portfolio", robots: { index: false, follow: false } };

const requestNow = cache((): number => Date.now());

/**
 * `/portfolio` (R3-74, the oa41 gate's `#portfolio`): everything the viewer
 * owns on one page — the total and today's move, the three figures, Deposit
 * and Withdraw, and the holdings card. Personal data: read in the browser
 * with the viewer's credentials, never server-rendered or cached. The social
 * layout already answers not-found while the social feed is off. The right
 * column is `@rail/portfolio` (In right now, Watchlist).
 */
export default async function PortfolioPage() {
  await connection();
  return <PortfolioScreen nowMs={requestNow()} />;
}
