import { Switch } from "#web/components/blast-ui/Checkbox.tsx";
import styles from "./Activity.module.css";

export function SmallTradeSwitch({ checked, onCheckedChange }: Readonly<{
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
}>) {
  return <label className={styles.tradeFilter}>
    Hide trades under $1
    <Switch checked={checked} onCheckedChange={onCheckedChange} />
  </label>;
}
