"use client";

import { useInfiniteQuery } from "@tanstack/react-query";
import type {
  CreatorEarning,
  CreatorVesting,
} from "@blast/core/web/contracts/creator-earnings.ts";
import { publicErrorMessage } from "#web/lib/errors.ts";
import { unwrapApiResult } from "#web/lib/query/client.ts";
import { useAppQueryClient } from "#web/lib/query/provider.tsx";
import { queryKeys } from "#web/lib/query/keys.ts";
import { useSocialViewer } from "../SignInGate";
import { fetchCreatorEarnings } from "./creator-earnings-client";

const noToken = async () => null;

export type CreatorEarningsRead = Readonly<{
  status: "off" | "loading" | "ready" | "error";
  earnings: readonly CreatorEarning[];
  vestings: readonly CreatorVesting[];
  error: string;
  retry: () => void;
  more: boolean;
  loadingMore: boolean;
  refreshing: boolean;
  refreshFailed: boolean;
  loadMore: () => void;
}>;

export function useCreatorEarnings(enabled: boolean): CreatorEarningsRead {
  const viewer = useSocialViewer();
  const client = useAppQueryClient();
  const read = useInfiniteQuery(
    {
      queryKey: queryKeys.me.creatorEarnings(),
      initialPageParam: null as string | null,
      queryFn: async ({ pageParam, signal }) =>
        unwrapApiResult(
          await fetchCreatorEarnings(
            { getAccessToken: viewer.getAccessToken ?? noToken, signal },
            pageParam,
          ),
        ),
      getNextPageParam: (page) => page.next_cursor ?? undefined,
      enabled: enabled && viewer.signedIn,
      staleTime: 30_000,
    },
    client,
  );
  return {
    status: !enabled
      ? ("off" as const)
      : read.isError && !read.data
        ? ("error" as const)
        : read.data
          ? ("ready" as const)
          : ("loading" as const),
    earnings: read.data?.pages.flatMap((page) => page.earnings) ?? [],
    vestings: read.data?.pages[0]?.vestings ?? [],
    error: publicErrorMessage(read.error, "Creator earnings could not load. Try again."),
    retry: () => void read.refetch(),
    more: read.hasNextPage,
    loadingMore: read.isFetchingNextPage,
    refreshing: read.isRefetching,
    refreshFailed: read.isRefetchError,
    loadMore: () => void read.fetchNextPage(),
  };
}
