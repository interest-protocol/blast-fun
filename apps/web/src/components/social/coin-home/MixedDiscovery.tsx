"use client";

import { useQuery } from "@tanstack/react-query";

import { Button } from "#web/components/blast-ui/Button.tsx";
import { CoinMark } from "#web/components/blast-ui/CoinMark.tsx";
import { EmptyState } from "#web/components/blast-ui/EmptyState.tsx";
import { CoinLegacyMark, CoinVerifiedMark } from "#web/components/blast-ui/Icons.tsx";
import { IntentLink } from "#web/components/blast-ui/NavigationLink.tsx";
import { PendingPanel } from "#web/components/blast-ui/PendingPanel.tsx";
import { useAppQueryClient } from "#web/lib/query/provider.tsx";
import type { SocialHappeningResponse } from "@blast/core/web/contracts/happening.ts";
import type { HomeCoinsPage, HomeQuery } from "@blast/core/web/contracts/home.ts";

import { bondingCatalogQuery } from "../bonding/bonding-client.ts";
import { happeningStore } from "../happening/happening-store.ts";
import { useHappening } from "../happening/use-happening.ts";
import { discoverQuery } from "./home-client.ts";
import { mixedDiscoveryEntries, type MixedDiscoveryEntry } from "./mixed-discovery.ts";
import { useHomeLive } from "./use-home-live.ts";
import styles from "./CoinHome.module.css";

const closestQuery = bondingCatalogQuery("bonding", "progress", "", null);
const freshQuery = bondingCatalogQuery("bonding", "newest", "", null);

export function MixedDiscovery({ initial, query, happening, now, onRankings }: Readonly<{
  initial: HomeCoinsPage | null | Promise<HomeCoinsPage | null>;
  query: HomeQuery;
  happening: SocialHappeningResponse | null;
  now: number;
  onRankings: () => void;
}>) {
  const client = useAppQueryClient();
  const pendingSeed = initial && "then" in initial ? initial : undefined;
  const market = useQuery({
    ...discoverQuery(query, true, pendingSeed),
    initialData: initial && !("then" in initial) ? initial : undefined,
  }, client);
  const closest = useQuery(closestQuery, client);
  const fresh = useQuery(freshQuery, client);
  useHomeLive(query, !market.isPending, undefined, undefined, () => Promise.allSettled([
    client.fetchQuery(closestQuery),
    client.fetchQuery(freshQuery),
  ]));
  const sales = useHappening(happening);
  const queries = [market, closest, fresh];
  const errors = queries.filter(query => query.isError);
  const retry = () => {
    for (const query of errors) void query.refetch();
    if (sales.failed) void happeningStore().refresh();
  };
  const failed = errors.length > 0 || sales.failed === true;
  const staleCurves = closest.data?.section.state === "stale" || fresh.data?.section.state === "stale";
  const latestHappening = sales.read ?? happening;
  const entries = mixedDiscoveryEntries({ market: market.data?.coins ?? [], closest: closest.data, fresh: fresh.data, happening: latestHappening, now });
  const pending = queries.some(query => query.isPending) || !(latestHappening || sales.failed);
  return <DiscoveryResults entries={entries} pending={pending} failed={failed} staleCurves={staleCurves} onRetry={retry} onRankings={onRankings} />;
}

function DiscoveryResults({ entries, pending, failed, staleCurves, onRetry, onRankings }: Readonly<{
  entries: readonly MixedDiscoveryEntry[];
  pending: boolean;
  failed: boolean;
  staleCurves: boolean;
  onRetry: () => void;
  onRankings: () => void;
}>) {
  const retryButton = <Button size="sm" onClick={onRetry}>Retry</Button>;
  if (entries.length === 0 && pending) return <PendingPanel label="Loading Discover" />;
  if (entries.length === 0) return failed
    ? <EmptyState listEmpty role="alert" title="Discover couldn’t load" action={retryButton} />
    : <EmptyState listEmpty title="No launches to discover yet" />;

  return (
    <>
      <ul aria-label="Discover launches" className={styles.discoveryList}>
        {entries.map(entry => <DiscoveryRow key={entry.key} entry={entry} />)}
      </ul>
      {failed ? <p className={styles.marketNotice} role="alert">Some Discover results couldn’t load. {retryButton}</p> : null}
      {staleCurves && !failed ? <p className={styles.marketNotice}>Bonding activity may be delayed.</p> : null}
      <div className={styles.discoveryFooter}>
        <Button size="lg" variant="ghost" onClick={onRankings}>Trading rankings</Button>
      </div>
    </>
  );
}

function DiscoveryRow({ entry }: Readonly<{ entry: MixedDiscoveryEntry }>) {
  return (
    <li data-list-row={`discover:${entry.key}`}>
      <IntentLink className={styles.discoveryRow} href={entry.href}>
        <CoinMark coin={{ key: entry.key, coinType: entry.coinType, symbol: entry.symbol, iconUrl: entry.iconUrl }} size={34} />
        <span className={styles.discoveryIdentity}>
          <strong className="ticker">{entry.name}</strong>
          <span className={`coinNamed ${styles.discoveryDetail}`}>
            <span>{entry.stage}</span>
            {entry.symbol.toLowerCase() !== entry.name.toLowerCase() ? (
              <span className={styles.discoveryTicker}>· ${entry.symbol}</span>
            ) : null}
            {entry.verified ? <CoinVerifiedMark size="sm" /> : null}
            {entry.legacy ? <CoinLegacyMark /> : null}
          </span>
        </span>
        <span className={styles.discoveryMetric}>
          {entry.figure ? <strong className="num">{entry.figure}</strong> : null}
          <span className={styles.discoveryDetail}>
            {entry.detail}
            {entry.change ? <>
              {entry.detail ? <>{" "}<span className={styles.discoverySeparator} aria-hidden="true">· </span></> : null}
              <span className={entry.change.tone === "flat" ? undefined : styles[entry.change.tone]}>
                <span className="sr-only">1-hour price change </span>
                <span aria-hidden="true">Price </span>{entry.change.text}
              </span>
            </> : null}
          </span>
        </span>
      </IntentLink>
    </li>
  );
}
