"use client";

import { publicErrorMessage } from "#web/lib/errors.ts";

import { useQuery, type QueryClient, type QueryKey, type UseQueryOptions, type UseQueryResult } from "@tanstack/react-query";

/**
 * Server-rendered data as a query's first answer (OA-38: RSC stays the first
 * paint, and nothing refetches on hydration). The server component hands its
 * read down as props, as before; it becomes the query's `initialData` as of
 * `updatedAt` (the render), so the server HTML and hydration render it with no
 * request, and the read refetches only once it is stale, like any other.
 * When the cache already holds an answer for the key (a client navigation back
 * to the page), that answer stands.
 */
export function useSeededQuery<TData, TKey extends QueryKey>(
  options: UseQueryOptions<TData, Error, TData, TKey>,
  seed: TData | null | undefined,
  updatedAt: number,
  client: QueryClient,
): UseQueryResult<TData, Error> {
  return useQuery(
    seed === null || seed === undefined ? options : { ...options, initialData: seed as never, initialDataUpdatedAt: updatedAt },
    client,
  ) as UseQueryResult<TData, Error>;
}

/** A read as the app's components have always taken it: loading, ready, error, or none (not asked for). */
export type Loadable<T> = Readonly<{ status: "loading" }> | Readonly<{ status: "ready"; value: T }> | Readonly<{ status: "error"; message?: string }> | Readonly<{ status: "none" }>;

/**
 * A query as a `Loadable`: `none` while not enabled; the answer while there is
 * one and the last read did not fail (a refetch keeps it showing); `error`
 * once a read failed and none is running; `loading` otherwise (the first
 * read, or a retry after a failure).
 */
export function loadableOf<T>(query: Pick<UseQueryResult<T, Error>, "data" | "isError" | "isFetching"> & Partial<Pick<UseQueryResult<T, Error>, "error">>, enabled: boolean): Loadable<T> {
  if (!enabled) return { status: "none" };
  if (query.data !== undefined && !query.isError) return { status: "ready", value: query.data };
  if (query.isError && !query.isFetching) return { status: "error", message: publicErrorMessage(query.error, "This read could not load. Try again.") };
  return { status: "loading" };
}
