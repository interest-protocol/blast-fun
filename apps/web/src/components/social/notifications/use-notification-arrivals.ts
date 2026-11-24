"use client";

import type { SubscribeNotificationArrivals } from "#web/components/blast-ui/notification-feedback.ts";
import { pollInterval } from "#web/lib/query/polling.ts";
import { useQuery, type QueryClient } from "@tanstack/react-query";
import { useCallback, useLayoutEffect, useRef } from "react";
import { unwrapApiResult } from "#web/lib/query/client.ts";
import { queryKeys } from "#web/lib/query/keys.ts";
import { useAppQueryClient } from "#web/lib/query/provider.tsx";
import type { AccessTokenSource } from "../viewer-state-client";
import { fetchNotifications } from "./notifications-client";
import { notificationArrivals } from "./notification-arrivals";

const sessions = new WeakMap<QueryClient, Map<string, ReturnType<typeof notificationArrivals>>>();

/** There is no private push stream; look for delivered IDs only in a visible, active session. */
export function useNotificationArrivals(accountId: string | null, getAccessToken: AccessTokenSource | undefined, setCount: (count: number) => void): SubscribeNotificationArrivals {
  const client = useAppQueryClient();
  const listeners = useRef(new Set<() => void>());
  const owner = useRef<{ receive: ReturnType<typeof notificationArrivals>; baseline: boolean; epoch: number } | null>(null);
  useLayoutEffect(() => {
    if (!accountId) return;
    let accounts = sessions.get(client);
    if (!accounts) { accounts = new Map(); sessions.set(client, accounts); }
    let receive = accounts.get(accountId);
    if (!receive) { receive = notificationArrivals(); accounts.set(accountId, receive); }
    const session = { receive, baseline: true, epoch: 0 };
    owner.current = session;
    const silence = () => { session.baseline = true; session.epoch++; };
    window.addEventListener("focus", silence);
    window.addEventListener("online", silence);
    document.addEventListener("visibilitychange", silence);
    return () => {
      owner.current = null;
      window.removeEventListener("focus", silence);
      window.removeEventListener("online", silence);
      document.removeEventListener("visibilitychange", silence);
    };
  }, [accountId, client]);
  useQuery({
    queryKey: queryKeys.me.notifications.arrivals(),
    enabled: accountId !== null && getAccessToken !== undefined,
    refetchInterval: (query) => pollInterval(60_000, query),
    refetchOnWindowFocus: true,
    refetchOnMount: "always",
    queryFn: async ({ signal }) => {
      const session = owner.current;
      const epoch = session?.epoch;
      const countVersion = client.getQueryState(queryKeys.me.notifications.unread())?.dataUpdateCount;
      const page = unwrapApiResult(await fetchNotifications({ getAccessToken: getAccessToken!, signal }));
      if (signal.aborted || !session || owner.current !== session) return page;
      const active = document.visibilityState === "visible" && session.epoch === epoch;
      // shortcut: the newest page covers live arrivals; add a delivery cursor if backfills must pulse too.
      const arrived = session.receive(page.items, active && !session.baseline);
      session.baseline = !active;
      // A mark-read or newer count answered while this snapshot was in flight.
      if (client.getQueryState(queryKeys.me.notifications.unread())?.dataUpdateCount === countVersion) setCount(page.unread_count);
      if (arrived) for (const listener of listeners.current) listener();
      return page;
    },
  }, client);
  return useCallback((listener: () => void) => {
    listeners.current.add(listener);
    return () => { listeners.current.delete(listener); };
  }, []);
}
