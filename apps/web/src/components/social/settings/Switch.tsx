import clsx from "clsx";
import styles from "./SettingsView.module.css";

/**
 * The settings switch, as the Settings and System boards draw it: a 46×28
 * track with a 22px knob, ink when on. `feelSound` marks the Sound switch,
 * which the Feel layer's own switch cue skips (turning sound on is confirmed
 * by one tap instead).
 */
export function Switch({
  label,
  on,
  onChange,
  busy,
  disabled = false,
  feelSound = false,
}: Readonly<{
  label: string;
  on: boolean;
  onChange(on: boolean): void;
  busy: boolean;
  disabled?: boolean;
  feelSound?: boolean;
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
      data-feel-sound={feelSound ? "" : undefined}
      disabled={disabled}
      onClick={() => onChange(!on)}
      role="switch"
      type="button"
    />
  );
}
