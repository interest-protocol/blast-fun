"use client";

import { pollInterval } from "#web/lib/query/polling.ts";
import { isPresaleViewerResponse, socialPresaleViewerResponseSchema } from "@blast/core/web/contracts/presale-schemas.ts";

import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";

import { tabActivityHints } from "#web/components/social/home/activity-hints.ts";
import { presaleDetailQuery, presaleViewerQuery } from "#web/components/social/queries.ts";
import { callSocialApi, isRecord, type SocialApiOptions } from "#web/components/social/social-api.ts";
import { queryKeys } from "#web/lib/query/keys.ts";
import { useSeededQuery } from "#web/lib/query/seed.ts";
import { useAppQueryClient } from "#web/lib/query/provider.tsx";
import { useSocialViewer } from "#web/components/social/SignInGate.tsx";
import {
  SOCIAL_PRESALE_VIEWER_PATH,
  type SocialPresaleDetail,
  type SocialPresaleViewerEntry,
  type SocialPresaleViewerRequest,
  type SocialPresaleViewerResponse,
} from "@blast/core/web/contracts/presales.ts";

export { isPresaleViewerResponse };

/**
 * The signed-in viewer's own view: `{ presale_ids }`, `{ status }` or
 * `{ mine: true }`. Null for a visitor's `401`, any other refusal, an
 * unreadable answer or a network failure.
 */
export async function fetchPresaleViewer(
  options: SocialApiOptions,
  request: SocialPresaleViewerRequest,
): Promise<SocialPresaleViewerResponse | null> {
  const answer = await callSocialApi(options, SOCIAL_PRESALE_VIEWER_PATH, { method: "POST", body: request }, socialPresaleViewerResponseSchema);
  return answer.status === "ok" ? answer.body : null;
}

/** The token source for a viewer without one: the wallet session's cookie goes alone (OA-16). */
export const NO_ACCESS_TOKEN = (): Promise<string | null> => Promise.resolve(null);

export type ViewerPresales = Readonly<Record<string, SocialPresaleViewerEntry>>;

/**
 * The signed-in viewer's followed backers and own position for `presaleIds`
 * (one shared query per distinct set, OA-38: the sale page, its right column,
 * Blast mode's panel and the celebration read the same entry; nothing for a
 * visitor). `reads` above zero
 * is a read asked for again (a claim answered): it reads past the cache.
 */
export function useViewerPresalesRead(presaleIds: readonly string[], reads = 0) {
  const viewer = useSocialViewer();
  const client = useAppQueryClient();
  const ids = [...new Set(presaleIds)].sort().slice(0, 50);
  const enabled = viewer.signedIn && ids.length > 0;
  const query = useQuery({ ...presaleViewerQuery(viewer.getAccessToken ?? NO_ACCESS_TOKEN, ids), enabled, refetchInterval: (read) => pollInterval(30_000, read) }, client);
  const asked = useRef(reads);
  const key = ids.join(",");
  useEffect(() => {
    if (asked.current === reads) return;
    asked.current = reads;
    if (enabled) void client.invalidateQueries({ queryKey: queryKeys.me.presaleViewer(key.split(",")), exact: true });
  }, [client, enabled, key, reads]);
  return {
    data: viewer.signedIn ? query.data?.presales ?? null : null,
    status: !enabled ? "inactive" as const : query.isError ? "error" as const : query.data ? "ready" as const : "loading" as const,
    retry: () => { void query.refetch(); },
  };
}

export function useViewerPresales(presaleIds: readonly string[], reads = 0): ViewerPresales | null {
  return useViewerPresalesRead(presaleIds, reads).data;
}

const FALLBACK_READ_MS = 30_000;
const MAX_TIMER_MS = 2_147_483_647;
const disconnected = () => false;
const noSubscription = () => () => undefined;

/** Refresh at a sale's deadline; poll unfinished sales only while hints are unavailable. */
export function saleReadEveryMs(sale: Pick<SocialPresaleDetail["presale"], "phase" | "start_ms" | "end_ms">, nowMs: number, connected = false): number | false {
  if (sale.phase === "trading" || sale.phase === "cancelled") return false;
  const fallback = connected ? false : FALLBACK_READ_MS;
  const deadline = sale.phase === "open" ? sale.end_ms : sale.phase === "pending" ? sale.start_ms : 0;
  if (deadline > nowMs) return Math.min(fallback || MAX_TIMER_MS, Math.max(2_000, deadline - nowMs));
  // The edge may still say open just after the deadline.
  return sale.phase === "open" ? 2_000 : fallback;
}

/** The plain fallback poll is spread so tabs drift apart; deadline reads stay on time. */
function spreadFallback(everyMs: number | false, read: Parameters<typeof pollInterval>[1]): number | false {
  return everyMs === FALLBACK_READ_MS ? pollInterval(everyMs, read) : everyMs;
}

/** The server seeds one shared query; mutations, infra hints and deadlines refresh it. */
export function useSaleDetail(detail: SocialPresaleDetail, nowMs: number): SocialPresaleDetail {
  const client = useAppQueryClient();
  const hints = tabActivityHints();
  const connected = useSyncExternalStore(hints?.subscribeConnection ?? noSubscription, hints?.connected ?? disconnected, disconnected);
  const id = detail.presale.presale_id;
  const query = useSeededQuery(
    {
      ...presaleDetailQuery(id),
      enabled: true,
      refetchInterval: (read) => (isSaleDetail(read.state.data, id) ? read.state.data.presale.phase === "trading" && read.state.data.terms?.buyer_vesting ? pollInterval(30_000, read) : spreadFallback(saleReadEveryMs(read.state.data.presale, Date.now(), connected), read) : false),
    },
    detail,
    nowMs,
    client,
  );
  return isSaleDetail(query.data, id) ? query.data : detail;
}

/** Whether the public read's body is this sale's detail (the query is shared with readers that take only a part of it). */
const isSaleDetail = (body: unknown, presaleId: string): body is SocialPresaleDetail =>
  isRecord(body) && isRecord(body.presale) && body.presale.presale_id === presaleId && isRecord(body.raise) && isRecord(body.backers);

/** Now, ticking every `everyMs` after mount; the first render uses `serverNowMs` so the markup matches the server's. */
export function useNow(serverNowMs: number, everyMs = 1_000): number {
  const [now, setNow] = useState(serverNowMs);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), everyMs);
    return () => window.clearInterval(timer);
  }, [everyMs]);
  return now;
}
