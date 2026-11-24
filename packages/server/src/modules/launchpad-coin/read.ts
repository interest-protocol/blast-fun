import { parseCurveBody, answerSection } from "@blast/core/modules/launchpad-coin/market-sections.ts";
export { parseCurveBody } from "@blast/core/modules/launchpad-coin/market-sections.ts";
import { settledAll } from "@blast/server/lib/settled-all.ts";
import { witnessVenue, type CurveRead, type CoinPageRead, type SelectedSource } from "@blast/core/modules/launchpad-coin/contracts.ts";

import {
  parseCoinSummary,
  parseVenuePool,
  type CoinSummary,
  type VenuePool,
} from "@blast/core/modules/launchpad-contract/coin.ts";
import type { RoutedRead } from "@blast/core/modules/launchpad-contract/read.ts";
import type { Section } from "@blast/core/modules/launchpad-contract/section.ts";
import { readV1, type V1Answer } from "@blast/core/modules/launchpad-contract/v1.ts";
import type { MarketDataDependencies } from "@blast/core/modules/read-routing/market-data.ts";
import {
  executionAvailability,
  isTradable,
  LIFECYCLE_FROM_SDK,
} from "@blast/core/modules/launchpad-coin/availability.ts";
import type { FreshLaunch, FreshLaunchReader } from "@blast/core/modules/launchpad-coin/fresh-types.ts";

/** The last answered section of each key, per process, for outages. */
export type LastGood = Readonly<{
  settle<T>(key: string, section: Section<T>): Section<T>;
}>;

export type CoinPageDependencies = Readonly<{
  /** blast-infra; null when its origin is not configured (every indexed section Unavailable). */
  market: MarketDataDependencies | null;
  readFresh: FreshLaunchReader;
  lastGood: LastGood;
}>;

/**
 * Keeps the last section with data for up to `capacity` keys (least recently
 * answered first out). An Unavailable section whose key answered before is
 * served Stale from that answer, with that answer's provenance and the
 * current failure as its reason.
 */
export function createLastGood(capacity = 512): LastGood {
  const kept = new Map<string, Section<unknown>>();
  return {
    settle<T>(key: string, section: Section<T>): Section<T> {
      if (section.state === "available" || section.state === "stale") {
        kept.delete(key);
        kept.set(key, section);
        if (kept.size > capacity) kept.delete(kept.keys().next().value as string);
        return section;
      }
      const previous = kept.get(key) as Section<T> | undefined;
      if (section.state !== "unavailable" || !previous || (previous.state !== "available" && previous.state !== "stale")) {
        return section;
      }
      return { state: "stale", data: previous.data, provenance: previous.provenance, reason: section.reason };
    },
  };
}

export type { CoinSummary, PoolStats, TradeWindow, VenuePool } from "@blast/core/modules/launchpad-contract/coin.ts";

/** blast-infra explicitly does not know the launch (404, or 400 for an ID it refuses). */
function denied<T>(read: RoutedRead<V1Answer<T>>): boolean {
  return read.status !== "unavailable" && read.data.kind === "refused" && [400, 404].includes(read.data.httpStatus);
}

function data<T>(section: Section<T>): T | null {
  return section.state === "available" || section.state === "stale" ? section.data : null;
}

function unavailable<T>(reason: string): Section<T> {
  return { state: "unavailable", reason };
}

function venuePath(key: string): string {
  const [venue, poolId] = key.split(":");
  return `/v1/pools/${venue}/${poolId}`;
}

export async function readCoinPage(launchId: string, dependencies: CoinPageDependencies): Promise<CoinPageRead> {
  const { market } = dependencies;
  const v1 = <T>(path: string, parse: (body: unknown) => T): Promise<RoutedRead<V1Answer<T>>> =>
    market
      ? readV1("market", path, parse, market)
      : Promise.resolve({
          status: "unavailable",
          provenance: { source: "blast-infra", network: null, deployment: null, checkpoint: null, timestampMs: null, observedAt: Date.now(), lagMs: null, reason: "unconfigured" },
        });
  const [curveRead, fresh] = await settledAll([
    v1(`/v1/pools/blast_curve/${launchId}`, (body) => parseCurveBody(body, launchId)),
    dependencies.readFresh(launchId),
  ]);
  if (denied(curveRead) && fresh.status !== "read") return { kind: "not-found" };
  const curve = dependencies.lastGood.settle(`curve:${launchId}`, answerSection(curveRead));
  // blast-infra cannot answer and never has here: the node decides.
  if (curve.state === "unavailable" && (fresh.status === "absent" || fresh.status === "foreign")) {
    return { kind: "not-found" };
  }

  const settle = <T>(key: string, read: Promise<Section<T>>) =>
    read.then((section) => dependencies.lastGood.settle(`${key}`, section));
  const indexed = data(curve);
  const freshRead = fresh.status === "read" ? fresh : null;
  const coinType = indexed?.launch.coinType ?? freshRead?.launch.memeType ?? null;
  const readCoin = (type: string) =>
    settle(
      `coin:${launchId}`,
      v1(`/v1/coins/${type}`, (body) => parseCoinSummary(body, type, launchId)).then(answerSection),
    );
  // The venue's own answer to this request decides trading; the remembered one only fills the display.
  const readVenue = async (key: string, type: string) => {
    const current = answerSection(await v1(venuePath(key), (body) => parseVenuePool(body, key, type)));
    return { current, shown: dependencies.lastGood.settle(`venue:${launchId}`, current) };
  };
  const noVenue = () => {
    const none = unavailable<VenuePool>("no venue pool recorded");
    return { current: none, shown: none };
  };

  const recordedVenueKey = indexed?.launch.migration?.poolKey ?? null;
  const [coin, earlyVenue] = coinType
    ? await settledAll([readCoin(coinType), recordedVenueKey ? readVenue(recordedVenueKey, coinType) : null])
    : [unavailable<CoinSummary>("coin type unknown"), null];
  const currentPool = data(coin)?.currentPool ?? null;
  const venueKey = recordedVenueKey ?? (currentPool && !currentPool.startsWith("blast_curve:") ? currentPool : null);

  const indexedLifecycle = indexed?.launch.lifecycle ?? null;
  const freshLifecycle = freshRead ? LIFECYCLE_FROM_SDK[freshRead.launch.lifecycle] : null;
  const lifecycle = freshLifecycle ?? indexedLifecycle;
  const migrated = lifecycle === "migrated" || venueKey !== null;
  const venueRead = !migrated
    ? null
    : (earlyVenue ?? (venueKey && coinType ? await readVenue(venueKey, coinType) : noVenue()));
  return presentCoinPage(launchId, curve, coin, venueRead, fresh, venueKey);
}


