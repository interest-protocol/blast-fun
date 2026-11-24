"use client";
import { hoverExcerpt } from "#web/lib/hover-text.ts";
import { Button, IconButton } from "./Button";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { CheckIcon, CopyIcon } from "./Icons";
import { useToast } from "./Toasts";
import styles from "./CopyButton.module.css";

/** The success word; the label also reserves its width through `data-copied-label`, so the two never drift. */
const COPIED = "Copied";
/** Only an acknowledged clipboard write may show success. */
type CopyAction = () => boolean | void | Promise<boolean | void>;

/**
 * `variant`: `ghost` (default) is the quiet glyph with an optional label; `secondary` is
 * the filled chip that reads "Copy" with no glyph (Settings board), keeping the glyph only
 * when it has no label; `primary` is the context's one action with its glyph (Invite).
 * `size`: xs 28 (default), sm 32, chip 36, md 40.
 */
export function CopyButton({ onCopy, label, title = label, children, className, disabled = false, variant = "ghost", size = "xs", failureMessage = "Copying is blocked here. Select the address instead." }: Readonly<{
  onCopy: CopyAction;
  label: string;
  title?: string;
  children?: ReactNode;
  className?: string;
  disabled?: boolean;
  failureMessage?: string;
  variant?: "ghost" | "secondary" | "primary";
  size?: "xs" | "sm" | "chip" | "md";
}>) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pending = useRef(false);
  const mounted = useRef(false);
  const toast = useToast();
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (timer.current !== null) clearTimeout(timer.current);
    };
  }, []);
  async function copy() {
    if (pending.current) return;
    pending.current = true;
    if (timer.current !== null) clearTimeout(timer.current);
    setCopied(false);
    let success = false;
    try {
      success = await onCopy() === true;
    } catch {
      if (mounted.current) toast(failureMessage);
    }
    pending.current = false;
    if (!success || !mounted.current) return;
    setCopied(true);
    timer.current = setTimeout(() => setCopied(false), 1800);
  }
  const Control = children === undefined ? IconButton : Button;
  const glyph = children === undefined || variant !== "secondary";
  return (
    <>
      <Control variant={variant} size={size} aria-label={copied ? COPIED : label} className={className} data-copied={copied || undefined} disabled={disabled} onClick={() => void copy()} title={copied ? COPIED : hoverExcerpt(title)} type="button">
        {glyph ? (
          <span aria-hidden="true" className={styles.icon}>
            <span data-visible={!copied}><CopyIcon /></span>
            <span data-visible={copied}><CheckIcon strong /></span>
          </span>
        ) : null}
        {children === undefined ? null : <span className={styles.label} data-label={typeof children === "string" ? children : undefined} data-copied-label={typeof children === "string" ? COPIED : undefined}>{copied && typeof children === "string" ? COPIED : children}</span>}
      </Control>
      <span className={styles.status} role="status">{copied ? "Copied to clipboard" : ""}</span>
    </>
  );
}
