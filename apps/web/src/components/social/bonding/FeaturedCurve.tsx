"use client";

import { coinPagePath } from "@blast/core/modules/launchpad-coin/page-key.ts";
import { useQuery } from "@tanstack/react-query";

import { CoinMark } from "#web/components/blast-ui/CoinMark.tsx";
import { CoinVerifiedMark } from "#web/components/blast-ui/Icons.tsx";
import { IntentLink } from "#web/components/blast-ui/NavigationLink.tsx";
import {
  compactQuoteAmount,
  quoteSymbol,
} from "#web/components/launchpad/discovery/discovery-model.ts";
import { readableUsd } from "#web/lib/market-format.ts";
import { queryKeys } from "#web/lib/query/keys.ts";
import { useAppQueryClient } from "#web/lib/query/provider.tsx";
import { bpsPercent } from "@blast/core/lib/bps.ts";
import type { LaunchPageDetails } from "@blast/core/modules/launchpad-coin/transfer.ts";
import type {
  DiscoveryMetrics,
  DiscoveryRow,
} from "@blast/core/modules/launchpad-discovery/rows.ts";

import { shortCoinType } from "../coins/coin-display.ts";
import { readBondingLaunchDetails } from "./bonding-client.ts";
import styles from "./bonding.module.css";

/** The featured carousel's bonding-curve slide, shared by the Bonding board and Home (kept apart so Home does not load the board). */
export function FeaturedCurve({
  row,
  featured,
  metrics,
  seed,
  className,
}: Readonly<{
  row: DiscoveryRow;
  featured: boolean;
  metrics?: DiscoveryMetrics;
  /** The server's read of this launch's details; undefined when it has none. */
  seed?: LaunchPageDetails | null;
  /** Home lays the slide on its carousel's surface. */
  className?: string;
}>) {
  const client = useAppQueryClient();
  const details = useQuery(
    {
      queryKey: queryKeys.bonding.launch(row.launchId),
      queryFn: ({ signal }) => readBondingLaunchDetails(row.launchId, signal),
      initialData: seed,
      staleTime: Infinity,
      retry: false,
    },
    client,
  );
  const title = row.name ?? row.symbol ?? shortCoinType(row.coinType);
  const cover = details.data?.cover;
  return (
    <IntentLink className={className ? `${styles.featured} ${className}` : styles.featured} data-list-row={`featured:${row.launchId}`} data-has-cover={!!cover || undefined} href={coinPagePath(row.coinType)}>
      {cover ? <span className={styles.cover}>
        {/* Published uploads are sanitized WebP files. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            alt=""
            height={cover.height}
            src={cover.url}
            width={cover.width}
          />
      </span> : null}
      <span className={styles.featuredBody}>
        <span className={styles.head}>
          <CoinMark
            coin={{
              key: row.coinType,
              coinType: row.coinType,
              iconUrl: row.iconUrl,
              round: false,
            }}
            size={55}
          />
          <span className={styles.featuredTitle}>
            <span>
              {featured ? "Featured curve" : "Closest to graduation"}
              {row.progressBps !== null
                ? ` · ${bpsPercent(row.progressBps)}${featured ? " to graduation" : ""}`
                : ""}
            </span>
            {/* The last word and the mark wrap as one box, so the mark never takes a line alone. */}
            <b>
              {row.verifiedTeam ? (
                <>
                  {title.trimEnd().slice(0, title.trimEnd().lastIndexOf(" ") + 1)}
                  <span className={styles.markTail}>
                    <span>{title.trimEnd().slice(title.trimEnd().lastIndexOf(" ") + 1)}</span>{" "}
                    <CoinVerifiedMark size="lg" />
                  </span>
                </>
              ) : (
                title
              )}
            </b>
          </span>
        </span>
        {details.data?.tagline ? (
          <span className={styles.tagline}>{details.data.tagline}</span>
        ) : null}
        {row.quoteRemaining !== null ? (
          <span className={styles.featuredRaise}>
            {compactQuoteAmount(row.quoteRemaining, row.quoteDecimals, row.quoteType)}{" "}
            {quoteSymbol(row.quoteType)} <small>to graduate</small>
          </span>
        ) : null}
        {row.progressBps !== null ? (
          <progress
            aria-label="Progress to graduation"
            className={styles.bar}
            max={10_000}
            value={row.progressBps}
          />
        ) : null}
        <MarketMetrics metrics={metrics} />
      </span>
    </IntentLink>
  );
}

export function MarketMetrics({ metrics, className }: Readonly<{ metrics?: DiscoveryMetrics; className?: string }>) {
  if (
    !metrics ||
    (metrics.holders === null && metrics.market?.fdv_usd == null)
  ) {
    return null;
  }
  return (
    <span className={className ? `${styles.figures} ${className}` : styles.figures}>
      {metrics.market?.fdv_usd != null ? (
        <span>
          FDV <b className="num">{readableUsd(metrics.market.fdv_usd)}</b>
        </span>
      ) : null}
      {metrics.holders !== null ? (
        <span>
          Holders <b className="num">{metrics.holders.toLocaleString("en-US")}</b>
        </span>
      ) : null}
    </span>
  );
}
