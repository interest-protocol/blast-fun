import type { Metadata } from "next";
import { connection } from "next/server";

import { BondingScreen } from "#web/components/social/bonding/BondingScreen.tsx";
import { readBondingHeroFromBackend } from "#web/lib/backend-api/bonding.ts";

export const metadata: Metadata = { title: "Bonding curves", alternates: { canonical: "/bonding" } };

/**
 * `/bonding`: every launchpad curve by stage. Answered only while the launchpad is on for the request.
 * The featured hero is read here so it is in the first paint and the tabs below it never move.
 */
export default async function BondingPage() {
  await connection();
  return <BondingScreen hero={await readBondingHeroFromBackend()} />;
}
