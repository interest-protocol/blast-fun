"use client";

import { useState } from "react";
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

import { bondingFeaturedQuery, pageOf } from "../bonding/bonding-client.ts";
import { FeaturedCurve } from "../bonding/FeaturedCurve.tsx";
import { featuredPresalesQuery } from "../queries.ts";

/** Pins are editorial and change rarely, so Home asks once a minute (the Bonding board asks every 15 s). */
const PIN_POLL_MS = 60_000;

/**
 * Home's top of page: what Blast has pinned, as the shared featured carousel —
 * the pinned presales first, then the pinned bonding curves, the same slides
 * the Presales and Bonding boards show. With nothing pinned nothing is drawn
 * (the Bonding board's "Closest to graduation" stand-in is not a pin), and
 * while the reads are out or failed the page simply starts at its sections.
 */
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
  const count = sales.length + pinnedCurves.length;
  if (count === 0) return null;
  return (
    <section aria-label="Featured by Blast" className={`${carousel.catalogFeatured} ${styles.bar}`}>
      <FeaturedCarousel count={count} hideControlsOnMobile kind="launches">
        {sales.map((sale) => <FeaturedSale className={styles.sale} key={sale.presale_id} now={now} sale={sale} viewer={null} />)}
        {pinnedCurves.map((row) => <FeaturedCurve className={`card ${styles.curve}`} key={row.launchId} featured metrics={curves.data?.metrics?.[row.launchId]} row={row} seed={seededCurves?.details[row.launchId]} />)}
      </FeaturedCarousel>
      {/* The site's CSP drops server-rendered style attributes: this writes the presale bars' widths after hydration. */}
      <CspStyles />
    </section>
  );
}
