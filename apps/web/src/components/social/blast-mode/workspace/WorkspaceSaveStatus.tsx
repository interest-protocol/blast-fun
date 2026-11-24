"use client";
import { Button } from "#web/components/blast-ui/Button.tsx";

import { useContext, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { WorkspaceStatusTarget } from "./frame-targets";
import { workspacePayloadRejected } from "./account-sync";
import styles from "./WorkspaceHost.module.css";

function recoveryMessage(reason?: string) {
  if (reason === "workspace_changed_in_another_tab") return "Another tab saved a newer workspace. Your draft is kept here and has not overwritten it. Reload to use the newer saved workspace.";
  if (reason === "storage_write_failed") return "Your latest changes will not survive reloading or closing this tab. Keep this tab open and retry to save them.";
  if (workspacePayloadRejected(reason)) return "Your setup could not be accepted. Your changes are kept here. Update the setup or refresh after updating Blast.";
  if (reason === "remote_available_on_reentry") return "A newer saved workspace is available next time you open Blast mode.";
  if (reason === "guest_save_failed") return "Your workspace could not be saved. Keep this tab open and retry before reloading or closing it.";
  return "Your workspace is open here but could not sync. Keep this tab open and retry.";
}

const labels = { local: "Changes pending sync", saving: "Saving workspace" };
/** A save quicker than this stays silent: an ordinary view change persists without a word. */
const SLOW_SAVE_MS = 1500;
/**
 * Saving is quiet (Blast mode audit 03): opening Discover or changing a tab persists without
 * Pending or Saved in the header. A save still pending after 1.5s is announced to assistive
 * technology only; nothing visible appears or moves (owner, 2026-10-29: no spinners in the bar).
 * Only a failure shows a status, which overlays rather than moving the bar.
 * `saveRevision` is accepted for callers that mark guest saves; a finished save says nothing.
 */
export function WorkspaceSaveStatus({ state, reason, retry }: Readonly<{ state: "local" | "saving" | "synced" | "error"; reason?: string; retry: () => void; saveRevision?: number }>) {
  const target = useContext(WorkspaceStatusTarget);
  const pending = state === "local" || state === "saving";
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    if (!pending) return;
    const timeout = setTimeout(() => setSlow(true), SLOW_SAVE_MS);
    return () => { clearTimeout(timeout); setSlow(false); };
  }, [pending]);
  if (!target) return null;
  if (state === "error") return createPortal(<details data-workspace-save-problem="" className={styles.saveProblem} open>
    <summary>{reason === "remote_available_on_reentry" ? "Updated" : "Save error"}</summary>
    <div role="alert"><p>{recoveryMessage(reason)}</p>
      {reason === "workspace_changed_in_another_tab" && <Button variant="secondary" size="sm" type="button"  onClick={() => window.location.reload()}>Reload saved workspace</Button>}
      {!workspacePayloadRejected(reason) && reason !== "remote_available_on_reentry" && reason !== "workspace_changed_in_another_tab" && <Button variant="secondary" size="sm" type="button"  onClick={retry}>Retry</Button>}
    </div>
  </details>, target);
  const shown = pending && slow;
  return createPortal(<span className="sr" role="status">{shown ? labels[state] : null}</span>, target);
}
