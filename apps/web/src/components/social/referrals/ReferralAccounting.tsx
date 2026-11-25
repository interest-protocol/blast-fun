import { shortUtcDate } from "#web/components/blast-ui/date-label.ts";
import type {
  ReferralAccounting as Accounting,
  ReferralAsset,
} from "@blast/core/modules/social/referrals/contracts.ts";
import { exactAtoms, groupedExact } from "@blast/core/web/exact-amount.ts";
import { EmptyState } from "#web/components/blast-ui/EmptyState.tsx";
import { InspectValue } from "#web/components/blast-ui/InspectValue.tsx";
import { shortCoinType, shortTicker } from "../coins/coin-display.ts";
import styles from "./ReferralAccounting.module.css";

function Amount({
  asset,
  field,
  identity,
}: Readonly<{
  asset: ReferralAsset;
  field: "volume_atoms" | "revenue_atoms" | "earnings_atoms";
  identity?: string;
}>) {
  const amount = exactAtoms(asset[field], asset.decimals);
  if (!amount) return <>Amount unavailable</>;
  const formatted = groupedExact(amount, amount.scale);
  const ticker = shortTicker(asset.symbol);
  const value = ticker ? `${formatted} ${ticker}` : formatted;
  const copyAmount = asset.symbol ? `${formatted} ${asset.symbol}` : formatted;
  return (
    <InspectValue
      label="amount"
      value={value}
      triggerLabel={identity ? `Inspect ${value}. ${identity}` : `Inspect ${value}`}
      description={identity}
      copyValue={`${copyAmount}\n${asset.coin_type}`}
    >
      {value}
    </InspectValue>
  );
}

/** Owner-only lifetime totals. Native coin amounts are never mixed or converted using today's price. */
export function ReferralAccounting({
  accounting,
  compact = false,
}: Readonly<{ accounting: Accounting; compact?: boolean }>) {
  const rate = !compact && <p className={styles.note}>Current referral rate {accounting.share_bps / 100}%</p>;
  if (accounting.as_of_ms === null)
    return <>
      {rate}
      <p className={styles.note} role="status">
        Updating referral earnings
      </p>
    </>;
  const cutoff = new Date(accounting.as_of_ms);
  const hasAssets = accounting.assets.length > 0;
  const pending = accounting.pending_events > 0;
  const emptyLabel = pending ? "Checking referral earnings" : "No referral earnings yet";

  return (
    <div className={styles.accounting}>
      {hasAssets ? (
        accounting.assets.map((asset) => {
          const symbol = shortTicker(asset.symbol)?.toLowerCase();
          const ambiguous = !symbol || accounting.assets.some(
            (other) => other.coin_type !== asset.coin_type && shortTicker(other.symbol)?.toLowerCase() === symbol,
          );
          const identity = ambiguous ? shortCoinType(asset.coin_type.replace(/\s+/g, "")) : undefined;
          return <dl className={styles.metrics} key={asset.coin_type}>
            <div>
              <dt>Referred volume</dt>
              <dd className="num">
                <Amount asset={asset} field="volume_atoms" identity={identity} />
              </dd>
            </div>
            <div>
              <dt>Blast revenue</dt>
              <dd className="num">
                <Amount asset={asset} field="revenue_atoms" identity={identity} />
              </dd>
            </div>
            <div>
              <dt>Earnings</dt>
              <dd className="num">
                <Amount asset={asset} field="earnings_atoms" identity={identity} />
              </dd>
            </div>
          </dl>;
        })
      ) : !compact ? (
        <EmptyState title={emptyLabel}>
          {pending ? null : "Earn from trade and presale fees."}
        </EmptyState>
      ) : (
        <p className={styles.note}>{emptyLabel}</p>
      )}
      {!compact && <>
        {rate}
        {Number.isFinite(cutoff.getTime()) && <p className={styles.note}>
          Lifetime totals through <time dateTime={cutoff.toISOString().slice(0, 10)}>{shortUtcDate(cutoff)}</time>
        </p>}
        <p className={styles.note}>Manual payments each month.</p>
      </>}
      {hasAssets && pending && (
        <p className={styles.note}>Totals exclude activity under review.</p>
      )}
    </div>
  );
}
