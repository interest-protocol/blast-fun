import Link from "next/link";
import type { ReactNode } from "react";

import styles from "./LaunchpadShell.module.css";
import theme from "./primitives/LaunchpadTheme.module.css";
import { TerminalSearch } from "./TerminalSearch";

/**
 * The public launchpad frame for `/`, `/coin/{launchId}`, and `/launch`.
 * It is a server component with no auth provider: public readers never
 * initialize Privy. `boostsUrl` is already validated; null renders no link.
 * `search` is the global search slot, opened from the top-center trigger.
 * It applies the launchpad light/dark theme, which follows the system.
 */
export function LaunchpadShell({
  boostsUrl,
  search,
  children,
}: Readonly<{ boostsUrl: string | null; search: ReactNode; children: ReactNode }>) {
  return (
    <div data-launchpad-theme="" className={`${theme.theme} ${styles.shell}`}>
      <header className={styles.header}>
        <div className={styles.bar}>
          <Link className={styles.brand} href="/">BLAST.FUN</Link>
          <div className={styles.search}>
            <TerminalSearch>{search}</TerminalSearch>
          </div>
          <nav className={styles.navRegion} aria-label="Launchpad">
            <ul className={styles.nav}>
              <li><Link href="/">Terminal</Link></li>
              <li><Link href="/launch">Launch</Link></li>
              {boostsUrl ? <li><a href={boostsUrl}>Boosts</a></li> : null}
            </ul>
          </nav>
        </div>
      </header>
      <main className={styles.main} id="launchpad-content">{children}</main>
    </div>
  );
}

/** Honest interim content for a reserved launchpad route. */
export function LaunchpadPlaceholder({
  title,
  children,
}: Readonly<{ title: string; children: ReactNode }>) {
  return (
    <section className={styles.placeholder}>
      <h1>{title}</h1>
      {children}
    </section>
  );
}