type VenueRead = { current: Section<VenuePool>; shown: Section<VenuePool> };

function presentCoinPage(
  launchId: string,
  curve: Section<CurveRead>,
  coin: Section<CoinSummary>,
  venueRead: VenueRead | null,
  fresh: FreshLaunch,
  venueKey: string | null,
): CoinPageRead {
  const indexed = data(curve);
  const freshRead = fresh.status === "read" ? fresh : null;
  const coinType = indexed?.launch.coinType ?? freshRead?.launch.memeType ?? null;
  const indexedLifecycle = indexed?.launch.lifecycle ?? null;
  const freshLifecycle = freshRead ? LIFECYCLE_FROM_SDK[freshRead.launch.lifecycle] : null;
  const migrated = (freshLifecycle ?? indexedLifecycle) === "migrated" || venueKey !== null;
  const venue = venueRead?.shown ?? null;
  const routeVenue = freshRead?.route.venue ?? witnessVenue(indexed?.launch.launch.migrationWitness ?? "") ?? "venue";
  const source: SelectedSource = migrated
    ? { kind: "venue", venue: routeVenue, poolKey: venueKey }
    : { kind: "curve", poolKey: `blast_curve:${launchId}` };
  const venueNow = venueRead?.current ?? null;
  const venueNowData = venueNow ? data(venueNow) : null;
  const availability = executionAvailability({
    fresh,
    coinType,
    venue: venueNowData
      ? { poolKey: venueNowData.poolKey }
      : venueNow?.state === "unavailable"
        ? { unavailable: venueNow.reason }
        : null,
  });
  const conflict =
    freshLifecycle && indexedLifecycle && freshLifecycle !== indexedLifecycle
      ? { indexed: indexedLifecycle, fresh: freshLifecycle }
      : null;
  return {
    kind: "coin",
    page: {
      launchId,
      curve,
      coin,
      venue,
      fresh,
      confirmed: indexed !== null || freshRead !== null,
      source,
      conflict,
      availability,
      tradable: isTradable(availability),
    },
  };
}

/** The telemetry check's budget: inside T-007's 1.5 s beacon budget. */
export const TRADABLE_CHECK_TIMEOUT_MS = 1_200;

/**
 * Whether the coin page would show `launchId` as tradable now (the first-view
 * denominator's condition): `unavailable` when that cannot be known within
 * `timeoutMs`, or when the launch object cannot be read.
 */
export async function tradableNow(
  launchId: string,
  dependencies: CoinPageDependencies,
  options: Readonly<{ timeoutMs?: number; trackWork?: <T>(promise: Promise<T>) => Promise<T> }> = {},
): Promise<"tradable" | "not-tradable" | "unavailable"> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<"unavailable">((resolve) => {
    timer = setTimeout(() => resolve("unavailable"), options.timeoutMs ?? TRADABLE_CHECK_TIMEOUT_MS);
  });
  const deciding = (options.trackWork ?? ((promise) => promise))(readCoinPage(launchId, dependencies).then((read) => {
    if (read.kind === "not-found") return "not-tradable" as const;
    if (read.page.tradable) return "tradable" as const;
    return read.page.fresh.status === "unavailable" ? ("unavailable" as const) : ("not-tradable" as const);
  }));
  deciding.catch(() => undefined);
  try {
    return await Promise.race([deciding, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

type TradableAnswer = Awaited<ReturnType<typeof tradableNow>>;

/**
 * Reuses a launch's definite tradability answer for `ttlMs` (default 5 s),
 * so a burst of beacons for one coin costs one check. `unavailable` is never
 * reused. At most `capacity` launches are remembered, oldest out first.
 */
export function memoizeTradable(
  check: (launchId: string) => Promise<TradableAnswer>,
  options: Readonly<{ ttlMs?: number; capacity?: number; now?: () => number }> = {},
): (launchId: string) => Promise<TradableAnswer> {
  const ttlMs = options.ttlMs ?? 5_000;
  const capacity = options.capacity ?? 512;
  const now = options.now ?? Date.now;
  const answers = new Map<string, { at: number; answer: TradableAnswer }>();
  return async (launchId) => {
    const kept = answers.get(launchId);
    if (kept && now() - kept.at <= ttlMs) return kept.answer;
    const answer = await check(launchId);
    answers.delete(launchId);
    if (answer !== "unavailable") {
      answers.set(launchId, { at: now(), answer });
      if (answers.size > capacity) answers.delete(answers.keys().next().value as string);
    }
    return answer;
  };
}
