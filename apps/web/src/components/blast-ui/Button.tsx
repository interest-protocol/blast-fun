"use client";

import clsx from "clsx";
import Link from "next/link";
import type { ComponentPropsWithRef, ReactElement, ReactNode } from "react";
import { LoadingIndicator } from "./LoadingIndicator";
import { ControlChevron } from "./ControlChevron";
import styles from "./Controls.module.css";

/**
 * Control heights (System board): xs 28, sm 32 (9px corners), chip 36 (the top bar's
 * chips), md 40, lg 52 (14px corners). Fields: md 40 and lg 44 (12px corners).
 * Icon-only controls also take touch 44 (the Mobile board's header icons).
 */
export type ControlSize = "xs" | "sm" | "chip" | "md" | "lg";
/** Icon-only controls add `touch`: 44px with a 20px glyph, the Mobile board's header icons. */
export type IconButtonSize = ControlSize | "touch";
type LoadingState = { loading?: false; loadingLabel?: never } | { loading: boolean; loadingLabel: string };
type ButtonOwnProps = Omit<ComponentPropsWithRef<"button">, "style"> & LoadingState & {
  /**
   * `nav`: a rail row (42px, 12px padding, 11px corners; `size="lg"` is the avatar row).
   * `picker`: the coin picker pill. `segment`: a control inside a shared track.
   */
  variant?: "primary" | "positive" | "secondary" | "ghost" | "danger" | "ink" | "segment" | "nav" | "picker";
  /** Use only when an unavailable action must remain focusable for an explanation. */
  focusableDisabled?: boolean;
};
type ButtonSize = ControlSize | "glyph";
export type ButtonProps = ButtonOwnProps & { size?: ButtonSize };

/** Native button semantics; geometry, focus and unavailable activation have one owner. */
function ButtonControl({
  variant = "secondary", size = "md", type = "button", className, children,
  loading = false, loadingLabel, disabled = false, focusableDisabled = false,
  onClickCapture, onKeyDownCapture, ...props
}: ButtonOwnProps & { size?: ButtonSize | "touch" }) {
  const unavailable = disabled || loading || props["aria-disabled"] === true || props["aria-disabled"] === "true" || props["aria-busy"] === true || props["aria-busy"] === "true";
  return <button
    {...props}
    type={type}
    className={clsx(styles.button, className)}
    data-ui-button=""
    data-ui-size={size}
    data-ui-variant={variant}
    disabled={unavailable && !focusableDisabled}
    aria-disabled={unavailable || undefined}
    aria-busy={loading || props["aria-busy"] || undefined}
    onClickCapture={event => {
      if (unavailable) { event.preventDefault(); event.stopPropagation(); return; }
      onClickCapture?.(event);
    }}
    onKeyDownCapture={event => {
      if (unavailable && (event.key === "Enter" || event.key === " ")) { event.preventDefault(); event.stopPropagation(); return; }
      onKeyDownCapture?.(event);
    }}
  >
    {loading ? <LoadingIndicator label={loadingLabel!}>{children}</LoadingIndicator> : children}
  </button>;
}

/** Labelled buttons take the shared control sizes; `touch` stays with the icon-only controls. */
export const Button: (props: ButtonProps) => ReactElement = ButtonControl;

export type ButtonLinkProps = Omit<ComponentPropsWithRef<typeof Link>, "style"> & {
  variant?: Exclude<ButtonProps["variant"], "segment">;
  size?: ControlSize;
};

/** A place that looks like an action ("All presales", "View coin"): Button geometry and states, link semantics. */
export function ButtonLink({ variant = "secondary", size = "md", className, ...props }: ButtonLinkProps) {
  return <Link {...props} className={clsx(styles.button, className)} data-ui-button="" data-ui-size={size} data-ui-variant={variant} />;
}

type AccessibleName = { "aria-label": string; "aria-labelledby"?: string } | { "aria-labelledby": string; "aria-label"?: string };
export type IconButtonProps = ButtonOwnProps & { size?: IconButtonSize } & AccessibleName;

/** Icon-only actions require an accessible name and use the same button invariants. */
export function IconButton({ variant = "ghost", className, ...props }: IconButtonProps) {
  return <ButtonControl {...props} data-ui-icon="" variant={variant} className={clsx(styles.iconButton, className)} />;
}

export type IconButtonLinkProps = Omit<ComponentPropsWithRef<typeof Link>, "style" | "aria-label"> & {
  "aria-label": string;
  variant?: ButtonLinkProps["variant"];
  size?: IconButtonSize;
};

/** A place reached by an icon (the top bar's bell): IconButton's geometry and states, link semantics. */
export function IconButtonLink({ variant = "ghost", size = "md", className, ...props }: IconButtonLinkProps) {
  return <Link {...props} className={clsx(styles.button, styles.iconButton, className)} data-ui-button="" data-ui-icon="" data-ui-size={size} data-ui-variant={variant} />;
}

type DisclosureButtonProps = ButtonProps & (
  | (AccessibleName & { iconOnly: true; children?: never; leadingIcon?: never; chevron?: true })
  /** `chevron={false}`: a plain chip that still discloses (Home's Filters). */
  | { iconOnly?: false; children: ReactNode; leadingIcon?: ReactNode; chevron?: boolean }
);

/** Popup/collapsible adapters supply aria-expanded; the shared control owns its chevron. */
export function DisclosureButton({ iconOnly = false, children, leadingIcon, chevron = true, ...props }: DisclosureButtonProps) {
  const { className, variant, ...buttonProps } = props;
  return <Button {...buttonProps} className={clsx(iconOnly && styles.iconButton, className)} variant={variant ?? (iconOnly ? "ghost" : "secondary")} data-ui-icon={iconOnly ? "" : undefined} data-ui-disclosure={chevron ? "" : "plain"}>
    {!iconOnly && leadingIcon ? <span aria-hidden="true" data-ui-leading="" className={styles.leadingIcon}>{leadingIcon}</span> : null}
    {iconOnly ? null : <span className={styles.disclosureLabel} data-ui-label="">{children}</span>}
    {chevron ? <ControlChevron /> : null}
  </Button>;
}

/** Native details keeps its keyboard/toggle semantics; the shared control owns the indicator. */
export function DisclosureSummary({ children, className, ...props }: Omit<ComponentPropsWithRef<"summary">, "style">) {
  return <summary {...props} data-ui-button="" data-ui-size="md" data-ui-variant="ghost" data-ui-disclosure="" className={clsx(styles.button, styles.summary, className)}>
    <span className={styles.disclosureLabel} data-ui-label="">{children}</span>
    <ControlChevron />
  </summary>;
}
