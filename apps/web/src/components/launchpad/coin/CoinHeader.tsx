import { shortAddress as shortId, venueName } from "@blast/core/lib/format.ts";
import type { CoinPage } from "@blast/core/modules/launchpad-coin/contracts.ts";
import type { ExpectedDeployment } from "@blast/core/modules/launchpad-contract/provenance.ts";

import { Glyph } from "../primitives/Glyph";
import { MetadataIcon } from "../primitives/MetadataIcon";
import styles from "./Coin.module.css";
import { MarketState, MarketStats } from "./CoinMarketStats";
import { coinIdentity, LIFECYCLE_LABEL, pageLifecycle, sectionData } from "./coin-view";

/**
 * The market slot: the selected coin's identity (the page h1), its
 * permanent launch ID, creator, lifecycle and venue, and the selected
 * source's market facts, marked Stale or Unavailable when blast-infra could
 * not answer. A lifecycle conflict names both sources and which one decides.
 */
export function CoinHeader({ page, expected }: Readonly<{ page: CoinPage; expected?: ExpectedDeployment | null }>) {
  const identity = coinIdentity(page);
  const coin = sectionData(page.coin);
  const lifecycle = pageLifecycle(page);
  const venue =
    page.source.kind === "venue" ? `${venueName(page.source.venue)} pool` : venueName("blast_curve");

  return (
    <div className={styles.header}>

      <div className={styles.identity}>
        <MetadataIcon src={identity.iconUrl} identity={identity.coinType ?? page.launchId} size={40} />
        <div className={styles.identityText}>
          <h1 className={styles.title}>{identity.name ?? identity.symbol}</h1>
          <p className={styles.pair}>
            {identity.symbol} / {identity.quoteSymbol}
          </p>
        </div>
      </div>
      {page.confirmed ? (
        <p className={styles.meta}>
          <span>{coin?.creator ? `Launched by ${shortId(coin.creator)}` : "Creator unknown"}</span>
          <span className={styles.lifecycle}>{lifecycle ? LIFECYCLE_LABEL[lifecycle] : "Lifecycle unknown"}</span>
          <span>{venue}</span>
        </p>
      ) : (
        <p className={styles.conflict} role="status">
          <Glyph shape="slashed-ring" />
          <span>
            Launch details couldn’t be confirmed. This page refreshes automatically.
          </span>
        </p>
      )}

      <MarketStats page={page} expected={expected} />
      <MarketState page={page} />

      <p className={styles.launchId}>
        <span className={styles.eyebrow}>Launch ID</span> <code>{page.launchId}</code>
      </p>

      {page.conflict ? (
        <p className={styles.conflict} role="status">
          <Glyph shape="diamond" />
          <span>
            The launch is now {LIFECYCLE_LABEL[page.conflict.fresh]}. Market details may take a moment to update.
          </span>
        </p>
      ) : null}
    </div>
  );
}
