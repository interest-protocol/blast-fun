"use client";
import { PendingStatus } from "#web/components/blast-ui/Skeleton.tsx";
import { Button } from "#web/components/blast-ui/Button.tsx";

import workspaceStyles from "./WorkspaceHost.module.css";
import { useId, useRef, type ReactNode } from "react";
import {
  Sheet,
  SheetClose,
  SheetHeading,
  SheetCta,
} from "#web/components/blast-ui/Sheet.tsx";

export type ActionPreference =
  | Readonly<{ status: "ready"; enabled: boolean }>
  | Readonly<{ status: "pending" }>
  | Readonly<{ status: "error"; retry?: () => void }>;

export function PreferenceStatus({
  preference,
}: Readonly<{ preference?: ActionPreference }>) {
  if (preference?.status === "ready") return null;
  if (preference?.status === "error")
    return (
      <p role="alert">
        Your action preference could not load. Your draft is kept.{" "}
        <Button variant="secondary" size="sm"

          type="button"
          onClick={preference.retry}
        >
          Retry settings
        </Button>
      </p>
    );
  return <PendingStatus label="Loading action preference" />;
}

/** One additional application review; the existing kits retain all signing authority. */
export function ActionConfirmation({
  open,
  busy,
  valid,
  action,
  asset,
  children,
  onCancel,
  onConfirm,
}: Readonly<{
  open: boolean;
  busy: boolean;
  valid: boolean;
  action: string;
  asset: string;
  children: ReactNode;
  onCancel: () => void;
  onConfirm: () => void;
}>) {
  const id = useId();
  const cancel = useRef<HTMLButtonElement>(null);
  return (
    <Sheet
      className={workspaceStyles.tradeSheet}
      open={open}
      labelledBy={id}
      onRequestClose={onCancel}
      initialFocus={() => cancel.current}
      hasCta
    >
      <SheetClose onClick={onCancel} />
      <SheetHeading
        id={id}
        title={`Confirm ${action} · ${asset}`}
      />
      {children}
      {!valid && !busy && (
        <p role="status">
          The facts or account changed. Cancel and review the updated action.
          Nothing was sent.
        </p>
      )}
      <SheetCta>
        <Button variant="primary" size="sm"

          data-action-confirm=""
          type="button"
          disabled={busy || !valid}
          loading={busy}
          loadingLabel="Checking action"
          onClick={onConfirm}
        >
          Confirm {action}
        </Button>
        <Button variant="secondary" size="sm"
          ref={cancel}

          data-action-cancel=""
          type="button"
          onClick={onCancel}
        >
          Cancel
        </Button>
      </SheetCta>
    </Sheet>
  );
}
