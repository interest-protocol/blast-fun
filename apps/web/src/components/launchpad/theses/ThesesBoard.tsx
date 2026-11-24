"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";

import { readTheses } from "./theses-client";
import { afterMore, afterRead, INITIAL_THESES, moreFocusIndex } from "./theses-model";
import { ThesesView } from "./ThesesView";

/**
 * A launch's Theses in the browser: the public list, read from the web app
 * on open, on request and after the author's own post (social records come
 * from the primary, so a new or hidden post shows at once), then the post
 * form `composer` renders, which calls `onPublished` after a post is stored.
 */
export function ThesesBoard({
  launchId,
  symbol,
  composer,
}: Readonly<{
  launchId: string;
  symbol: string | null;
  composer: (onPublished: () => void) => ReactNode;
}>) {
  const [state, setState] = useState(INITIAL_THESES);
  // Each bump re-reads the first page.
  const [reads, setReads] = useState(0);
  // The latest first-page read; an older answer, or a page of the list it replaced, is dropped.
  const generation = useRef(0);

  useEffect(() => {
    const mine = ++generation.current;
    void readTheses(launchId, null).then((answer) => {
      if (mine === generation.current) setState((current) => afterRead(current, answer));
    });
  }, [launchId, reads]);

  const reread = () => setReads((count) => count + 1);

  // After Show more, focus goes to the first new post (or the last, when the button went away), unless the reader moved it.
  const list = useRef<HTMLDivElement>(null);
  const focusAfterMore = useRef<{ before: number; from: Element | null } | null>(null);
  useEffect(() => {
    const pending = focusAfterMore.current;
    if (!pending || state.loadingMore) return;
    focusAfterMore.current = null;
    const focusLost = document.activeElement === document.body;
    if (document.activeElement !== pending.from && !focusLost) return;
    const posts = [...(list.current?.querySelectorAll<HTMLElement>("article") ?? [])];
    const index = moreFocusIndex(pending.before, posts.length, focusLost);
    if (index !== null) posts[index]?.focus();
  }, [state]);

  const more = async () => {
    const section = state.section;
    const cursor = section.status === "ready" || section.status === "stale" ? section.value.nextCursor : null;
    if (!cursor) return;
    const mine = generation.current;
    focusAfterMore.current = { before: section.status === "ready" || section.status === "stale" ? section.value.items.length : 0, from: document.activeElement };
    setState((current) => ({ ...current, loadingMore: true, moreError: null }));
    const answer = await readTheses(launchId, cursor);
    setState((current) => (mine === generation.current ? afterMore(current, answer) : { ...current, loadingMore: false }));
  };

  return (
    <>
      <div ref={list}>
        <ThesesView state={state} symbol={symbol} onMore={() => void more()} onRetry={reread} />
      </div>
      {composer(reread)}
    </>
  );
}
