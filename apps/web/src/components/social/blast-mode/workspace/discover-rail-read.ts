"use client";

import { queryKeys } from "#web/lib/query/keys.ts";
import { useQuery, type QueryFunction, type QueryFunctionContext, type SkipToken } from "@tanstack/react-query";
import type { HomeCoinsPage } from "@blast/core/web/contracts/home.ts";
import { useAppQueryClient } from "#web/lib/query/provider.tsx";
import { discoverQuery } from "../../coin-home/home-client";
import type { HomeViewState } from "../../coin-home/home-state";
import { workspaceDiscoverQuery } from "./coin-row-model";
import { useWorkspace } from "./workspace-context";

function railRead<Data, Key extends readonly unknown[]>(options: { queryKey: Key; queryFn?: QueryFunction<Data, Key> | SkipToken }) {
  const read = options.queryFn;
  if (typeof read !== "function") throw new Error("The rail requires an existing Home read.");
  return (context: QueryFunctionContext) => read({ ...context, queryKey: options.queryKey });
}

/**
 * The Coins view's discover read for the collapsed rail (audit 04): Discover's own query and
 * cache key (CoinsData's `workspace-coins`), so the rail's shortcuts appear on re-entry and
 * reload without mounting the list, and opening Discover reuses the result.
 */
export function useDiscoverRailCoins(enabled: boolean) {
  const { snapshot } = useWorkspace();
  const client = useAppQueryClient();
  const controls = snapshot.data.controls.Coins;
  const state: HomeViewState = { ...controls, minParticipants: controls.min_participants };
  const options = discoverQuery(workspaceDiscoverQuery(state, controls.rows));
  return useQuery<HomeCoinsPage>(
    {
      enabled: enabled && controls.source === "discover",
      retry: options.retry,
      retryDelay: options.retryDelay,
      gcTime: options.gcTime,
      structuralSharing: options.structuralSharing,
      queryKey: queryKeys.workspace.coins(options.queryKey),
      queryFn: railRead(options),
      staleTime: 30_000,
    },
    client,
  );
}
