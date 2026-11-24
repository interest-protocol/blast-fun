import type { ReactNode } from "react";

import { Disclosure } from "#web/components/blast-ui/Disclosure.tsx";
import styles from "./Holders.module.css";

export function HolderSummary({ rows, shareNote, children }: Readonly<{
  rows: readonly Readonly<{
    key: string;
    holder: ReactNode;
    balance: ReactNode;
    share: ReactNode;
  }>[];
  shareNote: string;
  children: ReactNode;
}>) {
  return <>
    {rows.length > 0 && <>
      <ol className={styles.compactList} aria-label="Largest holders by balance">
        {rows.map(({ key, holder, balance, share }) => <li key={key}>
          <span className={styles.holderIdentity}>{holder}</span>
          <span className={styles.holderFigures}>
            <b>{balance}</b>{share != null && <small>{share}</small>}
          </span>
        </li>)}
      </ol>
      <p className={styles.note}>{shareNote}</p>
    </>}
    <Disclosure title="View all holders">{children}</Disclosure>
  </>;
}
