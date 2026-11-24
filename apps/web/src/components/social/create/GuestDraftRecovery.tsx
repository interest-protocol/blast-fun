"use client";

import { useId, useRef, type ChangeEvent, type RefObject } from "react";
import { Button } from "#web/components/blast-ui/Button.tsx";
import { FileField } from "#web/components/blast-ui/TextField.tsx";
import { LoadingIndicator } from "#web/components/blast-ui/LoadingIndicator.tsx";
import type { GuestDraftRestore, GuestDraftSnapshot } from "./guest-draft-storage.ts";
import { cx } from "./cx";
import styles from "./GuestDraftRecovery.module.css";

export function GuestDraftRecovery({
  restored,
  busy,
  error,
  unsavedDraft,
  separateDraft,
  onExport,
  onImport,
  onUse,
  onRetry,
  onKeepCurrent,
  onContinueSeparate,
  activeOperation = false,
}: Readonly<{
  restored: GuestDraftRestore;
  busy: boolean;
  error: string | null;
  unsavedDraft: boolean;
  separateDraft: boolean;
  onExport: (raw: string, name: string) => void;
  onImport: (file: File) => Promise<void>;
  onUse: () => void;
  onRetry: () => void;
  onKeepCurrent?: () => void;
  onContinueSeparate?: () => void;
  activeOperation?: boolean;
}>) {
  const inputId = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  const importFile = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    if (file) void importAndRestoreFocus(file, onImport, heading);
  };
  const snapshot =
    restored.status === "storage_error" ? null : restored.snapshot;
  const recovered = restored.status === "canonical";
  const canImport = restored.status !== "acknowledged" && snapshot !== null && snapshot.canonicalRaw === null;
  const copy = recoveryCopy(restored);
  return (
    <section
      className={`${cx("card")} ${styles.recovery}`}
      aria-labelledby={`${inputId}-title`}
      data-guest-recovery=""
    >
      <h1 id={`${inputId}-title`} ref={heading} tabIndex={-1}>{copy.title}</h1>
      <p role={recovered ? "status" : undefined}>{copy.description}</p>
      <GuestDraftExports snapshot={snapshot} recovered={recovered} onExport={onExport} />
      {canImport ? (
        <>
          <p>
            If you have a recovered draft file, choose it here. You can also
            export your copies and continue with a separate draft.
          </p>
          <label htmlFor={inputId}>Recovered draft file</label>
          <FileField
            accept="application/json,.json"
            disabled={busy}
            id={inputId}
            onChange={importFile}
          />
        </>
      ) : null}
      {busy ? <LoadingIndicator label="Checking recovered draft" /> : null}
      {restored.status === "canonical" ? <RecoveredDraftAction
        name={restored.draft.name}
        busy={busy}
        unsavedDraft={unsavedDraft}
        activeOperation={activeOperation}
        separateDraft={separateDraft}
        descriptionId={`${inputId}-adoption`}
        onUse={onUse}
      /> : null}
      {error ? <p role="alert">{error}</p> : null}
      <Button
        variant="secondary"
        size="sm"
        className="btn btn-quiet btn-sm"
        disabled={busy}
        onClick={onRetry}
        type="button"
      >
        Check browser storage again
      </Button>
      {onContinueSeparate ? <>
        <p>Continuing keeps all browser copies intact. This separate draft will not be saved in this browser while those copies are retained or storage is unavailable. Save it to your account to keep your work.</p>
        <Button variant="secondary" size="sm" className="btn btn-quiet btn-sm" disabled={busy} onClick={onContinueSeparate} type="button">Continue with a separate draft</Button>
      </> : null}
      {onKeepCurrent ? (
        <Button
          variant="secondary"
          size="sm"
          className="btn btn-quiet btn-sm"
          disabled={busy}
          onClick={onKeepCurrent}
          type="button"
        >
          Keep editing my account draft
        </Button>
      ) : null}
    </section>
  );
}

