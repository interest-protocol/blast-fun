import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import { createElement, type ReactNode } from "react";

import { makeQueryClient } from "./client";

/**
 * A client for tests (OA-38): no retries and no garbage-collection delay, so a
 * failure surfaces at once and nothing outlives the test. Everything else is
 * the app's defaults (`staleTime`, no refetch on focus), so a test sees the
 * same dedupe and freshness the app does. Override per test, e.g.
 * `createTestQueryClient({ queries: { retry: 2, retryDelay: 0 } })` to drive
 * the retry path.
 */
export function createTestQueryClient(
  overrides: Readonly<{ queries?: Record<string, unknown>; mutations?: Record<string, unknown> }> = {},
): QueryClient {
  return makeQueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0, ...overrides.queries },
      mutations: { retry: false, ...overrides.mutations },
    },
  });
}

/** `children` under `client` (a test's `QueryProvider`), without JSX so plain `.ts` tests can use it. */
export function withQueryClient(client: QueryClient, children: ReactNode) {
  return createElement(QueryClientProvider, { client }, children);
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * Waits until no query or mutation of `client` is fetching, and the
 * observers have heard of it (TanStack Query tells them on a later macrotask):
 * a test's "settle".
 */
export async function settleQueries(client: QueryClient, timeoutMs = 2_000): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  for (let idle = 0; idle < 3; ) {
    await tick();
    idle = client.isFetching() === 0 && client.isMutating() === 0 ? idle + 1 : 0;
    if (performance.now() > deadline) throw new Error("Queries did not settle.");
  }
}
