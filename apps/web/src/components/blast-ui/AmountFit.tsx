"use client";

import { useId, type ReactNode } from "react";
import { useStyleNonce } from "../ui-libraries/style-nonce.tsx";
import styles from "./AmountFit.module.css";

/** Give the amount the actual space left beside its coin and keep the native input intact. */
export function AmountFit({ value, children }: Readonly<{ value: string; children: ReactNode }>) {
  const id = useId();
  const nonce = useStyleNonce();
  // Tabular digits take more room than grouping and decimal separators.
  const separators = value.match(/[,.]/g)?.length ?? 0;
  const width = Math.max(1, (value.length - separators) * 0.68 + separators * 0.34);
  return (
    <div className={styles.amountFit} data-amount-fit={id}>
      <style nonce={nonce}>{`[data-amount-fit="${id}"] { --amount-em-width: ${width}; }`}</style>
      {children}
    </div>
  );
}
