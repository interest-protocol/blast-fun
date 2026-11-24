import type { LegacyDiscoveryMarket } from "@blast/core/modules/launchpad-discovery/rows.ts";
import { compareExact, exactDecimal } from "@blast/core/lib/exact-amount.ts";
import { publicJson } from "@blast/core/lib/http-errors.ts";
import { recordMetric } from "@blast/core/lib/metrics.ts";
import { CREATE_TEST_SUI_QUOTE_TYPE } from "@blast/core/modules/social/contracts/create.ts";
import { blastV1Coin } from "@blast/core/modules/social/portfolio/core-coins.ts";
import {
  readBondingPage,
  type BondingSelection,
} from "@blast/core/modules/launchpad-contract/bonding.ts";
import { CursorError } from "@blast/core/modules/launchpad-contract/cursor.ts";
import type { DiscoveryPage, LaunchSummary } from "@blast/core/modules/launchpad-contract/discovery.ts";
import type { Provenance } from "@blast/core/modules/launchpad-contract/read.ts";
import {
  HOME_BONDING_ROWS,
  normalizeBondingSearch,
} from "@blast/core/modules/launchpad-discovery/bonding.ts";
import { defaultMarketDataDependencies } from "@blast/core/modules/read-routing/blast-infra.ts";
import type { MarketDataDependencies } from "@blast/core/modules/read-routing/market-data.ts";
import { sectionFromRead } from "@blast/core/modules/launchpad-contract/section.ts";
import {
  PRIVATE_NO_STORE,
  withCachePolicy,
} from "@blast/server/modules/read-routing/cache-policy.ts";
import { discoveryRow, isPublicLaunch } from "./row.ts";
import { verifiedTeamOf, type VerifiedReader } from "./verified.ts";
import type { DiscoveryResponse } from "@blast/core/modules/launchpad-discovery/rows.ts";
import type { SharedRead } from "./featured.ts";

function validKeys(params: URLSearchParams, creator?: string): boolean {
  const keys = [...params.keys()];
  const allowed = creator
    ? ["q", "limit", "cursor"]
    : ["catalog", "sort", "q", "limit", "cursor"];
  return (
    keys.length === new Set(keys).size &&
    keys.every((key) => allowed.includes(key))
  );
}

function selectionOf(
  params: URLSearchParams,
  creator?: string,
  accountCommitment?: string,
): BondingSelection | null {
  if (!validKeys(params, creator)) return null;
  const stage = creator ? "all" : params.get("catalog");
  if (stage !== "bonding" && stage !== "graduated" && stage !== "all")
    return null;
  const sort = creator
    ? "newest"
    : (params.get("sort") ?? (stage === "graduated" ? "newest" : "progress"));
  if (sort !== "progress" && sort !== "newest") return null;
  if (stage === "graduated" && sort !== "newest") return null;
  const q = normalizeBondingSearch(params.get("q") ?? "");
  if (q === null) return null;
  return {
    stage,
    sort,
    q,
    ...(creator ? { creator } : {}),
    ...(accountCommitment ? { accountCommitment } : {}),
  };
}
function configured(): MarketDataDependencies | null {
  try {
    return defaultMarketDataDependencies();
  } catch {
    return null;
  }
}
function refuse(message: string): Response {
  return publicJson(
    { error: { code: "LAUNCHPAD_QUERY_INVALID", message } },
    { status: 400, headers: { "Cache-Control": PRIVATE_NO_STORE } },
  );
}

function unavailable(view: "new" | "graduated"): Response {
  return publicJson(
    { view, section: { state: "unavailable", reason: "unavailable", retryAfterSeconds: 5 } },
    { status: 503, headers: { "Cache-Control": PRIVATE_NO_STORE, "Retry-After": "5" } },
  );
}

type LegacyMarketReader = () => Promise<LegacyDiscoveryMarket>;
const GRADUATED_SELECTION: BondingSelection = { stage: "graduated", sort: "newest", q: "" };
const RANKING_SHARE_MS = 10_000;
const RANKING_MAX_PAGES = 4;

async function catalogLegacyMarket(
  selection: BondingSelection,
  params: URLSearchParams,
  read?: LegacyMarketReader,
): Promise<LegacyDiscoveryMarket> {
  if (!read || selection.stage !== "graduated" || selection.q || params.has("cursor")) return {};
  return read();
}

async function bondingSnapshot(
  page: DiscoveryPage,
  launches: readonly LaunchSummary[],
  status: "fresh" | "stale",
  provenance: Provenance,
  legacyValues: LegacyDiscoveryMarket,
  readVerified?: VerifiedReader,
): Promise<DiscoveryResponse> {
  const rows = launches.map(discoveryRow);
  const section = sectionFromRead(
    { status, data: { rows, nextCursor: page.nextCursor }, provenance },
    (data) => data.rows.length === 0 && data.nextCursor === null,
  );
  const metrics = Object.fromEntries(
    launches.map((launch) => [
      launch.launchId,
      { holders: launch.holders ?? null, market: launch.market ?? null },
    ]),
  );
  return { view: page.view, section, metrics, ...legacyValues, ...(await verifiedTeamOf(rows, readVerified)) };
}

