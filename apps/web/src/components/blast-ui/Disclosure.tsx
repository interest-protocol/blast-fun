"use client";

import { useState, type ReactNode } from "react";
import { Collapsible } from "@base-ui/react/collapsible";
import { DisclosureButton } from "./Button";
import styles from "./Disclosure.module.css";

export function Disclosure({
  title,
  children,
}: Readonly<{ title: string; children: ReactNode }>) {
  const [open, setOpen] = useState(false);
  return (
    <Collapsible.Root open={open} onOpenChange={setOpen}>
      <Collapsible.Trigger render={<DisclosureButton aria-label={title} variant="ghost" size="lg">{title}</DisclosureButton>} className={styles.trigger} />
      <Collapsible.Panel className={styles.panel} inert={!open}>
        <div className={styles.content}>{children}</div>
      </Collapsible.Panel>
    </Collapsible.Root>
  );
}
