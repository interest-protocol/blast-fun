import type { QueryClient } from "@tanstack/react-query";

import { apiResultOfError } from "#web/lib/query/client.ts";
import { queryKeys } from "#web/lib/query/keys.ts";
import type { SocialWatchlistKeys } from "@blast/core/web/contracts/watchlist.ts";

import { watchlistCardQuery, watchlistKeysQuery } from "../queries";
import { setWatched } from "./watchlist-client";
import type { WatchlistCalls } from "./watchlist-store";

/**
 * The store's calls over the page's server-state cache (OA-38): the stars are
 * the shared keys query (Blast mode's lanes read the same entry), the card's
 * rows its own query, read fresh each time the store asks. A star written
 * updates the shared keys in place (a new one leads) and makes the
 * watchlist's pages stale.
 */
export function cachedWatchlistCalls(client: QueryClient): WatchlistCalls {
  const ok = <Body,>(body: Body) => ({ status: "ok", body, httpStatus: 200 }) as const;
  return {
    keys: (options) => client.fetchQuery(watchlistKeysQuery(options.getAccessToken)).then(ok, apiResultOfError),
    page: (options, limit) => client.fetchQuery({ ...watchlistCardQuery(options.getAccessToken, limit), staleTime: 0 }).then(ok, apiResultOfError),
    set: async (options, presaleId, on) => {
      const result = await setWatched(options, presaleId, on);
      if (result.status === "ok") {
        await client.cancelQueries({ queryKey: queryKeys.me.watchlist.keys() });
        client.setQueryData<SocialWatchlistKeys>(queryKeys.me.watchlist.keys(), (held) => {
          if (!held) return held;
          const others = held.keys.filter((key) => key !== presaleId);
          return { keys: on ? [presaleId, ...others] : others };
        });
        void client.invalidateQueries({ queryKey: queryKeys.me.watchlist.pages }, { cancelRefetch: false });
      }
      return result;
    },
  };
}
