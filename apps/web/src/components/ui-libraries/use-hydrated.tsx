"use client";

import { useSyncExternalStore, type ReactNode } from "react";

const noSubscription = () => () => undefined;

/**
 * False on the server and while React hydrates the server's HTML; true once
 * the page is the browser's (and at once for a tree mounted on the client).
 *
 * The site's CSP drops every `style="…"` the server writes, and hydration
 * never writes it again: a library whose markup carries inline styles
 * (react-virtuoso, motion's `initial`)
 * must not reach the server's HTML. Rendering it only once this is true
 * makes React create those nodes in the browser, where it sets each style
 * through the CSSOM, which the policy allows.
 */
export function useHydrated(): boolean {
  return useSyncExternalStore(noSubscription, () => true, () => false);
}

/** Renders `children` only after hydration (see `useHydrated`), `fallback` before. */
export function ClientOnly({ children, fallback = null }: Readonly<{ children: ReactNode; fallback?: ReactNode }>) {
  return useHydrated() ? children : fallback;
}
