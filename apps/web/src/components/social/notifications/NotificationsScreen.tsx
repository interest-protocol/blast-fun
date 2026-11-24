"use client";

import type { LoadMoreRows } from "#web/components/blast-ui/use-appended-rows-reveal.ts";
import { diagnosticMessage, publicErrorMessage } from "#web/lib/errors.ts";

import { useQuery, type QueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { useToast } from "#web/components/blast-ui/Toasts.tsx";
import { unwrapApiResult } from "#web/lib/query/client.ts";
import { pollInterval } from "#web/lib/query/polling.ts";
import { queryKeys } from "#web/lib/query/keys.ts";
import { useAppQueryClient } from "#web/lib/query/provider.tsx";
import type { SocialNotification, SocialNotificationPage } from "@blast/core/web/contracts/notifications.ts";

import { mePresalesQuery } from "../queries";
import { SignInLink, useSocialViewer } from "../SignInGate";
import { useSocialAccount, type UseSocialAccount } from "../use-social-account";
import type { AccessTokenSource } from "../viewer-state-client";
import { fetchNotifications } from "./notifications-client";
import { NotificationsView, type NotificationsMode } from "./NotificationsView";
import { useUnreadNotifications } from "./use-unread-notifications";

type Loaded = Readonly<{
  accountId: string;
  status: "ready" | "error";
  message?: string;
  items: readonly SocialNotification[];
  cursor: string | null;
  firstPageCount: number;
  firstPageCursor: string | null;
}>;

const NO_NOTIFICATION_ID = 0n;

function cachedNotifications(client: QueryClient, accountId: string | null): Loaded | null {
  if (!accountId) return null;
  const page = client.getQueryData<SocialNotificationPage>(queryKeys.me.notifications.page(null));
  return page ? {
    accountId, status: "ready", items: page.items, cursor: page.next_cursor,
    firstPageCount: page.items.length, firstPageCursor: page.next_cursor,
  } : null;
}

/** The first page, read on every visit through the shared cache (OA-38: a second reader in flight shares it); null on any failure. */
function firstPage(client: QueryClient, getAccessToken: AccessTokenSource): Promise<SocialNotificationPage | null> {
  return client
    .fetchQuery({
      queryKey: queryKeys.me.notifications.page(null),
      queryFn: async () => unwrapApiResult(await fetchNotifications({ getAccessToken })),
      staleTime: 0,
    })
    .catch(() => null);
}

function notificationsMode(signedIn: boolean, { status, account }: Pick<UseSocialAccount, "status" | "account">, current: Loaded | null): NotificationsMode {
  if (status === "loading") return "loading";
  if (!signedIn || status === "signed_out") return "visitor";
  if (!account) return status === "ready" ? "no-account" : status === "error" ? "error" : "loading";
  if (!current) return "loading";
  if (current.status === "error") return "error";
  return current.items.length === 0 ? "empty" : "list";
}

function latestUnreadId(items: readonly SocialNotification[]): bigint {
  return items.reduce((latest, item) => {
    if (item.read) return latest;
    const id = BigInt(item.id);
    return id > latest ? id : latest;
  }, NO_NOTIFICATION_ID);
}

function readThrough(item: SocialNotification, through: bigint): SocialNotification {
  return !item.read && BigInt(item.id) <= through ? { ...item, read: true } : item;
}

/**
 * The Notifications page with its data: the signed-in account's first page
 * (`GET /api/social/me/notifications`) and older pages on "Show older".
 * A visible tab marks notifications through the latest unread ID it shows.
 * The shell owns that write across navigation. When it finds a new count,
 * the first page is read again. An arrival with an older timestamp may only
 * show up after "Show older".
 */
export function NotificationsScreen() {
  const viewer = useSocialViewer();
  const { status, account: liveAccount } = useSocialAccount();
  const unread = useUnreadNotifications();
  const toast = useToast();
  const account = viewer.signedIn ? liveAccount : null;
  const accountId = account?.account_id ?? null;
  const client = useAppQueryClient();
  const holdings = useQuery({
    ...mePresalesQuery(viewer.getAccessToken ?? (async () => null)),
    enabled: accountId !== null && viewer.getAccessToken !== undefined,
    refetchInterval: (query) => pollInterval(60_000, query),
    refetchOnWindowFocus: true,
  }, client);
  const vestingClaimCount = accountId === null ? 0 : (holdings.data?.vestings.filter((vesting) => Number(vesting.claimable) > 0).length ?? 0);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [generation, setGeneration] = useState(0);
  const [loadingMoreOwner, setLoadingMoreOwner] = useState<AbortSignal | null>(null);
  const loadingMore = loadingMoreOwner?.aborted === false;
  const [seeingOwner, setSeeingOwner] = useState<AbortSignal | null>(null);
  const seeing = seeingOwner?.aborted === false;
  const [nowMs, setNowMs] = useState(() => Date.now());
  const tokens = useRef(viewer.getAccessToken);
  const serverCount = useRef<number | null>(null);
  const seenThrough = useRef(NO_NOTIFICATION_ID);
  const failedSeen = useRef<bigint | null>(null);
  const activeWrite = useRef<AbortSignal | null>(null);
  const requestOwner = useRef<AbortController | null>(null);
  useLayoutEffect(() => {
    const controller = new AbortController();
    requestOwner.current = controller;
    serverCount.current = null;
    seenThrough.current = NO_NOTIFICATION_ID;
    failedSeen.current = null;
    activeWrite.current = null;
    return () => controller.abort();
  }, [accountId]);
  useEffect(() => {
    tokens.current = viewer.getAccessToken;
  }, [viewer.getAccessToken]);
  const { set: setUnread } = unread;
  const markSeen = useRef(unread.markSeen);
  useEffect(() => {
    markSeen.current = unread.markSeen;
  }, [unread.markSeen]);

  const acknowledgeVisible = useCallback((items: readonly SocialNotification[]) => {
    const owner = requestOwner.current?.signal;
    if (!owner || owner.aborted || activeWrite.current || document.visibilityState !== "visible") return null;
    const through = latestUnreadId(items);
    if (through <= seenThrough.current || through === failedSeen.current) return null;
    activeWrite.current = owner;
    serverCount.current = 0;
    setSeeingOwner(owner);
    const markRead = (item: SocialNotification) => readThrough(item, through);
    client.setQueryData<SocialNotificationPage>(queryKeys.me.notifications.page(null), (page) => page && ({ ...page, items: page.items.map(markRead), unread_count: 0 }));
    void markSeen.current(String(through)).then((ok) => {
      if (owner.aborted) return;
      activeWrite.current = null;
      setSeeingOwner(null);
      if (ok) {
        seenThrough.current = through;
        // Older rows may have arrived while this write was in flight.
        setLoaded((page) => page && !owner.aborted ? { ...page, items: page.items.map(markRead) } : page);
        return;
      }
      // Refresh the rows from the server without repeating this failed write.
      failedSeen.current = through;
      setGeneration((value) => value + 1);
    });
    return markRead;
  }, [client]);

  useEffect(() => {
    const source = tokens.current;
    if (!accountId || !source) return;
    const controller = new AbortController();
    void firstPage(client, source).then((page) => {
      if (controller.signal.aborted) return;
      setNowMs(Date.now());
      if (page) {
        const markRead = acknowledgeVisible(page.items);
        if (!activeWrite.current) {
          serverCount.current = page.unread_count;
          setUnread(page.unread_count);
        }
        const items = page.items.map(markRead ?? ((item) => readThrough(item, seenThrough.current)));
        const next: Loaded = {
          accountId, status: "ready", items, cursor: page.next_cursor,
          firstPageCount: items.length, firstPageCursor: page.next_cursor,
        };
        setLoaded((previous) => {
          if (previous?.accountId !== accountId || previous.firstPageCursor !== page.next_cursor) return next;
          // A count refresh can update the first page without invalidating older pages.
          return { ...next, items: [...items, ...previous.items.slice(previous.firstPageCount)], cursor: previous.cursor };
        });
        return;
      }
      const previous = client.getQueryData<SocialNotificationPage>(queryKeys.me.notifications.page(null));
      if (previous) toast(publicErrorMessage(client.getQueryState(queryKeys.me.notifications.page(null))?.error, "Notifications couldn’t refresh. Try again later."));
      else setLoaded({
        accountId, status: "error",
        message: publicErrorMessage(client.getQueryState(queryKeys.me.notifications.page(null))?.error, "Your notifications could not load. Try again."),
        items: [], cursor: null, firstPageCount: 0, firstPageCursor: null,
      });
    });
    return () => controller.abort();
  }, [accountId, acknowledgeVisible, client, generation, setUnread, toast]);

  // The shell found a different count (new notifications, or read elsewhere): read the first page again.
  // Not while the seen write is in flight: a count read before it landed would put the badge back.
  useEffect(() => {
    if (serverCount.current !== null && unread.count !== serverCount.current && !seeing) {
      serverCount.current = unread.count;
      setGeneration((value) => value + 1);
    }
  }, [unread.count, seeing]);

  const current = useMemo(() => loaded?.accountId === accountId ? loaded : cachedNotifications(client, accountId), [accountId, client, loaded]);

  useEffect(() => {
    if (!loaded || loaded.accountId !== accountId || loaded.status !== "ready" || seeing) return;
    const markVisible = () => {
      const markRead = acknowledgeVisible(loaded.items);
      if (!markRead) return;
      setLoaded((page) => {
        if (page?.accountId !== accountId) return page;
        // Only the first page is fetched again if the write fails.
        const items = page.items.map((item, index) => index < page.firstPageCount ? markRead(item) : item);
        return { ...page, items };
      });
    };
    markVisible();
    document.addEventListener("visibilitychange", markVisible);
    return () => document.removeEventListener("visibilitychange", markVisible);
  }, [accountId, acknowledgeVisible, loaded, seeing]);

  const more = useCallback<LoadMoreRows>((received) => {
    const source = tokens.current;
    const signal = requestOwner.current?.signal;
    const cursor = current?.cursor;
    if (!source || !cursor || !accountId || !signal || signal.aborted) return;
    setLoadingMoreOwner(signal);
    return fetchNotifications({ getAccessToken: source, signal }, cursor).then((result) => {
      if (signal.aborted) return;
      setLoadingMoreOwner(null);
      if (result.status !== "ok") {
        toast(diagnosticMessage("Older notifications couldn’t load. Try again.", result));
        return;
      }
      received(result.body.items.map(item => item.id));
      setLoaded((value) => {
        if (!value || value.accountId !== accountId || value.cursor !== cursor || signal.aborted) return value;
        const seen = new Set(value.items.map((item) => item.id));
        const older = result.body.items
          .filter((item) => !seen.has(item.id))
          .map((item) => readThrough(item, seenThrough.current));
        return { ...value, items: [...value.items, ...older], cursor: result.body.next_cursor };
      });
    });
  }, [accountId, current, toast]);

  const mode = notificationsMode(viewer.signedIn, { status, account }, current);

  return (
    <NotificationsView
      key={accountId}
      errorMessage={current?.message}
      hasMore={current?.cursor != null}
      items={current?.items ?? []}
      loadingMore={loadingMore}
      mode={mode}
      nowMs={nowMs}
      onMore={more}
      onRetry={() => setGeneration((value) => value + 1)}
      signIn={<SignInLink className="btn btn-primary btn-sm" />}
      vestingClaimCount={vestingClaimCount}
    />
  );
}
