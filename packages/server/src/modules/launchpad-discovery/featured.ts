import { publicJson } from "@blast/core/lib/http-errors.ts";
import { answerSection } from "@blast/core/modules/launchpad-coin/market-sections.ts";
import { ContractViolation } from "@blast/core/modules/launchpad-contract/decimal.ts";
import {
  parseLaunchSummary,
  type LaunchSummary,
} from "@blast/core/modules/launchpad-contract/discovery.ts";
import type { Section } from "@blast/core/modules/launchpad-contract/section.ts";
import { readV1 } from "@blast/core/modules/launchpad-contract/v1.ts";
import { readBondingFeatures } from "@blast/core/modules/launchpad-discovery/feature.ts";
import type {
  DiscoveryMetrics,
  DiscoveryResponse,
  DiscoveryRow,
} from "@blast/core/modules/launchpad-discovery/rows.ts";
import { defaultMarketDataDependencies } from "@blast/core/modules/read-routing/blast-infra.ts";
import { databaseFor } from "@blast/core/modules/read-routing/databases.ts";
import type { MarketDataDependencies } from "@blast/core/modules/read-routing/market-data.ts";
import { isHighlightable } from "@blast/core/modules/social/create/coin-text-policy.ts";
import { handleBondingRequest } from "./bonding.ts";
import { discoveryRow, isPublicLaunch } from "./row.ts";
import { verifiedTeamOf, type VerifiedReader } from "./verified.ts";

const HEADERS = { "Cache-Control": "private, no-store" };
export type FeatureReader = () => Promise<readonly string[]>;
const savedFeatures: FeatureReader = () =>
  readBondingFeatures(databaseFor("search"), true);
const UNREAD: VerifiedReader = async () => new Set();

/** A coalescing public read with a lifetime (`publicReadCache` in production): askers within it share one answer. */
export type SharedRead = <T>(key: string, load: () => Promise<T>, ttlMs: number) => Promise<T>;
const unshared: SharedRead = (_key, load) => load();
/** Every open Home and Bonding tab asks, and pins change at an operator's pace: one composed answer serves them all this long. */
const FEATURED_SHARE_MS = 10_000;
/** The closest curves read for the highlight; the first one `isHighlightable` passes is shown. */
const HIGHLIGHT_CANDIDATES = "20";

async function closestToGraduation(
  request: Request,
  dependencies: MarketDataDependencies | undefined,
) {
  const url = new URL(request.url);
  url.search = new URLSearchParams({
    catalog: "bonding",
    sort: "progress",
    limit: HIGHLIGHT_CANDIDATES,
  }).toString();
  const response = await handleBondingRequest(new Request(url), dependencies, undefined, undefined, UNREAD);
  if (!response.ok) throw new Error("Featured market read unavailable");
  return (await response.json()) as DiscoveryResponse;
}

async function readPinnedCurve(id: string, market: MarketDataDependencies) {
  const read = await readV1(
    "discovery-market-facts",
    `/v1/pools/blast_curve/${id}`,
    (body) => {
      const launch = parseLaunchSummary((body as { pool?: unknown } | null)?.pool);
      if (launch.launchId !== id) {
        throw new ContractViolation("pool.pool_id", "must be the requested launch");
      }
      return launch;
    },
    market,
  );
  if (
    read.status !== "unavailable" &&
    read.data.kind === "refused" &&
    read.data.httpStatus === 404
  ) {
    return null;
  }
  const section = answerSection(read);
  if (section.state !== "available" && section.state !== "stale") {
    throw new Error("Featured market read unavailable");
  }
  return isPublicLaunch(section.data) ? section : null;
}

type AnsweredSection = Extract<
  Section<LaunchSummary>,
  { state: "available" | "stale" }
>;
function isOlder(
  section: AnsweredSection,
  current: AnsweredSection | undefined,
): boolean {
  return (
    !current ||
    (section.state === "stale" && current.state !== "stale") ||
    (section.state === current.state &&
      (section.provenance.timestampMs ?? 0) <
        (current.provenance.timestampMs ?? 0))
  );
}

