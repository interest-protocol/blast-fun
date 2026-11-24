"use client";

import { useState } from "react";
import { useQuery, type QueryClient } from "@tanstack/react-query";
import type { DiscoveryResponse } from "@blast/core/modules/launchpad-discovery/rows.ts";
import type { SocialPresaleSummary } from "@blast/core/web/contracts/presales.ts";

import { CspStyles } from "#web/components/presale-pages/csp-style.tsx";
import { eligibleFeatured, shuffleFeatured } from "#web/components/presale-pages/featured-model.ts";
import { FeaturedCarousel } from "#web/components/presale-pages/FeaturedCarousel.tsx";
import { FeaturedSale } from "#web/components/presale-pages/FeaturedPresales.tsx";
import carousel from "#web/components/presale-pages/FeaturedPresales.module.css";
import styles from "./PinnedLaunches.module.css";
import type { BondingHeroSeed } from "#web/lib/backend-api/bonding.ts";
import { pollInterval } from "#web/lib/query/polling.ts";
import { useAppQueryClient } from "#web/lib/query/provider.tsx";
import { useSeededQuery } from "#web/lib/query/seed.ts";

import { bondingCatalogQuery, bondingFeaturedQuery, closestLiveCurve, closestLiveCurveQuery, pageOf } from "../bonding/bonding-client.ts";
import { FeaturedCurve } from "../bonding/FeaturedCurve.tsx";
import { featuredPresalesQuery } from "../queries.ts";

/** Pins are editorial and change rarely, so Home asks once a minute (the Bonding board asks every 15 s). */
const PIN_POLL_MS = 60_000;

function useClosestLiveCurve(featured: DiscoveryResponse | undefined, client: QueryClient) {
  // With no pins, reuse the Bonding hero's already ranked live curve and its refresh.
  const heroCurve = featured?.featured === false ? closestLiveCurve(featured) : undefined;
  const ranking = useQuery({
    ...bondingCatalogQuery("bonding", "progress", "", null),
    enabled: !heroCurve,
    refetchInterval: (query) => pollInterval(PIN_POLL_MS, query),
  }, client);
  const rankedCurve = closestLiveCurve(ranking.data);
  const cursor = heroCurve || rankedCurve ? null : pageOf(ranking.data)?.nextCursor ?? null;
  const laterPages = useQuery({
    ...closestLiveCurveQuery(cursor),
    refetchInterval: (query) => pollInterval(PIN_POLL_MS, query),
  }, client);
  if (heroCurve) return { row: heroCurve, metrics: featured?.metrics };
  if (rankedCurve) return { row: rankedCurve, metrics: ranking.data?.metrics };
  return { row: closestLiveCurve(laterPages.data), metrics: laterPages.data?.metrics };
}

/** Home's featured carousel: pinned presales, pinned curves, then the live curve closest to graduation. */
export function PinnedLaunches({ now, nowMs, initialPinSeed, presales: seededPresales = null, curves: seededCurves = null }: Readonly<{
  now: number;
  /** When the server read the seeds. */
  nowMs: number;
  initialPinSeed: string;
  /** The server's reads of the two pin lists, so the bar is in the first paint; null when a read failed (the browser then asks). */
  presales?: readonly SocialPresaleSummary[] | null;
  curves?: BondingHeroSeed | null;
}>) {
  const client = useAppQueryClient();
  const presales = useSeededQuery({ ...featuredPresalesQuery(), refetchInterval: (query) => pollInterval(PIN_POLL_MS, query) }, seededPresales, nowMs, client);
  const curves = useSeededQuery({ ...bondingFeaturedQuery(), refetchInterval: (query) => pollInterval(PIN_POLL_MS, query) }, seededCurves?.answer, seededCurves?.nowMs ?? nowMs, client);
  const [seed] = useState(() => initialPinSeed);
  const sales = shuffleFeatured(eligibleFeatured(presales.data ?? [], now), seed);
  const pinnedCurves = curves.data?.featured === true ? (pageOf(curves.data)?.rows ?? []) : [];
  const { row: nearest, metrics } = useClosestLiveCurve(curves.data, client);
  const closestCurve = nearest && !pinnedCurves.some((row) => row.coinType === nearest.coinType) ? nearest : undefined;
  const count = sales.length + pinnedCurves.length + Number(closestCurve !== undefined);
  if (count === 0) return null;
  return (
    <section aria-label="Launch highlights" className={`${carousel.catalogFeatured} ${styles.bar}`}>
      <FeaturedCarousel count={count} hideControlsOnMobile kind="launches">
        {sales.map((sale) => <FeaturedSale className={styles.sale} key={sale.presale_id} now={now} sale={sale} viewer={null} />)}
        {pinnedCurves.map((row) => <FeaturedCurve className={`card ${styles.curve}`} key={row.launchId} featured metrics={curves.data?.metrics?.[row.launchId]} row={row} seed={seededCurves?.details[row.launchId]} />)}
        {closestCurve ? <FeaturedCurve className={`card ${styles.curve}`} key={closestCurve.launchId} featured={false} metrics={metrics?.[closestCurve.launchId]} row={closestCurve} seed={seededCurves?.details[closestCurve.launchId]} /> : null}
      </FeaturedCarousel>
      {/* The site's CSP drops server-rendered style attributes: this writes the presale bars' widths after hydration. */}
      <CspStyles />
    </section>
  );
}
