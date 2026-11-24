"use client";

import { useEffect, useRef } from "react";

import { useFeel } from "./FeelProvider.tsx";

/**
 * The `open` / `close` cue for a surface that opens and closes — a sheet, a
 * dialog, Blast mode's side panel (R3-12). It answers the change of `open`,
 * never the first render, and only as a **fresh** cue: within a second of the
 * reader's own press or key (`feel-gate.ts`). So a sheet the reader opened
 * glides open, and one that opens on its own — the celebration, from a live
 * read — stays silent, as does a close that follows a long wallet signature.
 * A surface mounted already open counts as opening.
 */
export function useFeelOpenClose(open: boolean): void {
  const { play } = useFeel();
  const previous = useRef(false);
  useEffect(() => {
    if (previous.current === open) return;
    previous.current = open;
    play({ kind: open ? "open" : "close" }, { fresh: true });
  }, [open, play]);
}
