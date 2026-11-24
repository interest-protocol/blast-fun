import type { ReactNode } from "react";

import type { DataStateGlyph } from "./data-state";
import styles from "./primitives.module.css";
import type { StatusGlyph } from "./status";

const SHAPES: Record<DataStateGlyph | StatusGlyph, ReactNode> = {
  "dotted-ring": <circle cx="8" cy="8" r="5.5" fill="none" strokeDasharray="2 2.3" />,
  "hollow-ring": <circle cx="8" cy="8" r="5.5" fill="none" />,
  "slashed-ring": (
    <>
      <circle cx="8" cy="8" r="5.5" fill="none" />
      <path d="M4.1 11.9 11.9 4.1" />
    </>
  ),
  clock: (
    <>
      <circle cx="8" cy="8" r="5.5" fill="none" />
      <path d="M8 5v3.2l2.2 1.3" fill="none" />
    </>
  ),
  "triangle-up": <path d="M8 3.5 13 12H3z" fill="currentColor" />,
  "triangle-down": <path d="M3 4h10l-5 8.5z" fill="currentColor" />,
  bar: <path d="M3 8h10" />,
  diamond: <path d="M8 2.5 13.5 8 8 13.5 2.5 8z" fill="currentColor" />,
};

/** A decorative state shape; the adjacent text always carries the meaning. */
export function Glyph({ shape }: Readonly<{ shape: DataStateGlyph | StatusGlyph }>) {
  return (
    <svg
      className={styles.glyph}
      data-glyph={shape}
      viewBox="0 0 16 16"
      width="16"
      height="16"
      aria-hidden="true"
      focusable="false"
    >
      {SHAPES[shape]}
    </svg>
  );
}
