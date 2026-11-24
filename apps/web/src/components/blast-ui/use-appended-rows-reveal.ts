"use client";

import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { instantFeedback } from "./feedback-motion";
import { EASE_OUT, staggerDelay } from "./motion-tokens";

/** Report the received page before merging it into the displayed list. */
export type LoadMoreRows = (received: (ids: readonly string[]) => void) => void | Promise<unknown>;

/** Only a manual page response can reveal rows; cache and refresh renders cannot. */
export function useAppendedRowsReveal(ids: readonly string[], loadMore: LoadMoreRows | undefined) {
  const list = useRef<HTMLDivElement | null>(null);
  const request = useRef(0);
  const busy = useRef(false);
  const pending = useRef(new Set<string>());
  const animations = useRef<Animation[]>([]);
  const [requested, setRequested] = useState(false);
  const [response, setResponse] = useState(0);
  const listRef = useCallback((node: HTMLDivElement | null) => { list.current = node; }, []);
  useLayoutEffect(() => () => {
    request.current++;
    animations.current.forEach(animation => animation.cancel());
  }, []);
  useLayoutEffect(() => {
    // Observer notification may commit later than the page response. Consume once.
    // The page's rows fade in one after another (staggered), each clickable from the start.
    let index = 0;
    for (const row of list.current?.querySelectorAll<HTMLElement>("[data-row-id]") ?? []) {
      if (pending.current.delete(row.dataset.rowId!) && !instantFeedback() && row.animate) {
        animations.current.push(row.animate([{ opacity: 0 }, { opacity: 1 }], {
          duration: 140,
          delay: staggerDelay(index++),
          easing: EASE_OUT,
          fill: "backwards",
        }));
      }
    }
  }, [ids, response]);

  async function more() {
    if (!loadMore || busy.current) return;
    busy.current = true;
    setRequested(true);
    const generation = ++request.current;
    pending.current.clear();
    animations.current.forEach(animation => animation.cancel());
    animations.current = [];
    const immediate = instantFeedback();
    const received = (loaded: readonly string[]) => {
      if (generation !== request.current || immediate) return;
      const existing = new Set(Array.from(list.current?.querySelectorAll<HTMLElement>("[data-row-id]") ?? [], row => row.dataset.rowId));
      pending.current = new Set(loaded.filter(id => !existing.has(id)));
      setResponse(generation);
    };
    // The loader owns its error/retry UI; failures have no rows to reveal.
    await Promise.resolve().then(() => loadMore(received)).catch(() => undefined);
    busy.current = false;
  }

  return { listRef, more, requested };
}
