import { InspectValue } from "#web/components/blast-ui/InspectValue.tsx";
import styles from "./TestPricingNotice.module.css";

/**
 * Kept beside the test site's content, including navigation into trading workspaces. `compact`
 * is Blast mode's form beside its balance: the label and the explanation, the same copy behind ⓘ.
 */
export function TestPricingNotice({ enabled, compact = false }: Readonly<{ enabled: boolean; compact?: boolean }>) {
  if (!enabled) return null;
  if (compact) return <aside className={`${styles.notice} ${styles.compact}`} aria-label="Simulated TSUI pricing: TSUI has no real value">
    <strong>Test pricing</strong> <InspectValue label="Test pricing calculation" value="TSUI has no real value. 1 TSUI uses SUI’s current USD price. Dollar values are simulated.">ⓘ</InspectValue>
  </aside>;
  return <aside className={styles.notice} aria-label="Simulated TSUI pricing">
    <strong>Test pricing</strong> · TSUI has no real value <InspectValue label="Test pricing calculation" value="1 TSUI uses SUI’s current USD price. Dollar values are simulated.">ⓘ</InspectValue>
  </aside>;
}
