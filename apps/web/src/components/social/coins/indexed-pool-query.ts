import type { Query } from "@tanstack/react-query";
import type { MarketDataDependencies } from "@blast/core/modules/read-routing/market-data.ts";
import { browserMarketDependencies } from "#web/components/launchpad/blast-infra-browser.ts";
import { PublicError, responseError } from "#web/lib/errors.ts";
import { recheckFailed, retryDelay } from "#web/lib/query/client.ts";
import { pollInterval } from "#web/lib/query/polling.ts";

export async function readIndexedPool<T>(message: string, signal: AbortSignal, read: (market: MarketDataDependencies) => Promise<T>) {
  let refusal: PublicError | undefined;
  const market = browserMarketDependencies(null, async (url, init) => {
    signal.throwIfAborted();
    const timeout = init?.signal;
    // Older browsers still bound the fetch with the market client's deadline.
    const requestSignal = timeout && typeof AbortSignal.any === "function" ? AbortSignal.any([timeout, signal]) : timeout ?? signal;
    const response = await fetch(url, { ...init, cache: "default", signal: requestSignal });
    if (!response.ok) {
      refusal = responseError(await response.json().catch(() => null), response, message);
      throw refusal;
    }
    return response;
  });
  const result = await read(market);
  if (refusal) throw refusal;
  return result;
}

export function indexedPoolPolling(period: number) {
  return {
    staleTime: period,
    retryDelay: (attempt: number, error: Error) => Math.max(retryDelay(attempt), (error instanceof PublicError ? error.retryAfterSeconds ?? 0 : 0) * 1_000),
    refetchInterval: (query: Pick<Query, "state">) => {
      if (query.state.status !== "error") return pollInterval(period, query);
      const recheck = recheckFailed(query);
      return recheck === false ? false : Math.max(recheck, pollInterval(period, query));
    },
  };
}
