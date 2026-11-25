"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { queryKeys } from "#web/lib/query/keys.ts";
import { useAppQueryClient } from "#web/lib/query/provider.tsx";

import type { SocialProfileCalls, SocialProfileEdit } from "@blast/core/web/contracts/profile-page.ts";
import type { SocialProfile } from "@blast/core/web/contracts/profiles.ts";

import { EditProfileSheet, type ProfilePreview } from "./profile/EditProfileSheet";
import { portfolioTrend, type PortfolioTrendView } from "./profile/portfolio-trend";
import { goldFigures, type GoldFigures } from "./profile/profile-model";
import { ProfileScreen, type ProfileScreenProfile } from "./profile/ProfileScreen";
import { useAmountsHidden, useProfileOwnership, useMutuals, usePublicPortfolio, useProfileCalls, useProfilePnl, useMePresales } from "./profile/use-profile-data";
import { ProfileSkeleton } from "./profile/ProfileSkeleton";
import { useSocialViewer } from "./SignInGate";
import { useSocialAccount } from "./use-social-account";

const noToken = async () => null;

/**
 * The owner's saved details over the server's profile, and over those a
 * save's details shown before the server answers (taken back on a refusal).
 */
function useEditedProfile(profile: ProfileScreenProfile, own: boolean): {
  confirmed: ProfileScreenProfile;
  shown: ProfileScreenProfile;
  setEdited: (edited: Pick<SocialProfileEdit, "display_name" | "avatar_url" | "bio">) => void;
  setPreview: (preview: ProfilePreview | null) => void;
} {
  const [edited, setEdited] = useState<Pick<SocialProfileEdit, "display_name" | "avatar_url" | "bio"> | null>(null);
  const [preview, setPreview] = useState<ProfilePreview | null>(null);
  const confirmed = edited && own ? { ...profile, ...edited } : profile;
  const shown = preview && own ? { ...confirmed, ...preview } : confirmed;
  return { confirmed, shown, setEdited, setPreview };
}

/**
 * `/@<callsign>`: public identity and calls arrive from the server. Keep the
 * page's shared skeleton while the browser restores the viewer, then choose
 * the owner layout (profile actions and Created) or the visitor layout
 * (Follow, mutuals and an opt-in public portfolio).
 */
export function ProfileView({
  profile,
  initialCalls,
  nowMs,
}: Readonly<{
  profile: Omit<SocialProfile, "as_of">;
  /** The calls read on the server; null when that read failed (the page then reads them). */
  initialCalls: SocialProfileCalls | null;
  nowMs: number;
}>) {
  const viewer = useSocialViewer();
  const router = useRouter();
  const client = useAppQueryClient();
  useEffect(() => {
    client.setQueryData(queryKeys.profiles.detail(profile.callsign), profile);
  }, [client, profile]);
  const account = useSocialAccount();
  const { own, pending } = useProfileOwnership(profile.callsign);
  const [editing, setEditing] = useState(false);
  const { confirmed, shown, setEdited, setPreview } = useEditedProfile(profile, own);
  const calls = useProfileCalls(profile.callsign, initialCalls);
  const mePresales = useMePresales(own, true);
  const mutuals = useMutuals(profile.callsign, own);
  const portfolio = usePublicPortfolio(profile.callsign, !pending && !own && profile.portfolio_public);
  const pnl = useProfilePnl(profile.callsign, own, !pending && !profile.private && profile.portfolio_public);
  const hidden = useAmountsHidden();
  const api = { getAccessToken: viewer.getAccessToken ?? noToken };
  const gold = portfolio.status === "ready" ? { status: "ready" as const, value: goldFigures(portfolio.value) as GoldFigures } : portfolio;
  // The 30-day line: the account's daily snapshots (OA-25 Q16); null until it has a month of them (`portfolio-trend.ts`).
  const trend: PortfolioTrendView | null = portfolioTrend(portfolio.status === "ready" ? portfolio.value : null);
  // Do not flash the visitor layout while the browser restores the owner's session.
  if (pending) {
    return <ProfileSkeleton callsign={profile.callsign} nowMs={nowMs} own={viewer.callsign ? viewer.signedIn && viewer.callsign === profile.callsign : null} profile={profile} />;
  }
  return (
    <ProfileScreen
      data={{
        own,
        calls,
        retryCalls: calls.retry,
        created: mePresales.status === "ready" ? { status: "ready", value: mePresales.value.created } : mePresales,
        retryCreated: mePresales.retry,
        mutuals,
        gold,
        trend,
        pnl,
        retryPnl: pnl.retry,
        hidden,
      }}
      nowMs={nowMs}
      onEdit={() => setEditing(true)}
      profile={shown}
      sheet={
        own ? (
          <EditProfileSheet
            api={api}
            avatarUrl={shown.avatar_url}
            callsign={profile.callsign}
            onClose={() => setEditing(false)}
            onPreview={setPreview}
            onReopen={() => setEditing(true)}
            onSaved={(edit) => {
              setEdited({ display_name: edit.display_name, avatar_url: edit.avatar_url, bio: edit.bio });
              const callsignChanged = edit.callsign && edit.callsign !== profile.callsign;
              // Refresh the shell only for details carried by `me`.
              if (callsignChanged || edit.display_name !== confirmed.display_name || edit.avatar_url !== confirmed.avatar_url) {
                account.refresh();
              }
              if (callsignChanged) {
                void client.invalidateQueries({ queryKey: queryKeys.profiles.all });
                router.replace(`/@${edit.callsign}`);
              }
            }}
            open={editing}
          />
        ) : null
      }
    />
  );
}
