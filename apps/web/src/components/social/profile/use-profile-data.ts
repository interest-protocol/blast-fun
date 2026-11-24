"use client";

import { useQuery } from "@tanstack/react-query";
import { useCallback, useState } from "react";

import { useShellPrefs } from "#web/components/blast-ui/use-shell-prefs.ts";
import { useHydrated } from "#web/components/ui-libraries/use-hydrated.tsx";
import { useAppQueryClient } from "#web/lib/query/provider.tsx";
import { loadableOf, useSeededQuery, type Loadable } from "#web/lib/query/seed.ts";
import type { SocialMePresales, SocialProfileCalls, SocialProfileMutuals } from "@blast/core/web/contracts/profile-page.ts";
import type { SocialPortfolio } from "@blast/core/web/contracts/portfolio.ts";
import type { SocialPnl } from "@blast/core/web/contracts/pnl.ts";

import { mePresalesQuery, mutualsQuery, profileCallsQuery, profilePnlQuery, publicPortfolioQuery } from "../queries";
import { useSocialViewer } from "../SignInGate";

/**
 * The profile page's client data, as shared queries (OA-38). The page and its
 * right column (a separate parallel route) both read a profile's calls: the
 * server hands both the same first read, which seeds the query, and a browser
 * read is one request per callsign whoever asks. Viewer reads (portfolio,
 * mutuals, own presales) run only in the browser after hydration, with the
 * viewer's credentials, and are never part of the server HTML (which is the
 * same for every reader).
 */

export type { Loadable };
export { useHydrated };

/** Wait for session restoration before choosing the owner or visitor layout. */
export function useProfileOwnership(callsign: string): Readonly<{ own: boolean; pending: boolean }> {
  const hydrated = useHydrated();
  const viewer = useSocialViewer();
  return {
    own: hydrated && viewer.signedIn && viewer.callsign !== null && viewer.callsign === callsign,
    pending: viewer.sessionPending === true || (!hydrated && viewer.signedIn),
  };
}

/** Whether the signed-in viewer is this profile's owner (browser only). */
export function useIsOwnProfile(callsign: string): boolean {
  return useProfileOwnership(callsign).own;
}

/** A profile's calls: the server's first read, or one shared browser read when the server's failed; `retry` reads again. */
export function useProfileCalls(callsign: string, initial: SocialProfileCalls | null): Loadable<SocialProfileCalls> & Readonly<{ retry: () => void }> {
  const client = useAppQueryClient();
  const [seededAt] = useState(() => Date.now());
  const query = useSeededQuery(profileCallsQuery(callsign), initial, seededAt, client);
  const { refetch } = query;
  const retry = useCallback(() => void refetch(), [refetch]);
  return { ...loadableOf(query, true), retry };
}

const noToken = async () => null;

/** Owner data stays in the viewer cache; visitors use only the opt-in public route. */
export function useProfilePnl(callsign: string, own: boolean, isPublic: boolean): Loadable<SocialPnl> & Readonly<{ retry: () => void }> {
  const viewer = useSocialViewer();
  const hydrated = useHydrated();
  const enabled = hydrated && (own || isPublic);
  const query = useQuery({ ...profilePnlQuery(viewer.getAccessToken ?? noToken, callsign, own), enabled }, useAppQueryClient());
  const { refetch } = query;
  const retry = useCallback(() => void refetch(), [refetch]);
  return { ...loadableOf(query, enabled), retry };
}

/**
 * Another account's public portfolio (OA-10), the gold card's read while its
 * owner keeps it public; `none` otherwise. One's own is on `/portfolio`
 * (R3-74), so the own profile reads none (R3-76).
 */
export function usePublicPortfolio(callsign: string, isPublic: boolean): Loadable<SocialPortfolio> {
  const hydrated = useHydrated();
  const query = useQuery({ ...publicPortfolioQuery(callsign), enabled: hydrated && isPublic }, useAppQueryClient());
  if (!hydrated) return { status: "none" };
  return loadableOf(query, isPublic);
}

/** "Followed by …": only for a signed-in viewer on someone else's profile. */
export function useMutuals(callsign: string, own: boolean): Loadable<SocialProfileMutuals> {
  const viewer = useSocialViewer();
  const hydrated = useHydrated();
  const enabled = hydrated && viewer.signedIn && viewer.callsign !== null && !own;
  const query = useQuery({ ...mutualsQuery(viewer.getAccessToken ?? noToken, callsign), enabled }, useAppQueryClient());
  return loadableOf(query, enabled);
}

/** The viewer's created presales, positions and watchlist; shared by Profile, Portfolio, the right column and Blast mode. */
export function useMePresales(enabledForPage = true, positionsOnly = false): Loadable<SocialMePresales> & Readonly<{ retry: () => void }> {
  const viewer = useSocialViewer();
  const hydrated = useHydrated();
  const enabled = enabledForPage && hydrated && viewer.signedIn && viewer.callsign !== null;
  const query = useQuery({ ...mePresalesQuery(viewer.getAccessToken ?? noToken, positionsOnly), enabled }, useAppQueryClient());
  const { refetch } = query;
  const retry = useCallback(() => void refetch(), [refetch]);
  return { ...loadableOf(query, enabled), retry };
}

/** The privacy eye's state (per device). */
export function useAmountsHidden(): boolean {
  return useShellPrefs().amountsHidden;
}
