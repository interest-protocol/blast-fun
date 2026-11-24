"use client";

import { queryOptions, useQuery, type QueryClient } from "@tanstack/react-query";
import { isValidStructTag, normalizeStructTag } from "@mysten/sui/utils";
import { useEffect, useMemo } from "react";

import { useAppQueryClient } from "#web/lib/query/provider.tsx";
import { QueryTransientError, unwrapApiResult } from "#web/lib/query/client.ts";
import { queryKeys } from "#web/lib/query/keys.ts";
import { walletBalanceRevision } from "#web/lib/query/invalidate.ts";

import { fetchWalletBalance } from "./coins-client";
import { useSocialViewer } from "../SignInGate";
import type { SocialApiOptions } from "../social-api";

const BALANCE_STALE_MS = 5_000;
const NETWORK = "mainnet";

type Read = Readonly<{ atoms: bigint; asOfMs: number }>;

export type WalletCoinBalance =
  | Readonly<{ status: "loading" }>
  /** `retry` reads again; null when there is nothing to read (no wallet or session). */
  | Readonly<{ status: "unavailable"; retry: (() => void) | null }>
  | Readonly<{ status: "ready"; atoms: bigint }>;

export function walletCoinBalanceQuery(address: string, coinType: string, getAccessToken: SocialApiOptions["getAccessToken"]) {
  const canonicalType = isValidStructTag(coinType) ? normalizeStructTag(coinType) : "";
  return queryOptions({
    queryKey: queryKeys.me.walletBalance(NETWORK, address, canonicalType),
    queryFn: async ({ signal, queryKey, client }): Promise<Read> => {
      const once = async (): Promise<Read> => {
        const body = unwrapApiResult(await fetchWalletBalance({ getAccessToken, signal }, canonicalType));
        if (body.address !== address || body.coin_type !== canonicalType) {
          throw new QueryTransientError("The wallet or payment coin changed while its balance was read.");
        }
        return { atoms: BigInt(body.atoms), asOfMs: body.as_of_ms };
      };
      const invalidated = () => client.getQueryState(queryKey)?.isInvalidated === true;
      while (true) {
        const revision = walletBalanceRevision(client);
        const beganInvalidated = invalidated();
        const read = await once();
        // If a confirm overtook this read, its results may predate the confirm.
        if (revision !== walletBalanceRevision(client) || (!beganInvalidated && invalidated())) continue;
        const kept = client.getQueryData<Read>(queryKey);
        return kept && kept.asOfMs > read.asOfMs ? kept : read;
      }
    },
    staleTime: BALANCE_STALE_MS,
    gcTime: 0,
    refetchOnMount: true,
    refetchOnWindowFocus: true,
    retry: false,
  });
}

export async function refreshWalletCoinBalance(queries: QueryClient, address: string, coinType?: string): Promise<void> {
  const queryKey = queryKeys.me.walletBalance(NETWORK, address, coinType ? normalizeStructTag(coinType) : undefined);
  // A refusal can overtake an in-flight read even if the cache already has an invalidation.
  await queries.cancelQueries({ queryKey });
  await queries.invalidateQueries({ queryKey });
}

/** An on-demand read can be shared with a second step, such as a held press and its release. */
export function walletCoinBalanceReader(queries: QueryClient, getAccessToken: SocialApiOptions["getAccessToken"]) {
  return {
    async read(address: string, coinType: string) {
      const result = await queries.fetchQuery({ ...walletCoinBalanceQuery(address, coinType, getAccessToken), gcTime: BALANCE_STALE_MS });
      return result.atoms;
    },
    peek(address: string, coinType: string) {
      const { queryKey } = walletCoinBalanceQuery(address, coinType, getAccessToken);
      const state = queries.getQueryState<Read>(queryKey);
      if (state?.status !== "success" || state.isInvalidated || Date.now() - state.dataUpdatedAt >= BALANCE_STALE_MS) return null;
      return state.data?.atoms ?? null;
    },
  };
}

const noToken = async () => null;

/** Exact spendable inputs refresh on open, focus and confirmed wallet changes. `waiting` denotes a pending identity. */
export function useWalletCoinBalance(address: string | null | undefined, coinType: string, enabled: boolean, waiting = false): WalletCoinBalance {
  const { getAccessToken } = useSocialViewer();
  const client = useAppQueryClient();
  const wanted = enabled && !!address && isValidStructTag(coinType) && !!getAccessToken;
  const options = useMemo(() => walletCoinBalanceQuery(address ?? "", coinType, getAccessToken ?? noToken), [address, coinType, getAccessToken]);
  const query = useQuery({ ...options, enabled: wanted }, client);
  const queryKey = options.queryKey;
  // `visibilitychange` (the library's focus signal) misses a click back from a wallet popup or another window, which only fires `focus`.
  useEffect(() => {
    if (!wanted) return;
    const reread = () => {
      const read = client.getQueryState(queryKey);
      if (!read || Date.now() - read.dataUpdatedAt >= BALANCE_STALE_MS) void client.refetchQueries({ queryKey, type: "active" }, { cancelRefetch: false });
    };
    window.addEventListener("focus", reread);
    return () => window.removeEventListener("focus", reread);
  }, [wanted, client, queryKey]);
  if (!wanted) return enabled && waiting ? { status: "loading" } : { status: "unavailable", retry: null };
  // A balance that could not be verified on the latest read is not shown as a fact, whatever an older read said.
  if (query.isError) return { status: "unavailable", retry: () => void query.refetch() };
  // While a read of an invalidated or out-of-date entry is on its way, the old number is not a fact either.
  const stale = client.getQueryState(queryKey)?.isInvalidated || (query.isFetching && query.isStale);
  return query.data && !stale ? { status: "ready", atoms: query.data.atoms } : { status: "loading" };
}
