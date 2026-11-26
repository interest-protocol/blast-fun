import styles from "./TestPricingNotice.module.css";

export function TestPricingNotice({ enabled }: Readonly<{ enabled: boolean }>) {
  if (!enabled) return null;
  return <aside className={styles.notice} aria-label="Test pricing"><strong>TSUI has no real value.</strong> 1 TSUI uses SUI’s current USD price.</aside>;
}
