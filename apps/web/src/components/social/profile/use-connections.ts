"use client";

import { infiniteQueryOptions, useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { useEffect } from "react";

import { useHydrated } from "#web/components/ui-libraries/use-hydrated.tsx";
import { unwrapApiResult, VIEWER_STALE_MS } from "#web/lib/query/client.ts";
import { queryKeys } from "#web/lib/query/keys.ts";
import { useAppQueryClient } from "#web/lib/query/provider.tsx";
import { socialConnectionCountsSchema, socialConnectionsSchema, socialConnectionsPath, type ConnectionTab } from "@blast/core/web/contracts/connections.ts";

import { callSocialApi } from "#web/components/social/social-api.ts";
import { useSocialViewer } from "../SignInGate";

// The bot gate needs cookies; visitor reads explicitly request the public projection.
const noToken = async () => null;

function useConnectionAccess(callsign: string, isPrivate: boolean) {
  const viewer = useSocialViewer();
  const hydrated = useHydrated();
  const own = viewer.signedIn && viewer.callsign === callsign;
  return {
    enabled: hydrated && !viewer.sessionPending && (!viewer.signedIn || viewer.callsign !== null) && (!isPrivate || own),
    scope: viewer.signedIn ? viewer.callsign ?? "signed-in" : "visitor",
    getAccessToken: viewer.signedIn ? viewer.getAccessToken ?? noToken : noToken,
  };
}

export function useConnectionCounts(callsign: string, isPrivate: boolean) {
  const { enabled, scope, getAccessToken } = useConnectionAccess(callsign, isPrivate);
  return useQuery({
    queryKey: queryKeys.me.connections.counts(callsign, scope), enabled, staleTime: VIEWER_STALE_MS,
    queryFn: async ({ signal }) => unwrapApiResult(await callSocialApi({ getAccessToken, signal }, socialConnectionsPath(callsign), { method: "GET", headers: { "x-blast-public-view": scope === "visitor" ? "1" : "0" } }, socialConnectionCountsSchema)),
  }, useAppQueryClient());
}

function connectionOptions(callsign: string, scope: string, getAccessToken: ReturnType<typeof useConnectionAccess>["getAccessToken"], tab: ConnectionTab, q: string) {
  return infiniteQueryOptions({
    queryKey: queryKeys.me.connections.list(callsign, scope, tab, q), staleTime: VIEWER_STALE_MS,
    initialPageParam: null as string | null,
    queryFn: async ({ pageParam, signal }) => {
      const query = new URLSearchParams({ tab, q });
      if (pageParam !== null) query.set("cursor", pageParam);
      return unwrapApiResult(await callSocialApi({ getAccessToken, signal }, `${socialConnectionsPath(callsign)}?${query}`, { method: "GET", headers: { "x-blast-public-view": scope === "visitor" ? "1" : "0" } }, socialConnectionsSchema));
    },
    getNextPageParam: (page) => page.next_cursor,
  });
}

export function useConnections(callsign: string, isPrivate: boolean, tab: ConnectionTab, q: string) {
  const { enabled, scope, getAccessToken } = useConnectionAccess(callsign, isPrivate);
  const client = useAppQueryClient();
  useEffect(() => {
    if (!enabled) return;
    const adjacent = connectionOptions(callsign, scope, getAccessToken, tab === "followers" ? "following" : "followers", "");
    if (!client.getQueryData(adjacent.queryKey)) void client.prefetchInfiniteQuery({ ...adjacent, pages: 1 });
  }, [client, enabled, callsign, scope, getAccessToken, tab]);
  return useInfiniteQuery({ ...connectionOptions(callsign, scope, getAccessToken, tab, q), enabled, staleTime: 0, refetchOnMount: "always" }, client);
}

export function usePrefetchConnections(callsign: string, isPrivate: boolean) {
  const { enabled, scope, getAccessToken } = useConnectionAccess(callsign, isPrivate);
  const client = useAppQueryClient();
  return (tab: ConnectionTab) => {
    if (enabled) void client.prefetchInfiniteQuery({ ...connectionOptions(callsign, scope, getAccessToken, tab, ""), pages: 1 });
  };
}
