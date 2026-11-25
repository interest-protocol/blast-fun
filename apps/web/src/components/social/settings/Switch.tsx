import clsx from "clsx";
import styles from "./SettingsView.module.css";

/**
 * The settings switch, as the Settings and System boards draw it: a 46×28
 * track with a 22px knob, ink when on.
 */
export function Switch({
  label,
  on,
  onChange,
  busy,
  disabled = false,
}: Readonly<{
  label: string;
  on: boolean;
  onChange(on: boolean): void;
  busy: boolean;
  disabled?: boolean;
}>) {
  if (busy)
    return (
      <span
        aria-hidden="true"
        className={clsx(styles.skeleton, styles.switchSize)}
      />
    );
  return (
    <button
      aria-checked={on}
      aria-label={label}
      className={styles.switch}
      disabled={disabled}
      onClick={() => onChange(!on)}
      role="switch"
      type="button"
    />
  );
}
