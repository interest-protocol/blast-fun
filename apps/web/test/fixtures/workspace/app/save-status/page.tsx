"use client";

import { useState } from "react";
import { WorkspaceFrame } from "../../../../../src/components/social/blast-mode/WorkspaceFrame.tsx";
import { WorkspaceSaveStatus } from "../../../../../src/components/social/blast-mode/workspace/WorkspaceSaveStatus.tsx";
import styles from "../../../../../src/components/social/blast-mode/workspace/WorkspaceHost.module.css";

type Status = "saving" | "synced" | "error" | "local";
/** Local-only geometry fixture; no account, wallet, or write adapter. */
export default function SaveStatusProof() {
  const [state, setState] = useState<Status>("synced");
  return <div data-blast-ui data-theme="light"><WorkspaceFrame onExit={() => setState("synced")}>
    <WorkspaceSaveStatus state={state} reason="storage_write_failed" retry={() => setState("saving")} />
    <main className={styles.content}>
      <div className={styles.toolbar}>{(["saving", "synced", "error", "local"] as const).map(value => <button type="button" key={value} onClick={() => setState(value)}>Show {value}</button>)}</div>
      <section data-status-layout-probe="" className={styles.empty}><h1>Saved layout</h1><p>The chart area retains its exact rectangle through every save status.</p></section>
    </main>
  </WorkspaceFrame></div>;
}
