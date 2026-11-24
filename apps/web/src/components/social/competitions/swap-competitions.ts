"use client";

import { pollInterval } from "#web/lib/query/polling.ts";
import { queryKeys } from "#web/lib/query/keys.ts";
import { useQuery } from "@tanstack/react-query";
import { gatedFetch } from "#web/lib/api-gate-client.ts";
import { responseError } from "#web/lib/errors.ts";
import { useAppQueryClient } from "#web/lib/query/provider.tsx";
import { socialCompetitionsPath, type Competition, type SwapCompetitions } from "@blast/core/modules/social/competitions/contracts.ts";
import { useCommitClock } from "../commit/commit-clock.ts";
import type { WalletCoinView } from "../coins/coin-model.ts";
import { canTrade, tradableCoinView } from "../coins/swap-model.ts";

type TimedCompetitions = SwapCompetitions & Readonly<{ request_started_at_ms: number }>;

/** Server-relative time also works when the visitor's clock is ahead or behind. */
export function liveSwapCompetitions(
  data: TimedCompetitions | undefined,
  clockMs: number,
): readonly Competition[] {
  if (!data || clockMs === 0) return [];
  const now = data.as_of_ms + Math.max(0, clockMs - data.request_started_at_ms);
  return data.competitions.filter(
    (event) => event.feature_on_swap && event.starts_at_ms <= now && now < event.ends_at_ms,
  );
}

export function useSwapCompetitions(enabled: boolean, knownCoins: readonly WalletCoinView[]) {
  const client = useAppQueryClient();
  const clockMs = useCommitClock();
  const query = useQuery(
    {
      queryKey: queryKeys.competitions.swap(),
      queryFn: async ({ signal }): Promise<TimedCompetitions> => {
        const request_started_at_ms = Date.now();
        const response = await gatedFetch(socialCompetitionsPath({ placement: "swap" }), {
          signal,
          credentials: "same-origin",
          cache: "no-store",
        });
        if (!response.ok) throw responseError(await response.json().catch(() => null), response);
        const body: SwapCompetitions = await response.json();
        return { ...body, request_started_at_ms };
      },
      enabled,
      staleTime: 0,
      refetchOnWindowFocus: "always",
      refetchInterval: (query) => {
        const data = query.state.data;
        if (!data?.next_change_at_ms) return pollInterval(30_000, query);
        const now = data.as_of_ms + Math.max(0, Date.now() - data.request_started_at_ms);
        return Math.max(1_000, Math.min(pollInterval(30_000, query), data.next_change_at_ms - now));
      },
      retry: false,
    },
    client,
  );
  // Failed promotional reads never interrupt the normal swap or retain stale badges.
  const competitions = enabled && !query.isError ? liveSwapCompetitions(query.data, clockMs) : [];
  const resolved = query.data?.coins ?? [];
  const coins = competitions.flatMap((event) => {
    const known = knownCoins.find((coin) => coin.coinType === event.coin_type && canTrade(coin));
    const metadata = resolved.find((coin) => coin.coin_type === event.coin_type);
    const coin = known ?? (metadata ? tradableCoinView(metadata) : null);
    return coin ? [{ ...coin, iconUrl: event.coin_icon_url ?? coin.iconUrl }] : [];
  });
  return { competitions, coins };
}
