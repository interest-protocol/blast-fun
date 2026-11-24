"use client";

import { useState, type ReactNode } from "react";
import { Popover } from "@base-ui/react/popover";
import { usePortalContainer } from "#web/components/ui-libraries/portal.ts";
import { CopyButton } from "./CopyButton";
import styles from "./InspectValue.module.css";

/** Press to open a selectable value with a copy action. */
export function InspectValue({
  value,
  label,
  triggerLabel,
  description,
  children,
  onOpenChange,
  copyValue,
}: Readonly<{
  value: string;
  label: string;
  triggerLabel?: string;
  description?: string;
  children: ReactNode;
  onOpenChange?: (open: boolean) => void;
  copyValue?: string;
}>) {
  const container = usePortalContainer();
  const [open, setOpen] = useState(false);
  return (
    <Popover.Root open={open} onOpenChange={(next) => {
      setOpen(next);
      if (next !== open) onOpenChange?.(next);
    }}>
      <Popover.Trigger
        className={styles.trigger}
        data-inspect-value=""
        aria-label={triggerLabel ?? `Inspect full ${label}: ${value}${description ? `. ${description}` : ""}`}
      >
        {children}
      </Popover.Trigger>
      <Popover.Portal container={container}>
        <Popover.Positioner
          sideOffset={8}
          collisionPadding={16}
          className={styles.layer}
        >
          <Popover.Popup className={styles.popup} aria-label={`Full ${label}`}>
            <Popover.Title className={styles.caption}>{label}</Popover.Title>
            <code className={styles.value} tabIndex={0}>
              {value}
            </code>
            {description && <p className={styles.description}>{description}</p>}
            <div className={styles.actions}>
              <CopyButton
                className="btn btn-quiet btn-sm"
                label={`Copy full ${label}`}
                failureMessage={copyValue === undefined ? undefined : "Could not copy."}
                onCopy={async () => {
                  await navigator.clipboard.writeText(copyValue ?? value);
                  return true;
                }}
              >
                Copy
              </CopyButton>
              <Popover.Close className="btn btn-quiet btn-sm">
                Close
              </Popover.Close>
            </div>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
