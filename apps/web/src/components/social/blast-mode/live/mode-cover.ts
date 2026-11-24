import { createStore } from "zustand/vanilla";

/**
 * Whether Blast mode covers the page (R3-60, §22.1 defect 22).
 *
 * In the gate the page's own loops — the 1 Hz countdowns, the 30 s post
 * timestamps, the 1 s relative times — keep running under Blast mode, and a
 * global countdown interval even writes into the mode's own elements. The
 * product's mode owns its loops; the page's loops that
 * only redraw time pause while the mode covers the page, so nothing under it
 * is redrawn every second for nobody, and each catches up once when the mode
 * leaves. Data reads are not paused: they are not redraws, and Home's live
 * reads still feed the page's celebration. The count of covering screens is a
 * zustand store (OA-28 M6).
 */

const store = createStore<Readonly<{ covering: number }>>()(() => ({ covering: 0 }));

/** Whether the mode covers the page now. */
export function blastModeCovering(): boolean {
  return store.getState().covering > 0;
}

/** Blast mode covers the page from now; the returned function uncovers it. */
export function coverPage(): () => void {
  store.setState((state) => ({ covering: state.covering + 1 }));
  let done = false;
  return () => {
    if (done) return;
    done = true;
    store.setState((state) => ({ covering: state.covering - 1 }));
  };
}

/** Hears the mode leave the page, so a paused loop catches up at once. */
export function onUncover(listener: () => void): () => void {
  const off = store.subscribe((next, previous) => {
    if (previous.covering > 0 && next.covering === 0) listener();
  });
  return () => {
    off();
  };
}
