"use client";

import { Collapsible } from "@base-ui/react/collapsible";
import clsx from "clsx";
import { useLayoutEffect, useRef, type ComponentProps } from "react";

import { useHydrated } from "#web/components/ui-libraries/use-hydrated.tsx";

import styles from "./Collapse.module.css";

/** Keep closing content present until its transition ends; hidden content cannot take focus. */
export function Collapse({
  open,
  children,
  className,
  keepMounted = true,
  focusOnClose,
  ...props
}: Readonly<
  {
    open: boolean;
    keepMounted?: boolean;
    focusOnClose?: () => HTMLElement | null;
  } & Omit<ComponentProps<"div">, "hidden">
>) {
  const panel = useRef<HTMLDivElement>(null);
  const hydrated = useHydrated();
  useLayoutEffect(() => {
    if (!open && panel.current?.contains(document.activeElement)) {
      focusOnClose?.()?.focus({ preventScroll: true });
    }
  }, [open, focusOnClose]);
  return (
    <Collapsible.Root open={open} className={styles.root}>
      <Collapsible.Panel
        {...props}
        ref={panel}
        aria-hidden={!open || undefined}
        inert={!open || undefined}
        keepMounted={keepMounted}
        className={clsx(styles.collapsePanel, className)}
        render={(panelProps) => <div {...panelProps} style={hydrated ? panelProps.style : undefined} />}
      >
        {children}
      </Collapsible.Panel>
    </Collapsible.Root>
  );
}
