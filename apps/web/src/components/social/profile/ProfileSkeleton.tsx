import { ProfileScreen, type ProfileScreenProfile } from "./ProfileScreen";

/** Use the real page's layout for both route loading and session restoration. */
export function ProfileSkeleton({ callsign, nowMs, own, profile }: Readonly<{
  callsign: string;
  nowMs: number;
  own: boolean | null;
  profile?: ProfileScreenProfile;
}>) {
  return <ProfileScreen
    data={{ own: own === true, calls: { status: "loading" }, created: { status: "loading" }, mutuals: { status: "none" }, gold: { status: "loading" }, pnl: { status: "loading" } }}
    loading
    nowMs={nowMs}
    onEdit={() => {}}
    profile={profile ? { ...profile, private: own === null ? false : profile.private, portfolio_public: own === null ? false : profile.portfolio_public } : { callsign, display_name: "Display name", avatar_url: null, x_handle: null, verified: false, private: false, portfolio_public: false }}
  />;
}
