"use client";

import { useDevicePrefs } from "#web/components/blast-ui/device-prefs.ts";
import { EXPLORER_NAMES, explorerTransactionUrl } from "@blast/core/lib/explorer.ts";
import styles from "./commit.module.css";

export function CommitPendingNotice({ pending }: Readonly<{ pending: Readonly<{ message: string; digest?: string }> | null }>) {
  const { explorer } = useDevicePrefs();
  const href = pending?.digest ? explorerTransactionUrl(explorer, pending.digest) : null;
  return pending === null ? null : <p className={styles.note} data-commit-pending="" role="status">
    {pending.message}{href ? <> <a href={href} target="_blank" rel="noreferrer">View on {EXPLORER_NAMES[explorer]}</a></> : null}
  </p>;
}
