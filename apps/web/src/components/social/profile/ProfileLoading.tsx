"use client";

import { useParams } from "next/navigation";
import { useState } from "react";
import { queryKeys } from "#web/lib/query/keys.ts";
import { useAppQueryClient } from "#web/lib/query/provider.tsx";
import { ProfileView } from "../ProfileView";
import { useSocialViewer } from "../SignInGate";
import type { ProfileScreenProfile } from "./ProfileScreen";
import { ProfileSkeleton } from "./ProfileSkeleton";

export function ProfileLoading() {
  const callsign = useParams<{ callsign: string }>()?.callsign;
  const viewer = useSocialViewer();
  const client = useAppQueryClient();
  const [nowMs] = useState(() => Date.now());
  const cached = callsign ? client.getQueryData<ProfileScreenProfile>(queryKeys.profiles.detail(callsign)) : undefined;
  if (cached) return <ProfileView profile={cached} initialCalls={null} nowMs={nowMs} />;
  const own = viewer.sessionPending || viewer.signedIn && !viewer.callsign ? null : viewer.signedIn && viewer.callsign === callsign;
  return <ProfileSkeleton callsign={callsign ?? ""} nowMs={nowMs} own={own} />;
}
