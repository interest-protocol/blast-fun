"use client";

import clsx from "clsx";

import { CheckIcon } from "#web/components/blast-ui/Icons.tsx";
import { CALLSIGN_MAX_LENGTH, callsignMessage, type CallsignCheck } from "./onboarding-flow";
import styles from "./Onboarding.module.css";

export function CallsignField({ value, check, disabled = false, onChange }: Readonly<{
  value: string;
  check: CallsignCheck;
  disabled?: boolean;
  onChange: (value: string) => void;
}>) {
  const message = callsignMessage(check);
  return (
    <div className={styles.field}>
      <label htmlFor="blast-callsign">Call sign</label>
      <div className={styles.input}>
        <span aria-hidden="true" className={styles.pre}>@</span>
        <input aria-describedby="blast-callsign-message" aria-invalid={message.tone === "bad" || undefined}
          autoCapitalize="off" autoComplete="off" id="blast-callsign" maxLength={CALLSIGN_MAX_LENGTH}
          onChange={(event) => onChange(event.target.value)} readOnly={disabled} spellCheck={false} value={value} />
        <span className={styles.status}>{check.status === "checking" ? <span aria-hidden="true" className={styles.spin} /> : null}</span>
      </div>
      <span aria-live="polite" className={clsx(styles.msg, message.tone === "ok" && styles.ok, message.tone === "bad" && styles.bad)} id="blast-callsign-message">
        {message.tone === "ok" ? <CheckIcon /> : null}{message.text}
      </span>
    </div>
  );
}
