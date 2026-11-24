"use client";

import clsx from "clsx";
import type { ReactNode } from "react";

import styles from "./Figures.module.css";

const LEADING_ZEROS = /^([^0-9]*0\.(?:0[₀-₉]+|0*))(\d.*)$/;

/**
 * A price or amount as the panel's headline: the leading `0.00` (or `0.0₅`)
 * reads quieter so the significant digits come first. The text is unchanged,
 * so copying or reading it aloud gives the same exact value.
 */
export function Figure({
  text,
  size = "lg",
  className,
}: Readonly<{ text: string; size?: "xl" | "lg" | "md"; className?: string }>) {
  const match = LEADING_ZEROS.exec(text);
  return (
    <span className={clsx(styles.figure, styles[size], "num", className)}>
      {match ? (
        <>
          <span className={styles.lead}>{match[1]}</span>
          {match[2]}
        </>
      ) : (
        text
      )}
    </span>
  );
}

/** A signed change in basis points: the arrow and sign carry direction, color only repeats it. */
export function ChangePill({
  bps,
  window,
}: Readonly<{ bps: number | null | undefined; window?: string }>) {
  if (bps == null) return <span className={clsx(styles.change, "num")}>—</span>;
  const direction = bps > 0 ? "up" : bps < 0 ? "down" : "flat";
  const text = `${bps > 0 ? "+" : bps < 0 ? "−" : ""}${(Math.abs(bps) / 100).toFixed(2)}%`;
  return (
    <span className={clsx(styles.change, "num")} data-direction={direction}>
      {direction === "flat" ? null : (
        <svg aria-hidden="true" viewBox="0 0 24 24">
          <path d={direction === "up" ? "m6 15 6-6 6 6" : "m6 9 6 6 6-6"} />
        </svg>
      )}
      {text}
      {window ? <span className={styles.window}>{window}</span> : null}
    </span>
  );
}

/**
 * Progress toward a target as a ring. `ratio` is clamped for drawing only;
 * the label beside or inside it states the exact figures.
 */
export function ProgressRing({
  ratio,
  size,
  stroke,
  label,
  children,
}: Readonly<{
  ratio: number | null;
  size: number;
  stroke: number;
  label: string;
  children?: ReactNode;
}>) {
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const drawn = ratio == null ? 0 : Math.min(1, Math.max(0, ratio));
  return (
    <span aria-label={label} className={styles.ring} data-size={size} role="img">
      <svg aria-hidden="true" height={size} viewBox={`0 0 ${size} ${size}`} width={size}>
        <circle className={styles.track} cx={size / 2} cy={size / 2} fill="none" r={radius} strokeWidth={stroke} />
        {drawn > 0 ? (
          <circle
            className={styles.arc}
            cx={size / 2}
            cy={size / 2}
            fill="none"
            r={radius}
            strokeDasharray={`${(circumference * drawn).toFixed(2)} ${circumference.toFixed(2)}`}
            strokeLinecap="round"
            strokeWidth={stroke}
            transform={`rotate(-90 ${size / 2} ${size / 2})`}
          />
        ) : null}
      </svg>
      {children ? <span className={styles.ringLabel}>{children}</span> : null}
    </span>
  );
}
