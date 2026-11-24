import { CoinTypeTag } from "#web/components/blast-ui/CoinTypeTag.tsx";
import { InspectValue } from "#web/components/blast-ui/InspectValue.tsx";
import { SkeletonText } from "#web/components/blast-ui/Skeleton.tsx";
import type { HomeActivity } from "@blast/core/web/contracts/home.ts";
import type { CoinAsset, CoinRecord } from "./coin-reads";
import styles from "./CoinInformation.module.css";

/** Secondary coin facts reuse the selected market read, without another request. */
export function CoinInformation({
  asset,
  coin,
  pending = false,
  compact = false,
}: Readonly<{ asset: CoinAsset; coin: CoinRecord | null; pending?: boolean; compact?: boolean }>) {
  const loading = pending && !coin;
  const hasActivity = coin?.activity?.scope === "pool" && coin.activity.window === "24h";
  if (compact && !loading && !hasActivity) return null;
  return (
    <section
      className={styles.information}
      aria-label="Current coin information"
      aria-busy={loading || undefined}
      data-compact={compact || undefined}
    >
      {loading && <span role="status" className="sr">Loading coin information</span>}
      {compact && <CoinInformationHeading />}
      <CoinActivity activity={coin?.activity} loading={loading} compact={compact} />
      {!compact && <>
        <CoinMetadata asset={asset} coin={coin} loading={loading} />
        <CoinTypeTag coinType={asset.coin_type} />
      </>}
    </section>
  );
}


function CoinInformationHeading() {
  return <header className={styles.heading}>
    <h2>Activity</h2>
    <span className={styles.coverage}>All venues · 24h</span>
  </header>;
}

function CoinActivity({ activity, loading, compact }: Readonly<{
  activity: HomeActivity | null | undefined;
  loading: boolean;
  compact: boolean;
}>) {
  const pool = activity?.scope === "pool" && activity.window === "24h" ? activity : null;
  if (!loading && !pool) return null;
  return <section aria-label="24-hour activity" className={styles.activity}>
    {!compact && <h3>All venues · 24h</h3>}
    <dl className={styles.activityFacts}>
      <div><dt>Buyers</dt><dd><ParticipantCount activity={pool} loading={loading} side="buyers" /></dd></div>
      <div><dt>Sellers</dt><dd><ParticipantCount activity={pool} loading={loading} side="sellers" /></dd></div>
    </dl>
  </section>;
}

function ParticipantCount({ activity, loading, side }: Readonly<{
  activity: HomeActivity | null;
  loading: boolean;
  side: "buyers" | "sellers";
}>) {
  if (loading) return <SkeletonText>000</SkeletonText>;
  if (!activity) return null;
  const count = activity[side];
  return <InspectValue label={`24h ${side}`} value={`${count.toLocaleString("en-US")} distinct participants. Indexed trades on every venue from ${new Date(activity.from_ms).toISOString()} to ${new Date(activity.to_ms).toISOString()}. A participant may both buy and sell.`}>
    {count.toLocaleString("en-US", { notation: "compact", maximumFractionDigits: 1 })}
  </InspectValue>;
}

function CoinMetadata({ asset, coin, loading }: Readonly<{
  asset: CoinAsset;
  coin: CoinRecord | null;
  loading: boolean;
}>) {
  return <dl className={styles.metadata}>
    <div>
      <dt>Network</dt>
      <dd>Sui · {asset.network}</dd>
    </div>
    {(loading || coin?.decimals != null) && <div>
      <dt>Decimals</dt>
      <dd>{loading ? <SkeletonText>00</SkeletonText> : coin?.decimals}</dd>
    </div>}
  </dl>;
}
