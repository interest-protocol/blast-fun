"use client";

import type { ReactNode } from "react";

import { timeUntil } from "@blast/core/web/format.ts";

import { useCommitClock } from "#web/components/social/commit/commit-clock.ts";
import { dyn } from "#web/components/blast-ui/csp-style.ts";
import { cx } from "./cx";

/** An unnamed wallet's gradient dot (`.wav`): hue from the address's character codes, as the design. */
export function WalletAvatar({ address, size = 26 }: Readonly<{ address: string; size?: number }>) {
  let hue = 0;
  for (const char of address) hue += char.charCodeAt(0);
  return <span aria-hidden="true" className={cx("wav")} {...dyn({ width: size, height: size, ["--h" as string]: hue % 360 })} />;
}

/**
 * A live countdown (`11d 0h`, `6h 12m`, `1m 16s`). It reads the second clock
 * itself, so only it redraws each second; `now` is the page's time, which the
 * server's markup and the first draw use.
 */
export function TimeLeft({ to, now }: Readonly<{ to: number; now: number }>) {
  const tick = useCommitClock();
  return <>{timeUntil(to, Math.max(tick, now))}</>;
}

/** "Following" or "Follows you" next to a name (`.ftag`). */
export function RelTag({ children }: Readonly<{ children: ReactNode }>) {
  return <span className={cx("ftag")}>{children}</span>;
}
