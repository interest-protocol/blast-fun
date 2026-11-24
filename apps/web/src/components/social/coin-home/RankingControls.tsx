"use client";

import { type RankingHandle, type RankingsStore, RankingsSlot } from "./rankings-store.ts";

import { useContext, useLayoutEffect, useRef, useSyncExternalStore } from "react";

import { countWords } from "@blast/core/web/format.ts";
import { Button } from "#web/components/blast-ui/Button.tsx";

import styles from "./CoinHome.module.css";
import type { Rankings } from "./use-rankings";

/** Newest retains its explicit admission button while other rankings follow the stream. */
export function RankingControls({ rankings }: Readonly<{ rankings: RankingHandle }>) {
  if (!rankings.incoming) return null;
  return <div className={styles.rankingControls}>
    <Button size="sm" data-incoming="" disabled={!rankings.pending} onClick={event => {
      if (event.detail === 0) {
        const section = event.currentTarget.closest('[data-section="coins"]');
        section?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')?.focus({ preventScroll: true });
      }
      rankings.update(event.detail);
    }}>Show {countWords(rankings.incoming, "new coin", "new coins")}</Button>
  </div>;
}

/** Publish pending admissions to the Home header, or draw them beside a standalone list. */
export function useRankingsSlot(rankings: Rankings | undefined): boolean {
  const store = useContext(RankingsSlot);
  const latest = useRef(rankings);
  useLayoutEffect(() => { latest.current = rankings; });
  const listed = rankings !== undefined;
  const pending = rankings?.pending ?? false;
  const incoming = rankings?.incoming ?? 0;
  useLayoutEffect(() => {
    if (!store || !listed) return undefined;
    return () => store.set(null);
  }, [store, listed]);
  useLayoutEffect(() => {
    if (store && listed) store.set({ pending, incoming, update: (detail) => latest.current?.update(detail) });
  }, [store, listed, pending, incoming]);
  return store !== null;
}

export function HeaderRankingControls({ store }: Readonly<{ store: RankingsStore }>) {
  const handle = useSyncExternalStore(store.subscribe, store.get, () => null);
  return handle ? <RankingControls rankings={handle} /> : null;
}
