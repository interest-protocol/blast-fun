import clsx from "clsx";
import type { ComponentPropsWithRef } from "react";
import type { ControlSize } from "./Button";
import { ControlChevron } from "./ControlChevron";
import styles from "./Controls.module.css";

type InputProps = Omit<ComponentPropsWithRef<"input">, "type" | "size" | "style"> & {
  type?: "text" | "search" | "email" | "number" | "password" | "url" | "tel" | "datetime-local";
  size?: ControlSize;
};

export function TextField({ className, size = "md", type = "text", ...props }: InputProps) {
  return <input {...props} type={type} data-ui-input="" data-ui-size={size} className={clsx(styles.input, className)} />;
}

/** `resize`: vertical by default (as before); `none` for the boards' fixed composers and bios. */
export function TextArea({ className, resize = "vertical", ...props }: Omit<ComponentPropsWithRef<"textarea">, "style"> & { resize?: "vertical" | "none" }) {
  return <textarea {...props} data-ui-input="" data-ui-resize={resize === "none" ? "none" : undefined} className={clsx(styles.input, styles.textarea, className)} />;
}

export function SelectField({ className, size = "md", ...props }: Omit<ComponentPropsWithRef<"select">, "size" | "style"> & { size?: ControlSize }) {
  return <span data-ui-select="" className={clsx(styles.selectField, className)}>
    <select {...props} data-ui-input="" data-ui-size={size} className={clsx(styles.input, styles.selectInput)} />
    <ControlChevron />
  </span>;
}

/**
 * Currency signs, an icon, an input and supporting actions share one continuous focus
 * boundary. With a `size` the frame owns its height (md 40, the search field; lg 44, the
 * forms' field with a Max action); without one it follows its input. A trailing Button
 * is the board's Max: 32px, inset evenly from the frame's end.
 */
export function FieldGroup({ className, size, variant, ...props }: Omit<ComponentPropsWithRef<"div">, "style"> & { size?: ControlSize; variant?: "amount" }) {
  return <div {...props} data-ui-field="" data-ui-size={size} data-ui-field-variant={variant} className={clsx(styles.fieldGroup, className)} />;
}

/** The browser owns file selection; selected files stay uncontrolled. */
export function FileField(props: Omit<ComponentPropsWithRef<"input">, "type" | "size" | "style" | "value" | "defaultValue">) {
  return <input {...props} type="file" data-ui-file="" />;
}
