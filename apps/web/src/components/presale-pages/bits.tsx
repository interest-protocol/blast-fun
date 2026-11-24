"use client";

import type { ReactNode } from "react";

import { timeUntil } from "@blast/core/web/format.ts";
import type { SocialPresaleSummary } from "@blast/core/web/contracts/presales.ts";

import { dyn } from "#web/components/blast-ui/csp-style.ts";
import { cx } from "./cx";
import { isOversubscribed } from "@blast/core/modules/presale/presentation.ts";

export function Oversubscription({ sale }: Readonly<{ sale: Pick<SocialPresaleSummary, "raised_atoms" | "target_atoms" | "phase"> }>) {
  if (!isOversubscribed(sale)) return null;
  return <span className={cx("oversubscription")}><b>Above target</b><span>{sale.phase === "cancelled" ? "Cancelled presale. Commitments are fully refundable." : "Your allocation is based on your share of all commitments. Unallocated payment is refunded at claim."}</span></span>;
}

/** An unnamed wallet's gradient dot (`.wav`): hue from the address's character codes, as the design. */
export function WalletAvatar({ address, size = 26 }: Readonly<{ address: string; size?: number }>) {
  let hue = 0;
  for (const char of address) hue += char.charCodeAt(0);
  return <span aria-hidden="true" className={cx("wav")} {...dyn({ width: size, height: size, ["--h" as string]: hue % 360 })} />;
}

/** A live countdown (`11d 0h`, `6h 12m`, `1m 16s`) from a clock the page passes down. */
export function TimeLeft({ to, now }: Readonly<{ to: number; now: number }>) {
  return <>{timeUntil(to, now)}</>;
}

/** "Following" or "Follows you" next to a name (`.ftag`). */
export function RelTag({ children }: Readonly<{ children: ReactNode }>) {
  return <span className={cx("ftag")}>{children}</span>;
}
