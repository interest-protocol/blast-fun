"use client";

import { explorerTransactionUrl } from "@blast/core/lib/explorer.ts";
import type { ReferralStatement } from "@blast/core/modules/social/referrals/contracts.ts";
import { exactAtoms, groupedExact } from "@blast/core/web/exact-amount.ts";
import { NO_VALUE } from "@blast/core/web/format.ts";
import { AmountFit } from "#web/components/blast-ui/AmountFit.tsx";
import { ButtonLink } from "#web/components/blast-ui/Button.tsx";
import { EmptyState } from "#web/components/blast-ui/EmptyState.tsx";
import { CheckIcon, ExternalIcon } from "#web/components/blast-ui/Icons.tsx";
import { useDevicePrefs } from "#web/components/blast-ui/device-prefs.ts";
import styles from "./MonthlyReferrals.module.css";

const monthFormatter = new Intl.DateTimeFormat("en-GB", { month: "long", year: "numeric", timeZone: "UTC" });

function SuiAmount({ atoms, fit = false }: Readonly<{ atoms: string | null; fit?: boolean }>) {
  const amount = atoms === null ? null : exactAtoms(atoms, 9);
  if (!amount) return NO_VALUE;
  const number = groupedExact(amount, amount.scale);
  const value = <>{number}&nbsp;<span className={styles.unit}>SUI</span></>;
  return fit ? <AmountFit value={`${number} SUI`}><span className={styles.fitAmount}>{value}</span></AmountFit> : value;
}

export function MonthlyReferrals({ months }: Readonly<{ months: readonly ReferralStatement[] }>) {
  const { explorer } = useDevicePrefs();
  if (!months.length) return <EmptyState framed title="No referral payments yet" />;

  return (
    <ul className={styles.months} role="list" aria-label="Monthly referral payments">
      {months.map(({ month, revenue_atoms, earnings_atoms, share_bps, payment }) => {
        const date = monthFormatter.format(new Date(`${month}-01T00:00:00Z`));
        const href = payment && explorerTransactionUrl(explorer, payment.digest);
        return (
          <li key={month} className={`card ${styles.month}`}>
            <div className={styles.heading}>
              <h2><time dateTime={month}>{date}</time></h2>
              <p className={`status ${styles.status}`} data-tone={payment ? "delivered" : earnings_atoms === "0" ? "cancelled" : "neutral"}>
                {payment ? <><CheckIcon /> Paid</> : earnings_atoms === "0" ? "No payout due" : "Not yet paid"}
              </p>
            </div>
            <dl className={styles.figures}>
              <div>
                <dt>SUI contributed</dt>
                <dd><SuiAmount atoms={revenue_atoms} fit /></dd>
              </div>
              <div>
                <dt>Your share{share_bps === null ? "" : ` · ${share_bps / 100}%`}</dt>
                <dd className={styles.earnings}><SuiAmount atoms={earnings_atoms} fit /></dd>
              </div>
            </dl>
            {payment ? (
              <div className={styles.payment}>
                <p className={styles.paidAmount}><SuiAmount atoms={payment.amount_atoms} /> received</p>
                {href ? <ButtonLink
                  aria-label={`View transaction for ${date}`}
                  href={href}
                  rel="noopener noreferrer"
                  size="lg"
                  target="_blank"
                  variant="ghost"
                >
                  Transaction <ExternalIcon />
                </ButtonLink> : null}
              </div>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}
