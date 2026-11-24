"use client";

import { useQuery } from "@tanstack/react-query";
import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, type ReactNode } from "react";

import { queryKeys } from "#web/lib/query/keys.ts";
import { useAppQueryClient } from "#web/lib/query/provider.tsx";

import { UNREAD_FRESH_MS, unreadQuery } from "../queries";
import type { AccessTokenSource } from "../viewer-state-client";
import { markNotificationsSeen } from "./notifications-client";

/** A focused or re-shown tab reads the count again when its last read is older than this. */
export const UNREAD_STALE_MS = UNREAD_FRESH_MS;

export type UnreadNotifications = Readonly<{
  /** Unread notifications (0 for a visitor, or until the first read). */
  count: number;
  /** Reads the count again now. */
  refresh(): void;
  /** Takes a count a notification route just answered (after the seen write or a page read). */
  set(count: number): void;
  /**
   * Marks notifications through a fetched ID seen,
   * finishing across page navigation while this account owns the shell.
   * Resolves true once the server took it; false when it failed or could not start.
   */
  markSeen(through: string): Promise<boolean>;
}>;

const NONE: UnreadNotifications = Object.freeze({ count: 0, refresh: () => undefined, set: () => undefined, markSeen: async () => false });

const UnreadContext = createContext<UnreadNotifications>(NONE);

/**
 * The shell's unread count (rail badge, collapsed-rail dot, phone top bar
 * dot): `GET /api/social/me/notifications/unread` once per account, again
 * when the tab regains focus or becomes visible after `UNREAD_STALE_MS`, and
 * from the seen write's answer. It never polls. The count is a shared query
 * (OA-38), so the notifications page's answers write it in place.
 */
export function useUnreadNotificationsState(
  input: Readonly<{ accountId: string | null; getAccessToken?: AccessTokenSource }>,
): UnreadNotifications {
  const { accountId, getAccessToken } = input;
  const client = useAppQueryClient();
  const requestOwner = useRef<{ accountId: string | null; controller: AbortController } | null>(null);
  useLayoutEffect(() => {
    const controller = new AbortController();
    requestOwner.current = { accountId, controller };
    return () => controller.abort();
  }, [accountId]);
  const active = accountId !== null && getAccessToken !== undefined;
  const query = useQuery({ ...unreadQuery(getAccessToken ?? (async () => null)), enabled: active }, client);
  const refresh = useCallback(() => void client.invalidateQueries({ queryKey: queryKeys.me.notifications.unread() }, { cancelRefetch: false }), [client]);
  const { dataUpdatedAt } = query;

  useEffect(() => {
    if (!active) return;
    const onReturn = () => {
      if (document.visibilityState === "visible" && Date.now() - dataUpdatedAt >= UNREAD_STALE_MS) refresh();
    };
    window.addEventListener("focus", onReturn);
    document.addEventListener("visibilitychange", onReturn);
    return () => {
      window.removeEventListener("focus", onReturn);
      document.removeEventListener("visibilitychange", onReturn);
    };
  }, [active, dataUpdatedAt, refresh]);

  const set = useCallback(
    (count: number) => {
      if (!accountId) return;
      client.setQueryData(queryKeys.me.notifications.unread(), { unread_count: count });
    },
    [accountId, client],
  );
  const markSeen = useCallback(async (through: string) => {
    const owner = requestOwner.current;
    if (!accountId || !getAccessToken || owner?.accountId !== accountId || owner.controller.signal.aborted) return false;
    const signal = owner.controller.signal;
    set(0);
    const result = await markNotificationsSeen({ getAccessToken, signal }, through);
    if (signal.aborted) return false;
    if (result.status === "ok") {
      set(result.body.unread_count);
      return true;
    }
    refresh();
    return false;
  }, [accountId, getAccessToken, refresh, set]);
  const count = active ? (query.data?.unread_count ?? 0) : 0;
  return useMemo(() => ({ count, refresh, set, markSeen }), [count, refresh, set, markSeen]);
}

export function UnreadNotificationsProvider({ value, children }: Readonly<{ value: UnreadNotifications; children: ReactNode }>) {
  return <UnreadContext.Provider value={value}>{children}</UnreadContext.Provider>;
}

/** The shell's unread count, for the notifications page (a no-op outside the social shell). */
export function useUnreadNotifications(): UnreadNotifications {
  return useContext(UnreadContext);
}
