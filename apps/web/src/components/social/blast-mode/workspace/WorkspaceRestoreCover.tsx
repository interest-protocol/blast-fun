"use client";

import { useContext, useSyncExternalStore } from "react";
import { Button } from "#web/components/blast-ui/Button.tsx";
import { HelmetMark } from "#web/components/blast-ui/Icons.tsx";
import { StyleNonceContext } from "#web/components/ui-libraries/style-nonce.tsx";
import { ToolbarSkeleton, WorkspacePending } from "./WorkspacePending";
import { WORKSPACE_BOOT_SCRIPT } from "./workspace-boot";
import styles from "./WorkspaceHost.module.css";

const noSubscription = () => () => undefined;

/** Hidden shared markup hydrates normally; its clone stays until the live frame takes over. */
export function WorkspaceRestoreCover() {
  const nonce = useContext(StyleNonceContext);
  const fromServer = useSyncExternalStore(noSubscription, () => false, () => true);
  return <>
    <div data-workspace-cover-mount="" suppressHydrationWarning dangerouslySetInnerHTML={{ __html: "" }} />
    {fromServer && <><div hidden inert data-workspace-cover-source=""><section className={styles.frame}>
      <header className={styles.header}>
        <div className={styles.brand}><HelmetMark className={styles.brandMark} /><strong>Blast mode</strong></div>
        <div className={styles.headerToolbar}><ToolbarSkeleton saved /></div>
        <Button className={styles.exit} variant="ghost" size="chip">Exit <kbd>Esc</kbd></Button>
      </header>
      <WorkspacePending boot />
    </section></div>
    <script dangerouslySetInnerHTML={{ __html: WORKSPACE_BOOT_SCRIPT }} nonce={nonce} suppressHydrationWarning /></>}
  </>;
}
