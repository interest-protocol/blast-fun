"use client";

import { useState } from "react";
import { CopyButton } from "#web/components/blast-ui/CopyButton.tsx";
import { ReviewDisclosure } from "./ReviewDisclosure";
import styles from "./CreationReview.module.css";

export function ReviewIdentifier({ label, value, coinType = false }: Readonly<{
  label: string;
  value: string;
  coinType?: boolean;
}>) {
  const [copyError, setCopyError] = useState(false);
  const short = coinType
    ? value.replace(/^([^:]{10})[^:]+(?=::)/, "$1…")
    : `${value.slice(0, 8)}…${value.slice(-6)}`;
  const role = label === "Who can cancel" ? "cancellation authority" : label.toLowerCase().replace(" wallet", "");
  const copyLabel = coinType ? "Copy full coin type" : `Copy ${role} address`;
  return (
    <div className={styles.identifier}>
      <ReviewDisclosure className={styles.identifierDisclosure} ariaLabel={`Show full ${label.toLowerCase()}`}
        label={<><span className={styles.identifierLabel}>{label}</span><code>{short}</code></>}>
        <code className={styles.fullIdentifier}>{value}</code>
      </ReviewDisclosure>
      <span className={styles.copyControl}>
        <CopyButton className={styles.copy} label={copyLabel} onCopy={async () => {
          setCopyError(false);
          try {
            await navigator.clipboard.writeText(value);
            return true;
          } catch {
            setCopyError(true);
            return false;
          }
        }} />
        <span className={styles.tooltip} role="tooltip">{copyLabel}</span>
      </span>
      <span className={styles.copyError} role="status">
        {copyError ? "Couldn’t copy. Open the full value to select and copy it." : ""}
      </span>
    </div>
  );
}
