import type { ReactNode } from "react";

import { Glyph } from "./Glyph";
import styles from "./primitives.module.css";
import { statusPresentation, type StatusTone } from "./status";

/**
 * Text with a semantic tone. The tone is spoken as a word and drawn as a
 * shape, and color only reinforces both.
 */
export function StatusText({ tone, children }: Readonly<{ tone: StatusTone; children: ReactNode }>) {
  const { word, glyph } = statusPresentation(tone);
  return (
    <span className={styles.status} data-tone={tone}>
      <Glyph shape={glyph} />
      <span className={styles.srOnly}>{word}: </span>
      {children}
    </span>
  );
}
