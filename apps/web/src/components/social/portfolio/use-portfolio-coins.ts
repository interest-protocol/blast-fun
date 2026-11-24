"use client";

import { useDebouncedValue } from "#web/lib/use-debounced-value.ts";
import { pollInterval } from "#web/lib/query/polling.ts";
import { isPortfolioCoinsFilter } from "#web/lib/query/keys.ts";
import { useQuery } from "@tanstack/react-query";
import { PORTFOLIO_COINS_PAGE_SIZE } from "@blast/core/web/contracts/portfolio.ts";
import { useAppQueryClient } from "#web/lib/query/provider.tsx";
import type { AccessTokenSource } from "../viewer-state-client";
import { portfolioCoinsQuery } from "../queries";
import { useShellPrefs, setShellPref } from "#web/components/blast-ui/use-shell-prefs.ts";
import { pageCoins } from "./portfolio-model";
import { usePortfolioState } from "./use-portfolio-state";

export function usePortfolioCoins(getAccessToken: AccessTokenSource, enabled: boolean) {
  const { hideSmallBalances } = useShellPrefs();
  const client = useAppQueryClient();
  const [controls, setControls] = usePortfolioState("coins", { search: "", page: 1 });
  const { search, page } = controls;
  const setPage = (page: number) => setControls(current => ({ ...current, page }));
  const term = useDebouncedValue(search, 200).trim();
  const read = useQuery({
    ...portfolioCoinsQuery(getAccessToken, page, term, hideSmallBalances),
    enabled: enabled && search.trim() === term,
    refetchInterval: (query) => pollInterval(60_000, query),
    placeholderData: (previous, previousQuery) => previousQuery && isPortfolioCoinsFilter(previousQuery.queryKey, term, hideSmallBalances) ? previous : undefined,
  }, client);
  const waiting = search.trim() !== term || read.isPending || read.isPlaceholderData;
  return {
    coins: waiting ? [] : pageCoins(read.data),
    controls: {
      search,
      hideSmall: hideSmallBalances,
      onHideSmall: (value: boolean) => { setPage(1); setShellPref("hideSmallBalances", value); },
      page: waiting ? page : read.data?.page ?? page,
      total: read.data?.total ?? 0,
      walletHasCoins: read.data?.wallet_has_coins,
      pageSize: PORTFOLIO_COINS_PAGE_SIZE,
      loading: waiting,
      failed: read.isError,
      onSearch: (search: string) => setControls({ search, page: 1 }),
      onPage: setPage,
      retry: () => { void read.refetch(); },
    },
  };
}
