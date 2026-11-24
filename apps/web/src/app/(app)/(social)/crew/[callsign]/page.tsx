import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { connection } from "next/server";

import { PublicTraderPortfolio } from "#web/components/social/coin-home/PublicTraderPortfolio.tsx";
import { ProfileView } from "#web/components/social/ProfileView.tsx";
import { SocialProfileUnavailable } from "#web/components/social/SocialPlaceholders.tsx";
import { recordMetric } from "@blast/core/lib/metrics.ts";
import { isProfileCallsign } from "@blast/core/modules/social/contracts/profiles.ts";

import { profileCallsOf, profileOf, requestNow } from "./profile-reads";

type Params = Promise<{ callsign: string }>;

export async function generateMetadata({ params }: Readonly<{ params: Params }>): Promise<Metadata> {
  const { callsign } = await params;
  if (!isProfileCallsign(callsign)) return { title: "Page not found" };
  await connection();
  const profile = await profileOf(callsign);
  if (profile === null) return { title: "Page not found" };
  // FEATURE-MAP §0.3: `<Display name> · Blast` (the layout adds " · Blast").
  return { title: profile.display_name ?? `@${callsign}` };
}

/**
 * A Blast Account's profile, served at `/@<callsign>` (OA-4: the proxy
 * rewrites that address to this page, and `/crew/<callsign>` redirects to
 * it while the feed is on). The identity and the calls (the first section)
 * are read on the server on the replica exactly as their routes read them,
 * once per request for the page and its right column. No viewer is read:
 * the HTML is the same for every reader. A callsign no account holds (or one
 * that is not a callsign) renders the social not-found view; a Mission
 * Control member who never opened Blast gets its account on this first read.
 */
export default async function CrewProfilePage({ params, searchParams }: Readonly<{ params: Params; searchParams: Promise<{ view?: string }> }>) {
  const { callsign } = await params;
  if (!isProfileCallsign(callsign)) notFound();
  await connection();
  const nowMs = requestNow();
  const [profile, calls] = await Promise.allSettled([profileOf(callsign), profileCallsOf(callsign)]);
  if (profile.status === "rejected") {
    recordMetric("social.profile_page", { outcome: "error" });
    return <SocialProfileUnavailable callsign={callsign} />;
  }
  if (!profile.value) notFound();
  if (profile.value.callsign !== callsign) redirect(`/@${profile.value.callsign}`);
  if (calls.status === "rejected") recordMetric("social.profile_calls", { outcome: "error" });
  if ((await searchParams).view === "portfolio") return <PublicTraderPortfolio callsign={profile.value.callsign} />;
  return <ProfileView initialCalls={calls.status === "fulfilled" ? calls.value : null} nowMs={nowMs} profile={profile.value} />;
}
