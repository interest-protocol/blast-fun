import type { ReactNode } from "react";

import styles from "./PageHeader.module.css";

/**
 * A page's header (`.phead`): the title on the left and the page's actions on
 * the right. The title is the System board's page title, 36/650 (32 on
 * phones). The block carries the boards' spacing: `--page-title-top` above
 * the title (26px under the top bar) and `--page-title-gap` before the first
 * card (20px; a page whose board draws another gap sets the variable on its
 * root). The right column lines its first card up with the
 * first surface after this header (`data-page-head`).
 */
export function PageHeader({
  title,
  sub,
  actions,
  titleId,
}: Readonly<{ title: ReactNode; sub?: ReactNode; actions?: ReactNode; titleId?: string }>) {
  return (
    <header className={styles.phead} data-page-head="">
      <div>
        <h1 id={titleId}>{title}</h1>
        {sub ? <div className={styles.sub}>{sub}</div> : null}
      </div>
      {actions ? <div className={styles.actions}>{actions}</div> : null}
    </header>
  );
}