async function readGraduatedRanking(market: MarketDataDependencies) {
  const launches = new Map<string, LaunchSummary>();
  const deadline = performance.now() + market.timeoutMs;
  let oldest: Provenance | undefined;
  let staleReason: string | undefined;
  let cursor: string | null = null;

  // Reuse the reader's validated catalog and keep the whole walk within one read deadline.
  // A failed or unfinished walk must never produce a partial top list.
  for (let pageNumber = 0; pageNumber < RANKING_MAX_PAGES; pageNumber++) {
    const timeoutMs = Math.ceil(deadline - performance.now());
    if (timeoutMs <= 0) break;
    const answer = await readBondingPage(
      GRADUATED_SELECTION,
      { limit: "100", cursor, excludeQuote: CREATE_TEST_SUI_QUOTE_TYPE },
      { ...market, timeoutMs },
    );
    if (answer.status === "unavailable" || answer.data.kind === "refused")
      throw new Error("Graduated market cap read unavailable");
    const page = answer.data.value;
    if (!oldest || (answer.provenance.checkpoint ?? 0) < (oldest.checkpoint ?? 0))
      oldest = answer.provenance;
    if (answer.status === "stale") staleReason = answer.provenance.reason ?? "stale";
    for (const launch of page.launches) launches.set(launch.launchId, launch);
    cursor = page.nextCursor;
    if (cursor === null) {
      return { page, launches: [...launches.values()], oldest, staleReason };
    }
  }
  recordMetric("read.degraded", { resource: "discovery-market-facts", outcome: "unavailable", reason: "graduated-ranking-budget" });
  throw new Error("Graduated market cap read exceeded its budget");
}

function rankByMarketCap(launches: readonly LaunchSummary[]) {
  // A stable sort keeps newest first for equal or missing caps.
  return launches
    .filter((launch) => isPublicLaunch(launch) && !blastV1Coin(launch.coinType))
    .map((launch) => ({ launch, cap: exactDecimal(launch.market?.market_cap_usd) }))
    .sort((a, b) => a.cap && b.cap ? compareExact(b.cap, a.cap) : Number(!a.cap) - Number(!b.cap))
    .slice(0, HOME_BONDING_ROWS)
    .map(({ launch }) => launch);
}

export async function handleGraduatedMarketCapRequest(
  request: Request,
  dependencies?: MarketDataDependencies,
  readVerified?: VerifiedReader,
  readLegacyMarket?: LegacyMarketReader,
  share?: SharedRead,
): Promise<Response> {
  if (new URL(request.url).searchParams.size !== 1)
    return refuse("Graduated market cap takes no paging or search parameters.");
  const market = dependencies ?? configured();
  if (!market) return unavailable("graduated");
  try {
    const load = async () => {
      const [{ page, launches, oldest, staleReason }, legacyValues] = await Promise.all([
        readGraduatedRanking(market),
        readLegacyMarket?.(),
      ]);
      return bondingSnapshot(
        page,
        rankByMarketCap(launches),
        staleReason ? "stale" : "fresh",
        staleReason ? { ...oldest, reason: staleReason } : oldest,
        legacyValues ?? {},
        readVerified,
      );
    };
    const body = share ? await share("launchpad-discovery:graduated-market-cap", load, RANKING_SHARE_MS) : await load();
    return withCachePolicy(request, "chain-derived", publicJson(body));
  } catch {
    return unavailable("graduated");
  }
}

export async function handleBondingRequest(
  request: Request,
  dependencies?: MarketDataDependencies,
  creator?: string,
  accountCommitment?: string,
  readVerified?: VerifiedReader,
  readLegacyMarket?: LegacyMarketReader,
): Promise<Response> {
  const params = new URL(request.url).searchParams;
  const selection = selectionOf(params, creator, accountCommitment);
  if (!selection)
    return refuse(
      "Choose a bonding stage, order and search term up to 128 bytes.",
    );
  const stage = selection.stage;
  const view = stage === "graduated" ? "graduated" : "new";
  const market = dependencies ?? configured();
  if (!market) return unavailable(view);
  try {
    const read = readBondingPage(
      selection,
      {
        limit: params.get("limit"),
        cursor: params.get("cursor"),
        ...(creator ? {} : { excludeQuote: CREATE_TEST_SUI_QUOTE_TYPE }),
      },
      market,
    );
    const [answer, legacyValues] = await Promise.all([
      read,
      catalogLegacyMarket(selection, params, readLegacyMarket),
    ]);
    if (answer.status === "unavailable") return unavailable(view);
    if (answer.data.kind === "refused")
      return answer.data.httpStatus === 400
        ? refuse("Start again from the first page.")
        : unavailable(view);
    const page = answer.data.value;
    const launches = creator ? page.launches : page.launches.filter(isPublicLaunch);
    const body = await bondingSnapshot(page, launches, answer.status, answer.provenance, legacyValues, readVerified);
    const response = publicJson(
      body,
      creator ? { headers: { "Cache-Control": PRIVATE_NO_STORE } } : undefined,
    );
    return creator
      ? response
      : withCachePolicy(request, "chain-derived", response);
  } catch (error) {
    if (error instanceof CursorError) return refuse(error.message);
    throw error;
  }
}
