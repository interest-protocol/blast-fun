import { notFound } from "next/navigation";
import { connection } from "next/server";
import { ConnectionsRoute } from "#web/components/social/profile/ConnectionsRoute.tsx";
import { isProfileCallsign } from "@blast/core/modules/social/contracts/profiles.ts";
import { profileOf } from "./profile-reads";

export async function connectionsPage(params: Promise<{ callsign: string }>) {
  const { callsign } = await params;
  if (!isProfileCallsign(callsign)) notFound();
  await connection();
  const profile = await profileOf(callsign);
  if (profile === null) notFound();
  return <ConnectionsRoute key={profile.callsign} profile={profile} requestedCallsign={callsign} />;
}
