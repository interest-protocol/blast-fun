"use client";

import { useQuery } from "@tanstack/react-query";
import { pollInterval } from "#web/lib/query/polling.ts";
import { useAppQueryClient } from "#web/lib/query/provider.tsx";
import { HEALTH_POLL_MS, HEALTH_STALE_MS, serviceHealthSchema, type ServiceHealth } from "#web/modules/service-health/contracts.ts";

// One poll for the shell's status and every page that asks whether lists are late.
/** A health answer that was not OK; a 4xx means the route is off or gated, not that the backend is down. */
class HealthReadError extends Error {
  readonly status: number;

  constructor(status: number) {
    super("Health check unavailable.");
    this.status = status;
  }
}

export function useHealthRead() {
  return useQuery({
    queryKey: ["service-health"],
    async queryFn({ signal }) {
      const response = await fetch("/api/social/health", {
        cache: "no-store", signal: AbortSignal.any([signal, AbortSignal.timeout(5_000)]),
      });
      if (!response.ok) throw new HealthReadError(response.status);
      return serviceHealthSchema.parse(await response.json());
    },
    staleTime: HEALTH_STALE_MS,
    refetchInterval: (query) => pollInterval(HEALTH_POLL_MS, query),
    refetchOnWindowFocus: "always",
    networkMode: "always",
    retry: false,
  }, useAppQueryClient());
}

/**
 * True while the backend that serves lists is degraded or down: a fresh health read says so,
 * or, with no fresh read, the relay cannot reach it (5xx, timeout). One failed poll after a fresh
 * healthy read, an offline browser or an answer that does not parse is not "late".
 * Only lists with no rows give way to the page-level line.
 */
export function useListsLate(): boolean {
  const health = useHealthRead();
  // A stale answer still counts while its refetch is in flight, so lists do not flash their own empty states.
  if (health.data && (!health.isStale || health.isFetching)) return health.data.backend !== "healthy";
  const error = health.error;
  if (error instanceof HealthReadError) return error.status >= 500;
  return error instanceof DOMException && error.name === "TimeoutError";
}

// One line on what a person will notice, instead of the raw connection words.
export function impactLine(backend: ServiceHealth["backend"] | null, sui: ServiceHealth["sui"]["status"] | null): string | null {
  const lists = backend !== null && backend !== "healthy";
  const chain = sui !== null && sui !== "healthy";
  if (lists && chain) return "Coin lists may be late or empty, and trades may confirm slowly.";
  if (lists) return "Coin lists may be late or empty. Your balances are safe.";
  if (chain) return "Trades and balances may update slowly.";
  return null;
}
