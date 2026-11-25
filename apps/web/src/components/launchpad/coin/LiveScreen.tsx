"use client";

import { createContext, use, type ReactNode } from "react";

const LiveScreenContext = createContext(false);

/**
 * Turns on the coin page's live screen (`BLAST_LIVE_SCREEN_ENABLED`): the page loads once, then its
 * numbers and lists follow the tab's market stream, with timed reads only while the stream is not live.
 */
export function LiveScreen({ enabled, children }: Readonly<{ enabled: boolean; children: ReactNode }>) {
  return <LiveScreenContext value={enabled}>{children}</LiveScreenContext>;
}

export function useLiveScreen(): boolean {
  return use(LiveScreenContext);
}
