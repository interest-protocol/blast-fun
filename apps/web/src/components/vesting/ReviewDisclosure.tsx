"use client";

import { Collapsible } from "@base-ui/react/collapsible";
import type { ReactNode } from "react";
import { DisclosureButton } from "#web/components/blast-ui/Button.tsx";
import styles from "./CreationReview.module.css";

export function ReviewDisclosure({ label, ariaLabel, className = styles.disclosure, children }: Readonly<{
  label: ReactNode;
  ariaLabel?: string;
  className?: string;
  children: ReactNode;
}>) {
  return <Collapsible.Root className={className}>
    <Collapsible.Trigger render={<DisclosureButton variant="ghost" aria-label={ariaLabel}>{label}</DisclosureButton>} className={styles.disclosureTrigger} />
    <Collapsible.Panel className={styles.disclosurePanel} keepMounted>
      <div className={styles.disclosureContent}>{children}</div>
    </Collapsible.Panel>
  </Collapsible.Root>;
}
