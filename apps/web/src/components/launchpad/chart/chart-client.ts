import { candleBucketStart, readMigratedChart, readPoolCandles, type ChartRoute, type MigratedChart, type MigrationMarker, type PoolCandlePage } from "@blast/core/modules/launchpad-contract/venue-history.ts";
import type { ExpectedDeployment } from "@blast/core/modules/launchpad-contract/provenance.ts";
import type { MarketDataDependencies } from "@blast/core/modules/read-routing/market-data.ts";
import { sectionFromRead, type Section } from "@blast/core/modules/launchpad-contract/section.ts";

import { afterChartSourceRead, chartKey, chartRequest, initialChart, type ChartControls } from "./chart-model";
import { MIGRATOR_POOL_KEY } from "@blast/core/modules/launchpad-contract/venues.ts";
import { sameChartMigration } from "./chart-live-model";

/**
 * Which pools the browser charts (through this app's `/api/launchpad/market`
 * routes, never blast-infra itself): the launch's curve pool, and the venue
 * pool its committed migration recorded. Nothing here is secret; the server
 * hands it to the page.
 */
export type ChartSource = Readonly<{
  /** The deployment the page serves; answers about another are Unavailable. Null checks nothing. */
  expected: ExpectedDeployment | null;
  curvePoolKey: string;
  /** The venue pool the committed migration recorded; null before migration or when none is tracked. */
  venuePoolKey: string | null;
  /** The committed migration from the coin summary; null before one. */
  migration: MigrationMarker | null;
  symbol: string;
  quoteSymbol: string;
  quoteType?: string | null;
  /** Immutable curve price at launch, in quote atoms per meme atom. */
  opening?: Readonly<{ timestampMs: number; price: string }>;
  /** An unknown scale prevents plotting prices in whole tokens. */
  memeDecimals: number | null;
  quoteDecimals: number | null;
}>;

/** The pools the chart reads: the curve, and the recorded venue pool when blast-infra charts it. */
type ChartPools = Pick<ChartSource, "curvePoolKey" | "venuePoolKey" | "migration">;

function chartRoute(source: ChartPools, migration: MigrationMarker | null): ChartRoute {
  const venue = source.venuePoolKey ?? migration?.venuePoolKey ?? null;
  return { curvePoolKey: source.curvePoolKey, venuePoolKey: venue && MIGRATOR_POOL_KEY.test(venue) ? venue : null };
}

/** One independently fenced pool read for a streaming chart's recovery. */
export type ChartPoolRead = Readonly<{ section: Section<PoolCandlePage>; page: PoolCandlePage | null }>;

export type ChartSnapshot = Readonly<{
  key: string;
  readAt: number;
  pools: readonly (readonly [pool: string, read: ChartPoolRead])[];
}>;

export function chartPoolKeys(source: ChartPools, controls: ChartControls, now: number): string[] {
  const { curvePoolKey, venuePoolKey } = chartRoute(source, source.migration);
  const { from, interval } = chartRequest(controls, now);
  // Live has no lower bound because it needs the previous close. History may
  // omit the curve only when even the bucket containing migration is outside it.
  if (venuePoolKey && source.migration?.curvePoolKey === curvePoolKey && source.migration.venuePoolKey === venuePoolKey &&
      from !== undefined && from > candleBucketStart(interval, source.migration.timestampMs)) return [venuePoolKey];
  return venuePoolKey ? [curvePoolKey, venuePoolKey] : [curvePoolKey];
}

export async function readChartSnapshot(source: ChartSource, controls: ChartControls, dependencies: MarketDataDependencies, now: number): Promise<ChartSnapshot> {
  const reads = await Promise.all(chartPoolKeys(source, controls, now).map(async (pool) => {
    const read = await readChartPool(pool, controls, dependencies, now);
    if (source.migration && read.page && !sameChartMigration(source.migration, read.page.migration)) {
      return [pool, { section: { state: "unavailable", reason: "migration-history-mismatch" }, page: null }] as const;
    }
    return [pool, read] as const;
  }));
  return { key: chartKey(controls), readAt: now, pools: reads };
}

export function chartFromSnapshot(source: ChartSource, controls: ChartControls, snapshot?: ChartSnapshot) {
  const key = chartKey(controls);
  const venue = source.venuePoolKey ?? source.migration?.venuePoolKey ?? null;
  const empty = initialChart(key, venue !== null, source.migration);
  if (snapshot?.key !== key) return empty;
  return snapshot.pools.reduce((state, [pool, read]) => afterChartSourceRead(
    state, key, pool === source.curvePoolKey ? "curve" : "venue", read.section, source.migration ?? read.page?.migration ?? state.migration,
  ), empty);
}

// The history tail keeps the prior close even when the selected range has no trades.
export function chartTailRequest(controls: ChartControls, now: number) {
  const { interval, limit, capped } = chartRequest(controls, now);
  return { interval, limit, capped };
}

export async function readChartPool(poolKey: string, controls: ChartControls, dependencies: MarketDataDependencies, now: number): Promise<ChartPoolRead> {
  const read = await readPoolCandles(poolKey, chartTailRequest(controls, now), dependencies);
  if (read.status === "unavailable") return { section: sectionFromRead(read, () => false), page: null };
  if (read.data.kind === "refused") return { section: { state: "unavailable", reason: `refused:${read.data.error.code}`, provenance: read.provenance }, page: null };
  return { section: sectionFromRead({ ...read, data: read.data.value }, (page) => page.candles.length === 0), page: read.data.value };
}

/**
 * One bounded page of each source's own candles for `controls`, read
 * independently. When the curve's page names a migration the page did not
 * know of, the venue pool it recorded is read too.
 */
export async function readChart(
  source: ChartSource,
  controls: ChartControls,
  dependencies: MarketDataDependencies,
  now: number,
  known: MigrationMarker | null = source.migration,
): Promise<MigratedChart> {
  const request = chartRequest(controls, now);
  const route = chartRoute(source, known);
  const chart = await readMigratedChart(route, request, dependencies);
  const learned = chartRoute(source, chart.migration);
  if (route.venuePoolKey !== null || learned.venuePoolKey === null) return chart;
  return readMigratedChart(learned, request, dependencies);
}
