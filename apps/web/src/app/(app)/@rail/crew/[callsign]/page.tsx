import { connection } from "next/server";

import { ProfileAside } from "#web/components/social/profile/ProfileAside.tsx";
import { isProfileCallsign } from "@blast/core/modules/social/contracts/profiles.ts";

import { profileCallsOf, profileOf, requestNow } from "#web/app/(app)/(social)/crew/[callsign]/profile-reads.ts";

type Params = Promise<{ callsign: string }>;

/**
 * The profile's right column (§5.5): "In right now" and "Watchlist" on one's
 * own profile, "In right now" and "Backed together" on someone else's. The
 * public parts come from the page's own server reads (shared per request);
 * the viewer's parts are read in the browser.
 */
export default async function ProfileRail({ params }: Readonly<{ params: Params }>) {
  const { callsign } = await params;
  if (!isProfileCallsign(callsign)) return null;
  await connection();
  const nowMs = requestNow();
  const [profile, calls] = await Promise.allSettled([profileOf(callsign), profileCallsOf(callsign)]);
  if (profile.status !== "fulfilled" || !profile.value) return null;
  const firstName = (profile.value.display_name ?? callsign).split(" ")[0] ?? callsign;
  return (
    <ProfileAside
      callsign={callsign}
      firstName={firstName}
      initialCalls={calls.status === "fulfilled" ? calls.value : null}
      nowMs={nowMs}
    />
  );
}
