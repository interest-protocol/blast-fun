import { pollInterval } from "#web/lib/query/polling.ts";
import { useQuery, type QueryKey } from "@tanstack/react-query";
import { useCallback, useEffect, useEffectEvent, useMemo, useRef, useState } from "react";
import { useBalancesVersion } from "#web/components/social/coins/balances.tsx";
import { FAILED_RECHECK_MS } from "#web/lib/query/client.ts";
import { queryKeys } from "#web/lib/query/keys.ts";
import { useAppQueryClient } from "#web/lib/query/provider.tsx";
import { POLL_MS } from "#web/components/launchpad/blast-infra-browser.ts";
import { useWorkspaceLiveClock } from "../live-clock";
import { startWorkspaceLiveRead, type WorkspaceLiveResult } from "../live-read";

/** How often a focused coin's reads poll while the tab's market stream is live for its pool: the stream moves them in between. */
export const LIVE_POLL_MS = 30_000;

/** A coin read's poll: 30 s while the market stream is live for the coin's pool, 15 s otherwise. */
export function coinPollMs(live: boolean): number {
  return live ? LIVE_POLL_MS : POLL_MS;
}

export function useCoinRead<T>(
  active: boolean,
  key: string,
  read: (signal: AbortSignal) => Promise<T>,
  onSuccess?: (value: T) => void,
  intervalMs: number | null | ((answer: WorkspaceLiveResult<T>) => number | null) = POLL_MS,
) {
  const clock = useWorkspaceLiveClock();
  const received = useEffectEvent((value: T) => onSuccess?.(value));
  const [attempt, setAttempt] = useState(0);
  // A refresh reads again at once and keeps the shown answer, unlike `retry`.
  const [refreshes, setRefreshes] = useState(0);
  const refresh = useCallback(() => setRefreshes((value) => value + 1), []);
  // Each presentation needs its own answer, even when the asset and draft are unchanged.
  const lifetime = useMemo(() => ({ active, key, read, attempt, clock }), [active, key, read, attempt, clock]);
  const [result, setResult] = useState<(WorkspaceLiveResult<T> & Readonly<{ lifetime: object; checkedAt: number | null }>) | null>(null);
  // A new interval only changes the next wait: a stream going live or dropping must not read every tab at once.
  const interval = useRef(intervalMs);
  useEffect(() => {
    interval.current = intervalMs;
  }, [intervalMs]);
  useEffect(() => {
    if (!active) return;
    return startWorkspaceLiveRead({
      clock,
      intervalMs: (answer) => (typeof interval.current === "function" ? interval.current(answer) : interval.current),
      read,
      receive: (answer) => {
        setResult({ ...answer, lifetime, checkedAt: answer.status === "ready" ? clock.now() : null });
        if (answer.status === "ready") received(answer.value);
      },
    });
  }, [active, clock, lifetime, read, refreshes]);
  const current =
    active && result?.lifetime === lifetime ? result : null;
  return {
    status: current?.status ?? ("pending" as const),
    value: current?.value ?? null,
    checkedAt: current?.checkedAt ?? null,
    unavailable: current?.status === "error" && current.unavailable === true,
    retry: () => setAttempt((value) => value + 1),
    refresh,
  };
}

/** One coin's PnL; the portfolio read behind it is shared (`coin-pnl.ts`). */
export const coinPanelPnlKey = (actorKey: string, network: string, coinType: string) =>
  [...queryKeys.me.portfolio(), "coin-panel", actorKey, network, coinType] as const;

/** How often a coin panel rereads the viewer's wallet and PnL with nothing else to prompt it. */
export const ACCOUNT_POLL_MS = 60_000;

/** How long the PnL read waits before asking again: sooner after a failure. */
export function accountReadInterval(state: Readonly<{ status: string }>): number {
  return state.status === "error" ? FAILED_RECHECK_MS : ACCOUNT_POLL_MS;
}

/** How long a coin panel's wallet read waits: sooner while it has nothing to show (a failed read answers `null`). */
export function walletReadInterval(answer: WorkspaceLiveResult<unknown>): number {
  return answer.status === "ready" && answer.value !== null ? ACCOUNT_POLL_MS : FAILED_RECHECK_MS;
}

/**
 * The viewer's wallet in a coin panel. Each presentation waits for its own
 * answer, as every panel read does. It reads again each minute, and at once
 * when the shell's balances move (the viewer's own trade, deposit or
 * withdrawal), which also marks the shared `/me/wallet` entry stale so that
 * read skips the server's balance cache. `read` must be stable.
 */
export function useCoinWalletRead<T>(active: boolean, key: string, read: () => Promise<T | null>) {
  const balances = useBalancesVersion();
  return useCoinRead(active, `${key}:${balances}`, read, undefined, walletReadInterval);
}

/**
 * A viewer read every coin panel shares (the PnL): one React Query entry under
 * `queryKey`, read again each minute. Keep `queryKey` under `me.portfolio()`,
 * so the viewer's own trade, which invalidates that prefix, reads it again at
 * once. A failed read asks again after `FAILED_RECHECK_MS`, so the panel
 * recovers without a reload.
 */
export function useAccountCoinRead<T>(active: boolean, queryKey: QueryKey, read: () => Promise<T>) {
  const query = useQuery(
    {
      queryKey,
      queryFn: read,
      enabled: active,
      staleTime: ACCOUNT_POLL_MS,
      refetchInterval: (query) => pollInterval(accountReadInterval(query.state), query),
      retry: false,
    },
    useAppQueryClient(),
  );
  const status = !active || query.isPending ? ("pending" as const) : query.isError ? ("error" as const) : ("ready" as const);
  return {
    status,
    value: status === "ready" ? (query.data ?? null) : null,
    checkedAt: status === "ready" ? query.dataUpdatedAt : null,
    unavailable: false,
    retry: () => void query.refetch(),
  };
}
