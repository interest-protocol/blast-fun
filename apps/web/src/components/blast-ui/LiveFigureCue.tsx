"use client";

import { useLayoutEffect, useRef, type ReactNode } from "react";
import { EASE_OUT, T3 } from "./motion-tokens";
import { prefersReducedMotion } from "./use-shell-prefs";
import styles from "./LiveFigureCue.module.css";

/** Mark trade-driven changes at most once per second. The caller controls display precision. */
export function LiveFigureCue({ tradeId, value, children }: Readonly<{
  tradeId: string | null;
  value: string | number;
  children: ReactNode;
}>) {
  const mark = useRef<HTMLSpanElement>(null);
  const previous = useRef({ tradeId, value });
  const lastFlash = useRef(-Infinity);

  useLayoutEffect(() => {
    const before = previous.current;
    previous.current = { tradeId, value };
    if (tradeId === null || tradeId === before.tradeId || value === before.value) return;

    const now = performance.now();
    if (now - lastFlash.current >= 1_000 && mark.current?.animate && !prefersReducedMotion()) {
      lastFlash.current = now;
      mark.current.animate([
        { opacity: 0.65 },
        { opacity: 0.65, offset: 0.35, easing: EASE_OUT },
        { opacity: 0 },
      ], { duration: T3 });
    }
  }, [tradeId, value]);

  return <span className={styles.figure}>{children}<span aria-hidden="true" className={styles.mark} ref={mark} /></span>;
}
