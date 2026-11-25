"use client";

import { createContext, use, useEffect, useMemo, useState, type ReactNode } from "react";

type LiveScreenValue = Readonly<{ enabled: boolean; listening: boolean; setListening: (listening: boolean) => void }>;

const LiveScreenContext = createContext<LiveScreenValue>({ enabled: false, listening: false, setListening: () => {} });

/**
 * Turns on the coin page's live screen (`BLAST_LIVE_SCREEN_ENABLED`): the page loads once, then its
 * numbers and lists follow the tab's market stream, with timed reads only while the stream is not listening.
 */
export function LiveScreen({ enabled, children }: Readonly<{ enabled: boolean; children: ReactNode }>) {
  const [listening, setListening] = useState(false);
  const value = useMemo(() => ({ enabled, listening: enabled && listening, setListening }), [enabled, listening]);
  return <LiveScreenContext value={value}>{children}</LiveScreenContext>;
}

/** Whether the live screen is on for this page. */
export function useLiveScreen(): boolean {
  return use(LiveScreenContext).enabled;
}

/**
 * Whether the screen's stream is live and carrying the coin's stats, so timed page and market
 * reads can rest. False whenever the stream drops, so those reads resume on their own.
 */
export function useLiveListening(): boolean {
  return use(LiveScreenContext).listening;
}

/** Reports whether this screen's stream is listening (see `useLiveListening`). */
export function useReportListening(listening: boolean): void {
  const { setListening } = use(LiveScreenContext);
  useEffect(() => {
    setListening(listening);
    return () => setListening(false);
  }, [listening, setListening]);
}
