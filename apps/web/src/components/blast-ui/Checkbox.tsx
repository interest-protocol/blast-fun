import clsx from "clsx";
import type { ComponentPropsWithRef } from "react";
import styles from "./Controls.module.css";

/** A native checkbox inside a `<label>`; checked is ink (System board). */
export function Checkbox({ className, ...props }: Omit<ComponentPropsWithRef<"input">, "type" | "style">) {
  return <input {...props} type="checkbox" data-ui-checkbox="" className={clsx(styles.checkbox, className)} />;
}

export type SwitchProps = Omit<ComponentPropsWithRef<"button">, "style" | "type" | "role" | "onChange" | "children" | "aria-checked"> & {
  checked: boolean;
  /** Called with the next state; the switch is controlled. */
  onCheckedChange: (checked: boolean) => void;
};

/**
 * The one on/off switch (System board): a 46 × 28 pill whose 22px knob slides; on is
 * the ink track, never pink. A native `role="switch"` button, so Space and Enter toggle
 * it. Name it with `aria-label` or by wrapping it in a `<label>` with its text.
 */
export function Switch({ checked, onCheckedChange, className, onClick, ...props }: SwitchProps) {
  return (
    <button
      {...props}
      aria-checked={checked}
      className={clsx(styles.switch, className)}
      data-ui-switch=""
      onClick={(event) => {
        onClick?.(event);
        if (!event.defaultPrevented) onCheckedChange(!checked);
      }}
      role="switch"
      type="button"
    >
      <span aria-hidden="true" className={styles.switchKnob} />
    </button>
  );
}
