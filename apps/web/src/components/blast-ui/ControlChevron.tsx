import styles from "./Controls.module.css";

/** Internal adornment: selects and disclosures share one glyph (the System board's chevron, stroke 2) and protected size. */
export function ControlChevron() {
  return <span aria-hidden="true" className={styles.disclosureIcon} data-ui-chevron="">
    <svg fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" viewBox="0 0 24 24"><path d="m6 9 6 6 6-6" /></svg>
  </span>;
}
