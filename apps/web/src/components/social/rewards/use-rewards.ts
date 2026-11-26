"use client";

import { readBrowserStorage, writeBrowserStorage } from "#web/lib/browser-storage.ts";
import { publicErrorMessage } from "#web/lib/errors.ts";

import { savedListContent, useListContent } from "#web/components/blast-ui/list-restoration.ts";
import type { InfiniteData } from "@tanstack/react-query";
import type { SocialRewardsPage } from "@blast/core/web/contracts/rewards.ts";
import { useInfiniteQuery, useQueries, useQuery } from "@tanstack/react-query";
import { useEffect, useMemo } from "react";

import { EXPLORER_NAMES, explorerTransactionUrl } from "@blast/core/lib/explorer.ts";
import { useDevicePrefs } from "#web/components/blast-ui/device-prefs.ts";
import { useToast } from "#web/components/blast-ui/Toasts.tsx";
import { useAppQueryClient } from "#web/lib/query/provider.tsx";
import type { SocialPriceHistory } from "@blast/core/web/contracts/prices.ts";

import { priceQuery } from "../prices/price-client";
import { useHydrated } from "../profile/use-profile-data";
import { rewardsCoinQuery, rewardsSummaryQuery } from "../queries";
import { useSocialViewer } from "../SignInGate";
import { useSocialAccount } from "../use-social-account";
import { payoutToast, rewardSourceId, rewardCoinMeta, rewardCoins, rewardPayouts, type RewardCoinMeta, type RewardPayoutView, type RewardsView } from "./rewards-model";

const noToken = async () => null;

/** The rewards read as the tab, the page and the side card use it: `off` for a visitor (no read). */
export type RewardsRead = Readonly<{
  errorMessage?: string;
  /** Who is reading (Portfolio's modes): the session is not known yet, a visitor, a session without an account, or an account. */
  viewer: "loading" | "visitor" | "no-account" | "ready";
  status: "off" | "loading" | "ready" | "error";
  view: RewardsView | null;
  meta: RewardCoinMeta;
  /** Reads again (the failed state's "Try again"). */
  retry: () => void;
}>;

/**
 * The viewer's rewards (`GET /api/social/me/rewards?limit=5`, one shared
 * read) with R3-20's prices for every coin that paid and for its quote coin:
 * a dollar figure only where both are known.
 */
function rewardViewerState(hydrated: boolean, signedIn: boolean, session: ReturnType<typeof useSocialAccount>["status"], account: boolean): RewardsRead["viewer"] {
  if (!hydrated || session === "loading") return "loading";
  if (!signedIn || session === "signed_out") return "visitor";
  if (!account && session !== "error") return "no-account";
  return "ready";
}

export function useRewards(): RewardsRead {
  const viewer = useSocialViewer();
  const hydrated = useHydrated();
  const client = useAppQueryClient();
  const { status: session, account } = useSocialAccount();
  const enabled = hydrated && viewer.signedIn && viewer.callsign !== null;
  const who = rewardViewerState(hydrated, viewer.signedIn, session, account !== null);
  const read = useQuery({ ...rewardsSummaryQuery(viewer.getAccessToken ?? noToken, viewer.callsign ?? ""), enabled }, client);
  const page = read.data ?? null;
  const asks = useMemo(() => {
    const out: { key: string; kind: "presale" | "coin"; id: string }[] = [];
    const quotes = new Set<string>();
    for (const coin of page?.coins ?? []) {
      if (coin.payouts === 0) continue;
      if (coin.presale_id) out.push({ key: rewardSourceId(coin), kind: "presale", id: coin.presale_id });
      if (coin.quote_type && !quotes.has(coin.quote_type)) {
        quotes.add(coin.quote_type);
        out.push({ key: coin.quote_type, kind: "coin", id: coin.quote_type });
      }
    }
    return out;
  }, [page]);
  const priceReads = useQueries({ queries: asks.map((ask) => ({ ...priceQuery({ kind: ask.kind, id: ask.id, window: "24h" }), enabled })) }, client);
  const meta = useMemo(() => rewardCoinMeta(page?.coins ?? null), [page]);
  const latest = useMemo(() => (page ? rewardPayouts(page.payouts, meta) : null), [page, meta]);
  const prices = new Map<string, SocialPriceHistory | null | undefined>();
  asks.forEach((ask, index) => prices.set(ask.key, priceReads[index]?.data));
  const view = page && latest ? { coins: rewardCoins(page.coins, prices), latest } : null;
  const status = !enabled ? "off" : read.isError && !page ? "error" : page ? "ready" : "loading";
  return { viewer: who, status, view, meta, errorMessage: publicErrorMessage(read.error, "Your rewards could not load. Try again."), retry: () => void read.refetch() };
}