async function importAndRestoreFocus(file: File, onImport: (file: File) => Promise<void>, heading: RefObject<HTMLHeadingElement | null>): Promise<void> {
  try {
    await onImport(file);
  } catch {
    // Import feedback belongs to the parent; return focus on either outcome.
  } finally {
    heading.current?.focus();
  }
}

function recoveryCopy(restored: GuestDraftRestore): Readonly<{ title: string; description: string }> {
  if (restored.status === "storage_error") return {
    title: "Your browser draft is unavailable",
    description: "Browser storage could not be read or saved. Your current draft is unchanged. You can retry storage or continue without changing any browser copies.",
  };
  if (restored.status === "acknowledged") return {
    title: "This browser draft was already saved",
    description: "Your account saved this copy, but browser cleanup did not finish. The remaining backup is kept for export and will not be offered as another draft.",
  };
  if (restored.status === "canonical") return {
    title: "Your recovered draft is ready",
    description: "Review this recovered copy before using it. The retained source stays safe until your account saves the adopted draft.",
  };
  if (restored.status === "recovery_required" && restored.reason === "changed") return {
    title: "Your browser copies changed",
    description: "Browser copies changed since the last check. They have been kept intact. Export them for review, check again, or continue with a separate draft.",
  };
  if (restored.status === "recovery_required" && restored.reason === "conflict") return {
    title: "Keep both browser draft copies",
    description: "These copies cannot be safely combined. Export both before reviewing them. You can continue with a separate draft without overwriting either copy.",
  };
  return {
    title: "Keep your browser draft safe",
    description: "This browser copy cannot be opened as a current draft. Its original bytes have been kept. Export it for recovery, or continue with a separate draft.",
  };
}

function RecoveredDraftAction({ name, busy, unsavedDraft, activeOperation, separateDraft, descriptionId, onUse }: Readonly<{
  name: string;
  busy: boolean;
  unsavedDraft: boolean;
  activeOperation: boolean;
  separateDraft: boolean;
  descriptionId: string;
  onUse: () => void;
}>) {
  const explanation = activeOperation
    ? "Finish publishing and uploads before using a recovered draft."
    : unsavedDraft
      ? "Keep editing your current draft and save its changes to your account before using a recovered copy."
      : null;
  return <>
    <p>Recovered presale: <strong>{name || "Untitled presale"}</strong></p>
    <Button variant="primary" size="sm" className="btn btn-primary btn-sm" disabled={busy || unsavedDraft || activeOperation} aria-describedby={explanation ? descriptionId : undefined} onClick={onUse} type="button">
      {separateDraft ? "Use as a separate draft" : "Use recovered draft"}
    </Button>
    {explanation ? <p id={descriptionId}>{explanation}</p> : null}
  </>;
}

function GuestDraftExports({ snapshot, recovered, onExport }: Readonly<{
  snapshot: GuestDraftSnapshot | null;
  recovered: boolean;
  onExport: (raw: string, name: string) => void;
}>) {
  if (snapshot === null) return null;
  return <>
    <DraftCopyExport raw={snapshot.retainedRaw} name="blast-retained-draft.json" label="Export retained draft" onExport={onExport} />
    <DraftCopyExport raw={snapshot.canonicalRaw} name="blast-versioned-draft.json" label="Export versioned draft" onExport={onExport} />
    {!recovered && snapshot.canonicalRaw !== null ? <p>
      Export the versioned copy for review. Existing copies will not be
      overwritten. If both copies exist, export both.
    </p> : null}
  </>;
}

function DraftCopyExport({ raw, name, label, onExport }: Readonly<{
  raw: string | null;
  name: string;
  label: string;
  onExport: (raw: string, name: string) => void;
}>) {
  if (raw === null) return null;
  return <Button variant="secondary" size="sm" className="btn btn-quiet btn-sm" type="button" onClick={() => onExport(raw, name)}>{label}</Button>;
}
