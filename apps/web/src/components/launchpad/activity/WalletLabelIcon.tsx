import type { WalletLabel } from "./wallet-labels";
import styles from "./WalletLabelIcon.module.css";

export function WalletLabelIcon({ label }: Readonly<{ label: WalletLabel }>) {
  return <span className={styles.icon} data-wallet-label={label} aria-hidden="true" />;
}
