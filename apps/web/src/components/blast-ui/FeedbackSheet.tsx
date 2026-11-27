"use client";

import { FEEDBACK_MESSAGE_LIMIT, type FeedbackKind } from "@blast/core/web/contracts/feedback.ts";
import { useEffect, useId, useRef, useState, type FormEvent } from "react";

import { gatedFetch } from "#web/lib/api-gate-client.ts";
import { diagnosticMessage, responseDiagnostic } from "#web/lib/errors.ts";
import { Button } from "./Button";
import { DiagnosticText } from "./DiagnosticText";
import styles from "./FeedbackSheet.module.css";
import { Segmented, type SegmentedOption } from "./Segmented";
import { Sheet, SheetClose, SheetHeading } from "./Sheet";
import { TextArea } from "./TextField";

const KINDS: readonly SegmentedOption<FeedbackKind>[] = [
  ["feature_request", "Feature request"],
  ["feedback", "Feedback"],
];
const EMPTY_DRAFT: Readonly<{ kind: FeedbackKind; message: string; sent: boolean }> = {
  kind: "feature_request",
  message: "",
  sent: false,
};

export function FeedbackSheet({ open, onClose }: Readonly<{ open: boolean; onClose: () => void }>) {
  const titleId = useId();
  const messageId = useId();
  const field = useRef<HTMLTextAreaElement>(null);
  const closed = useRef(!open);
  const submissionId = useRef<string | null>(null);
  const [draft, setDraft] = useState(EMPTY_DRAFT);
  const { kind, message, sent } = draft;
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (open) closed.current = false;
  }, [open]);

  function clearAttempt() {
    submissionId.current = null;
    setError("");
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (sending) return;
    const text = message.trim();
    if (!text) {
      field.current?.setCustomValidity("Write a short message.");
      field.current?.reportValidity();
      return;
    }

    setSending(true);
    setError("");
    try {
      const id = submissionId.current ?? crypto.randomUUID();
      submissionId.current = id;
      const response = await gatedFetch("/api/feedback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, kind, message: text }),
        signal: AbortSignal.timeout(15_000),
      });
      if (response.status === 204) {
        submissionId.current = null;
        const showConfirmation = !closed.current;
        setDraft((current) => showConfirmation ? { ...current, sent: true } : EMPTY_DRAFT);
      } else {
        const copy = response.status === 429
          ? "You’ve sent several messages. Wait a moment and try again."
          : "Your message couldn’t be sent. Try again.";
        setError(diagnosticMessage(copy, { ...responseDiagnostic(response), code: `http_${response.status}` }));
      }
    } catch {
      setError(diagnosticMessage("Your message couldn’t be sent. Try again.", { code: "network_unavailable" }));
    }
    setSending(false);
  }

  function resetAfterClose() {
    closed.current = true;
    setDraft((current) => current.sent ? EMPTY_DRAFT : current);
  }

  return (
    <Sheet labelledBy={titleId} open={open} onRequestClose={onClose} onClosed={resetAfterClose}>
      <SheetClose onClick={onClose} />
      {sent ? (
        <>
          <div role="status">
            <SheetHeading id={titleId} title="Thanks, we got it." />
          </div>
          <Button ref={focusDone} size="lg" variant="primary" onClick={onClose}>Done</Button>
        </>
      ) : (
        <>
          <SheetHeading id={titleId} title="Send feedback" />
          <form action="/api/feedback" method="post" aria-labelledby={titleId} className={styles.form} onSubmit={submit}>
            <Segmented
              label="Message type"
              options={KINDS}
              value={kind}
              disabled={sending}
              onChange={(next) => { setDraft({ ...draft, kind: next }); clearAttempt(); }}
              size="touch"
              stretch
            />
            <div className={styles.field}>
              <label htmlFor={messageId}>Message</label>
              <TextArea
                id={messageId}
                name="message"
                ref={field}
                value={message}
                onChange={(event) => {
                  event.currentTarget.setCustomValidity("");
                  setDraft({ ...draft, message: event.currentTarget.value });
                  clearAttempt();
                }}
                placeholder={kind === "feature_request" ? "What would you like to see in Blast?" : "What would you like us to know?"}
                maxLength={FEEDBACK_MESSAGE_LIMIT}
                readOnly={sending}
                required
                rows={4}
              />
              {error ? <p className={styles.error} role="alert"><DiagnosticText message={error} /></p> : null}
            </div>
            <Button loading={sending} loadingLabel="Sending feedback" size="lg" type="submit" variant="primary">
              Send
            </Button>
          </form>
        </>
      )}
    </Sheet>
  );
}

function focusDone(button: HTMLButtonElement | null) {
  button?.focus({ preventScroll: true });
}
