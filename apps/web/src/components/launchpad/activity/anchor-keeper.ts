// Keeps a durable activity link's record in view while the page settles. On
// mobile the Theses view stacks the Theses list above Activity, and that list
// answers after Activity's own first read: without this, the list would push
// the record far below the screen once it renders.

export type AnchorKeeperPorts = Readonly<{
  /** Brings the record (or the note saying it is not there) into view. */
  scroll(): void;
  /** Calls `listener` whenever the page's content changes size; returns how to stop. */
  onLayoutChange(listener: () => void): () => void;
  /** Calls `listener` when the reader scrolls, taps, clicks or types; returns how to stop. */
  onReaderInput(listener: () => void): () => void;
  setTimer(callback: () => void, ms: number): () => void;
}>;

/** How long the page may still move content above the record after the link opens. */
export const ANCHOR_SETTLE_MS = 15_000;

/**
 * Scrolls to the record now and again after every layout change, until the
 * reader takes over (any scroll, tap, click or key) or `settleMs` passes. The
 * returned function stops it early.
 */
export function keepAnchorInView(ports: AnchorKeeperPorts, settleMs = ANCHOR_SETTLE_MS): () => void {
  const stops: (() => void)[] = [];
  let active = true;
  const stop = () => {
    if (!active) return;
    active = false;
    for (const release of stops.splice(0)) release();
  };
  stops.push(ports.setTimer(stop, settleMs));
  ports.scroll();
  stops.push(ports.onLayoutChange(() => {
    if (active) ports.scroll();
  }));
  stops.push(ports.onReaderInput(stop));
  return stop;
}

const READER_INPUT = ["wheel", "touchstart", "pointerdown", "keydown"] as const;

/** The browser's ports for the element `id`: a ResizeObserver on the document body and the reader's own input. */
export function browserAnchorPorts(id: string): AnchorKeeperPorts {
  return {
    scroll: () => document.getElementById(id)?.scrollIntoView({ block: "center" }),
    onLayoutChange(listener) {
      if (typeof ResizeObserver === "undefined") return () => {};
      const observer = new ResizeObserver(() => listener());
      observer.observe(document.body);
      return () => observer.disconnect();
    },
    onReaderInput(listener) {
      for (const type of READER_INPUT) window.addEventListener(type, listener, { passive: true, capture: true });
      return () => {
        for (const type of READER_INPUT) window.removeEventListener(type, listener, { capture: true });
      };
    },
    setTimer(callback, ms) {
      const timer = setTimeout(callback, ms);
      return () => clearTimeout(timer);
    },
  };
}
