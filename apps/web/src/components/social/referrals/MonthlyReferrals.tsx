"use client";

import { explorerTransactionUrl } from "@blast/core/lib/explorer.ts";
import type { ReferralStatement } from "@blast/core/modules/social/referrals/contracts.ts";
import { exactAtoms, groupedExact } from "@blast/core/web/exact-amount.ts";
import { NO_VALUE } from "@blast/core/web/format.ts";
import { EmptyState } from "#web/components/blast-ui/EmptyState.tsx";
import { TransactionLink } from "#web/components/blast-ui/TransactionLink.tsx";
import { useDevicePrefs } from "#web/components/blast-ui/device-prefs.ts";
import styles from "./MonthlyReferrals.module.css";

const monthFormatter = new Intl.DateTimeFormat("en-GB", { month: "short", year: "numeric", timeZone: "UTC" });

function sui(atoms: string | null): string {
  const amount = atoms === null ? null : exactAtoms(atoms, 9);
  return amount ? groupedExact(amount, amount.scale) : NO_VALUE;
}

export function MonthlyReferrals({ months }: Readonly<{ months: readonly ReferralStatement[] }>) {
  const { explorer } = useDevicePrefs();
  if (!months.length) return <EmptyState framed title="No referral payments yet" />;

  return (
    <div className={`card ${styles.statement}`}>
      <table aria-label="Monthly referral payments">
        <thead>
          <tr>
            <th scope="col">Month</th>
            <th scope="col">SUI contributed</th>
            <th scope="col">Share</th>
            <th scope="col">SUI paid</th>
            <th scope="col" className={styles.link}><span className="sr">Transaction</span></th>
          </tr>
        </thead>
        <tbody>
          {months.map(({ month, revenue_atoms, share_bps, payment }) => {
            const date = monthFormatter.format(new Date(`${month}-01T00:00:00Z`));
            const href = payment && explorerTransactionUrl(explorer, payment.digest);
            return (
              <tr key={month}>
                <th scope="row"><time dateTime={month}>{date}</time></th>
                <td className="num">{sui(revenue_atoms)}</td>
                <td className="num">{share_bps === null ? NO_VALUE : `${share_bps / 100}%`}</td>
                <td className={payment ? "num" : undefined}>{payment ? sui(payment.amount_atoms) : !revenue_atoms || revenue_atoms === "0" ? NO_VALUE : "Pending"}</td>
                <td className={styles.link}>{href ? <TransactionLink href={href} label={`View ${date} payment transaction`} /> : null}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
