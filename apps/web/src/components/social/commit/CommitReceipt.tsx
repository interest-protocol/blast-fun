"use client";

import { useEffect, useRef } from "react";
import { CheckIcon, ExternalIcon } from "#web/components/blast-ui/Icons.tsx";
import { IntentLink } from "#web/components/blast-ui/NavigationLink.tsx";
import type { ContributionReceipt } from "./commit-receipt";
import styles from "./commit.module.css";

export function CommitReceipt({ receipt, onDone, titleId }: Readonly<{ receipt: ContributionReceipt; onDone: () => void; titleId?: string }>) {
  const done = useRef<HTMLButtonElement>(null);
  const announcement = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    done.current?.focus({ preventScroll: true });
    // Register the empty live region before announcing the completed transaction once.
    const frame = requestAnimationFrame(() => {
      if (announcement.current) announcement.current.textContent = `Your contribution of ${receipt.amount} ${receipt.currency} to the ${receipt.symbol} presale is confirmed.`;
    });
    return () => cancelAnimationFrame(frame);
  }, [receipt]);
  return <div className={styles.receipt} data-contribution-receipt="">
    <span className="sr-only" role="status" aria-atomic="true" ref={announcement} />
    <span className={styles.receiptCheck} aria-hidden="true"><CheckIcon /></span>
    <h2 id={titleId}>You’re in!</h2>
    <p>Your contribution of <strong>{receipt.amount} {receipt.currency}</strong> to the <strong>{receipt.symbol}</strong> presale is confirmed.</p>
    <div className={styles.receiptActions}>
      <IntentLink className="btn btn-line btn-lg" href={`/presale/${receipt.presaleId}`} onClick={onDone}>View presale</IntentLink>
      <button className="btn btn-primary btn-lg" onClick={onDone} ref={done} type="button">Done</button>
    </div>
    {receipt.href ? <a className={styles.sheetLink} href={receipt.href} target="_blank" rel="noopener noreferrer">View transaction<ExternalIcon /></a> : null}
  </div>;
}
