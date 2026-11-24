"use client";

import { usePathname, useSelectedLayoutSegment, redirect } from "next/navigation";
import type { ReactNode } from "react";
import { connectionsPagePath } from "@blast/core/web/contracts/connections.ts";
import type { SocialProfile } from "@blast/core/web/contracts/profiles.ts";
import { ConnectionsView } from "./ConnectionsView";
import { ConnectionsLoading } from "./ConnectionsLoading";

export { ConnectionsLoading } from "./ConnectionsLoading";

export function ConnectionsRoute({ profile, requestedCallsign }: Readonly<{ profile: SocialProfile; requestedCallsign: string }>) {
  const segment = useSelectedLayoutSegment();
  const tab = segment === "following" ? "following" : "followers";
  if (profile.callsign !== requestedCallsign) redirect(connectionsPagePath(profile.callsign, tab));
  return <ConnectionsView profile={profile} tab={tab} />;
}

export function ProfileRouteLoading({ children }: Readonly<{ children?: ReactNode }>) {
  const path = usePathname();
  return /\/(followers|following)$/.test(path ?? "") ? <ConnectionsLoading /> : children;
}