async function selectedFeatures(
  dependencies: MarketDataDependencies | undefined,
  ids: readonly string[],
  readVerified: VerifiedReader | undefined,
): Promise<DiscoveryResponse | null> {
  if (!ids.length) return null;
  const market = dependencies ?? defaultMarketDataDependencies();
  const rows: DiscoveryRow[] = [];
  const metrics: Record<string, DiscoveryMetrics> = {};
  let oldest: AnsweredSection | undefined;
  // The market contract resolves exact IDs individually; keep upstream concurrency bounded.
  for (let offset = 0; offset < ids.length; offset += 4) {
    const batch = ids.slice(offset, offset + 4);
    const answers = await Promise.all(batch.map((id) => readPinnedCurve(id, market)));
    for (const section of answers) {
      if (!section) continue;
      const launch = section.data;
      const row = discoveryRow(launch);
      rows.push(
        launch.lifecycle === "migrated"
          ? { ...row, progressBps: null, quoteRemaining: null }
          : row,
      );
      metrics[launch.launchId] = {
        holders: launch.holders ?? null,
        market: launch.market ?? null,
      };
      // Never describe a mixed-checkpoint carousel as fresher than its oldest answer.
      if (isOlder(section, oldest)) oldest = section;
    }
  }
  if (oldest && rows.length)
    return {
      view: "new",
      featured: true,
      metrics,
      ...(await verifiedTeamOf(rows, readVerified)),
      section: { ...oldest, data: { rows, nextCursor: null } },
    };
  return null;
}

/** Only the carousel uses these selections; catalog ordering and cursors are independent. */
export async function handleFeaturedRequest(
  request: Request,
  dependencies?: MarketDataDependencies,
  readFeatures: FeatureReader = savedFeatures,
  readVerified?: VerifiedReader,
  share: SharedRead = unshared,
): Promise<Response> {
  const params = new URL(request.url).searchParams;
  if ([...params.keys()].length !== 1 || params.get("catalog") !== "featured")
    return publicJson(
      {
        error: {
          code: "LAUNCHPAD_QUERY_INVALID",
          message:
            "The featured carousel takes no paging or search parameters.",
        },
      },
      { status: 400, headers: HEADERS },
    );
  try {
    const answer = await share(
      "launchpad-discovery:featured",
      () => composeFeatured(request, dependencies, readFeatures, readVerified),
      FEATURED_SHARE_MS,
    );
    return publicJson(answer, { headers: HEADERS });
  } catch {
    return publicJson(
      {
        view: "new",
        section: {
          state: "unavailable",
          reason: "unavailable",
          retryAfterSeconds: 5,
        },
      },
      { status: 503, headers: { ...HEADERS, "Retry-After": "5" } },
    );
  }
}

/** The pinned curves, or the closest to graduation when none answers; a failed read throws, so it is never shared. */
async function composeFeatured(
  request: Request,
  dependencies: MarketDataDependencies | undefined,
  readFeatures: FeatureReader,
  readVerified: VerifiedReader | undefined,
): Promise<DiscoveryResponse> {
  const selected = await selectedFeatures(dependencies, [
    ...new Set(await readFeatures()),
  ], readVerified);
  if (selected) return selected;
  const body = await closestToGraduation(request, dependencies);
  const section = body.section;
  if (section.state !== "available" && section.state !== "stale") return { ...body, featured: false };
  // Slurs and coins about the founder are never highlighted; the next closest curve is.
  const rows = section.data.rows.filter(isHighlightable).slice(0, 1);
  const shown = rows[0];
  const shownMetrics = shown && body.metrics?.[shown.launchId];
  return {
    ...body,
    metrics: shown && shownMetrics ? { [shown.launchId]: shownMetrics } : {},
    ...(await verifiedTeamOf(rows, readVerified)),
    featured: false,
    section: { ...section, data: { rows, nextCursor: null } },
  };
}