/** One coin's rounds on the Rewards page: five, then ten more at a time; read only while it is open. */
export function useRewardCoinPayouts(sourceId: string, meta: RewardCoinMeta, open: boolean) {
  const viewer = useSocialViewer();
  const client = useAppQueryClient();
  const identity = `portfolio:${viewer.callsign ?? "visitor"}:payouts:${sourceId}`;
  const options = rewardsCoinQuery(viewer.getAccessToken ?? noToken, sourceId, meta.get(sourceId)?.vaultId);
  const read = useInfiniteQuery({ ...options, initialData: savedListContent<InfiniteData<SocialRewardsPage, string | null>>(identity), enabled: open && viewer.signedIn }, client);
  useListContent(identity, read.data, saved => { if (saved) client.setQueryData(options.queryKey, saved); });
  const rows = useMemo(() => rewardPayouts((read.data?.pages ?? []).flatMap((page) => page.payouts), meta), [read.data, meta]);
  return {
    rows,
    errorMessage: publicErrorMessage(read.error, "Its rounds could not load. Try again."),
    status: read.isError && !read.data ? ("error" as const) : read.data ? ("ready" as const) : ("loading" as const),
    pageError: read.isFetchNextPageError,
    more: read.hasNextPage,
    loadingMore: read.isFetchingNextPage,
    loadMore: () => void read.fetchNextPage(),
    retry: () => void read.refetch(),
  };
}

/** The per-device record of the newest payout already announced, by account. */
export const REWARDS_SEEN_KEY = "blast.rwSeen";

type Seen = Record<string, number>;

function readSeen(): Seen {
  try {
    const raw = readBrowserStorage("local", REWARDS_SEEN_KEY);
    const value: unknown = raw === null ? {} : JSON.parse(raw);
    return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Seen) : {};
  } catch {
    return {};
  }
}

function writeSeen(seen: Seen): void {
  writeBrowserStorage("local", REWARDS_SEEN_KEY, JSON.stringify(seen));
}

/**
 * A payout older than this is never toasted. The "seen" mark lives in each
 * site's browser storage, so a site or device opened hours after a payout
 * would otherwise announce it again; the Rewards page still lists it.
 */
export const PAYOUT_TOAST_MAX_AGE_MS = 60 * 60_000;

/**
 * The payouts to announce: those newer than the last one this device saw for
 * the account and at most `PAYOUT_TOAST_MAX_AGE_MS` old, newest first, at
 * most three. The first read on a device only records where it is (nothing
 * that arrived before is announced).
 */
export function newPayouts(latest: readonly RewardPayoutView[], seenMs: number | undefined, nowMs: number): readonly RewardPayoutView[] {
  if (seenMs === undefined) return [];
  return latest.filter((payout) => payout.atMs > seenMs && nowMs - payout.atMs <= PAYOUT_TOAST_MAX_AGE_MS).slice(0, 3);
}

/**
 * A round paid out (the gate's `rwReceive`): a toast for each payout that
 * arrived since this device last read the account's rewards, with its
 * transaction on the viewer's explorer. No realtime path carries payouts,
 * so it is the next read that shows one (the page's own when it mounts, or
 * after a claim). Only a payout at most `PAYOUT_TOAST_MAX_AGE_MS` old toasts.
 */
export function usePayoutToasts(latest: readonly RewardPayoutView[] | null): void {
  const viewer = useSocialViewer();
  const toast = useToast();
  const { explorer } = useDevicePrefs();
  const account = viewer.signedIn ? viewer.callsign : null;
  const newest = latest?.reduce((max, payout) => Math.max(max, payout.atMs), 0) ?? 0;
  useEffect(() => {
    if (!latest || account === null) return;
    const seen = readSeen();
    const fresh = newPayouts(latest, seen[account], Date.now());
    for (const payout of [...fresh].reverse()) {
      const { title, sub } = payoutToast(payout);
      const href = explorerTransactionUrl(explorer, payout.digest) ?? undefined;
      toast(title, { sub, href, link: href ? `View on ${EXPLORER_NAMES[explorer]}` : undefined });
    }
    const cursor = Math.max(newest, seen[account] ?? 0);
    if (seen[account] !== cursor) writeSeen({ ...seen, [account]: cursor });
  }, [latest, newest, account, explorer, toast]);
}
