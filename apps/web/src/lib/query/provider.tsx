"use client";

import { QueryClientContext, QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import { useContext, type ReactNode } from "react";

import { getQueryClient } from "./client";

/**
 * The server-state cache for a Blast UI page (OA-38), mounted once by
 * `BlastUiRoot`: the browser session's one `QueryClient`, or a fresh one per
 * server render. React Query renders no element and injects no style, so it
 * adds nothing the CSP has to allow. `client` is for tests and fixtures.
 */
export function QueryProvider({ client, children }: Readonly<{ client?: QueryClient; children: ReactNode }>) {
  return <QueryClientProvider client={client ?? getQueryClient()}>{children}</QueryClientProvider>;
}

/**
 * The client the nearest `QueryProvider` holds, or the session's own when a
 * component renders outside one (a fixture or a test that renders it bare), so
 * a migrated hook keeps working wherever its component did.
 */
export function useAppQueryClient(): QueryClient {
  return useContext(QueryClientContext) ?? getQueryClient();
}
