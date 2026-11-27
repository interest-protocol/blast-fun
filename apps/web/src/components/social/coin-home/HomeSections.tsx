"use client";

import { useId, useRef, type ReactNode } from "react";

import styles from "./CoinHome.module.css";
import { useTablePageMotion } from "./use-table-page-motion";
import { HOME_SECTION_TITLES, shownHomeSections, type HomeSectionKey, type HomeSectionPrefs } from "./home-sections";

/**
 * Home's sections in the device's order, each under a header: the title and
 * anything the section puts beside it (a link). The order and the hidden
 * sections come from the Sections menu in the bar (`HomeSettingsMenu`), and
 * every change is remembered on the device (`use-home-sections.ts`), so the
 * next page load lays the sections out this way and reads nothing for the
 * hidden ones.
 */

export type SectionChange = Readonly<{ key: HomeSectionKey; action: "move" | "hide" | "show"; position: number }>;

/** The bar's Sections menu. */
export const HOME_SECTIONS_MENU_ID = "home-sections-menu";

/**
 * A section as the Main board draws it: the title row (the 20/650 title and
 * whatever the section puts on its line), then the section's own surface —
 * a table card (`TableCard`) or the bonding curves' cards — under it.
 */
export type SectionSpec = Readonly<{
  /** Drawn in the header, after the title (a link to the section's own page). */
  tools?: ReactNode;
  title?: ReactNode;
  children: ReactNode;
}>;

type Props = Readonly<{
  prefs: HomeSectionPrefs;
  sections: Readonly<Record<HomeSectionKey, SectionSpec>>;
  /** Drawn where the sections would be when every one is hidden. */
  empty: ReactNode;
}>;

export function HomeSections({ prefs, sections, empty }: Props) {
  const id = useId();
  const root = useRef<HTMLDivElement>(null);
  useTablePageMotion(root);
  const shown = shownHomeSections(prefs);
  return (
    <div className={styles.sections} ref={root}>
      {shown.map((key) => {
        const spec = sections[key];
        return (
          <section aria-labelledby={`${id}-${key}`} className={styles.section} data-section={key} key={key}>
            <header className={styles.sectionHead}>
              <h2 id={`${id}-${key}`}>{spec.title ?? HOME_SECTION_TITLES[key]}</h2>
              <div className={styles.sectionTools}>{spec.tools}</div>
            </header>
            {spec.children}
          </section>
        );
      })}
      {shown.length === 0 ? empty : null}
    </div>
  );
}
