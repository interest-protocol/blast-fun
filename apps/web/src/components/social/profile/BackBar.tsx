import Link from "next/link";
import type { MouseEvent } from "react";

import { PreviousIcon } from "#web/components/blast-ui/Icons.tsx";
import styles from "./Profile.module.css";

/**
 * The back bar (§10.1, the gate's `backbar`): "‹ <the page you came from>".
 * `onClick` lets a caller step back through history instead of following the
 * link (a plain click only; the link stays the fallback). The page head
 * (`data-page-head`) lines the right column up with what follows it, so a back
 * bar that sits above a title (Settings) leaves that to the title.
 */
export function BackBar({
  href,
  label,
  onClick,
  pageHead = true,
}: Readonly<{ href: string; label: string; onClick?: (event: MouseEvent<HTMLAnchorElement>) => void; pageHead?: boolean }>) {
  // Over a title (no page head of its own) it is the Invites board's small link, 8px above the title.
  return (
    <div className={pageHead ? styles.backbar : `${styles.backbar} ${styles.overTitle}`} data-back-bar="" data-page-head={pageHead ? "" : undefined}>
      <Link href={href} onClick={onClick}>
        <PreviousIcon />
        {label}
      </Link>
    </div>
  );
}
