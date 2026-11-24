import type { LegacyDiscoveryMarket } from "@blast/core/modules/launchpad-discovery/rows.ts";
import { handleFeaturedRequest, type FeatureReader, type SharedRead } from "./featured.ts";
import { handleBondingRequest, handleGraduatedMarketCapRequest } from "./bonding.ts";
import { GRADUATED_MARKET_CAP_CATALOG } from "@blast/core/modules/launchpad-discovery/bonding.ts";
import { verifiedTeamOf, type VerifiedReader } from "./verified.ts";
import { z } from "zod";
import { CREATE_TEST_SUI_QUOTE_TYPE } from "@blast/core/modules/social/contracts/create.ts";
import { publicJson } from "@blast/core/lib/http-errors.ts";
import { CursorError } from "@blast/core/modules/launchpad-contract/cursor.ts";
import {
  DISCOVERY_VIEWS,
  readDiscoveryPage,
  type DiscoveryPage,
  type DiscoveryView,
} from "@blast/core/modules/launchpad-contract/discovery.ts";
import type { Provenance } from "@blast/core/modules/launchpad-contract/read.ts";
import { sectionFromRead } from "@blast/core/modules/launchpad-contract/section.ts";
import { UNAVAILABLE_RETRY_AFTER_SECONDS } from "@blast/core/modules/database/availability.ts";
import {
  PRIVATE_NO_STORE,
  withCachePolicy,
} from "@blast/server/modules/read-routing/cache-policy.ts";
import { defaultMarketDataDependencies } from "@blast/core/modules/read-routing/blast-infra.ts";
import type { MarketDataDependencies } from "@blast/core/modules/read-routing/market-data.ts";
import type {
  DiscoveryPageData,
  DiscoveryResponse,
} from "@blast/core/modules/launchpad-discovery/rows.ts";

/**
 * `GET /api/launchpad/discovery`: one page of a Blast discovery view
 * (`new`, `near_graduation`, `graduated`), composed over blast-infra's
 * `GET /v1/pools?view=` through the validated `/v1` client. Hot is not a
 * view: it has no named inputs or per-result reasons, so it is refused.
 */

const UNSUPPORTED_VIEW = "LAUNCHPAD_VIEW_UNSUPPORTED";

function refuse(status: number, code: string, message: string): Response {
  return publicJson(
    { error: { code, message } },
    { status, headers: { "Cache-Control": PRIVATE_NO_STORE } },
  );
}

export { discoveryRow } from "./row.ts";
import { discoveryRow, isPublicLaunch } from "./row.ts";

function pageData(page: DiscoveryPage): DiscoveryPageData {
  return { rows: page.launches.map(discoveryRow), nextCursor: page.nextCursor };
}

const QUERY_KEYS = ["view", "limit", "cursor"];

type DiscoveryQuery = Readonly<{
  view: DiscoveryView;
  limit: string | null;
  cursor: string | null;
}>;

/** The query, or the refusal: the view is the whole selection, so nothing else filters or sorts it. */
function parseQuery(params: URLSearchParams): DiscoveryQuery | Response {
  const view = params.get("view") ?? "new";
  if (view === "hot") {
    return refuse(
      400,
      UNSUPPORTED_VIEW,
      "Hot is not available: it has no published ranking inputs or per-result reasons yet.",
    );
  }
  const keys = [...params.keys()];
  const repeated = keys.length !== new Set(keys).size;
  if (
    !z.enum(DISCOVERY_VIEWS).safeParse(view).success ||
    repeated ||
    !z.array(z.enum(QUERY_KEYS)).safeParse(keys).success
  ) {
    return refuse(
      400,
      UNSUPPORTED_VIEW,
      "Choose one view: new, near_graduation or graduated, with only limit and cursor beside it.",
    );
  }
  return {
    view: view as DiscoveryView,
    limit: params.get("limit"),
    cursor: params.get("cursor"),
  };
}

/**
 * The view cannot be served: no rows at all (never an empty list or a
 * recomputed one), why, and the provenance of the failed read when known.
 */
function unavailable(
  view: DiscoveryView,
  reason: string,
  provenance?: Provenance,
): Response {
  const body: DiscoveryResponse = {
    view,
    section: {
      state: "unavailable",
      reason,
      retryAfterSeconds: UNAVAILABLE_RETRY_AFTER_SECONDS,
      ...(provenance ? { provenance } : {}),
    },
  };
  return publicJson(body, {
    status: 503,
    headers: {
      "Cache-Control": PRIVATE_NO_STORE,
      "Retry-After": String(UNAVAILABLE_RETRY_AFTER_SECONDS),
    },
  });
}

/** This server's blast-infra, or null when it is not configured. */
function configured(): MarketDataDependencies | null {
  try {
    return defaultMarketDataDependencies();
  } catch {
    return null;
  }
}

export async function handleDiscoveryRequest(
  request: Request,
  dependencies?: MarketDataDependencies,
  readFeature?: FeatureReader,
  readVerified?: VerifiedReader,
  share?: SharedRead,
  readLegacyMarket?: () => Promise<LegacyDiscoveryMarket>,
): Promise<Response> {
  const params = new URL(request.url).searchParams;
  const catalog = params.get("catalog");
  if (catalog === "featured")
    return handleFeaturedRequest(request, dependencies, readFeature, readVerified, share);
  if (catalog === GRADUATED_MARKET_CAP_CATALOG)
    return handleGraduatedMarketCapRequest(request, dependencies, readVerified, readLegacyMarket, share);
  if (catalog !== null)
    return handleBondingRequest(request, dependencies, undefined, undefined, readVerified, readLegacyMarket);
  const query = parseQuery(params);
  if (query instanceof Response) return query;
  const { view } = query;
  // Market facts come only from blast-infra: without its origin there is nothing to serve.
  const market = dependencies ?? configured();
  if (!market) return unavailable(view, "unconfigured");
  let read: Awaited<ReturnType<typeof readDiscoveryPage>>;
  try {
    read = await readDiscoveryPage(
      view,
      { ...query, excludeQuote: CREATE_TEST_SUI_QUOTE_TYPE },
      market,
    );
  } catch (error) {
    if (error instanceof CursorError)
      return refuse(400, error.code, error.message);
    throw error;
  }
  if (read.status === "unavailable")
    return unavailable(
      view,
      read.provenance.reason ?? "unavailable",
      read.provenance,
    );
  if (read.data.kind === "refused") {
    if (read.data.httpStatus === 400) {
      return refuse(
        400,
        "LAUNCHPAD_CURSOR_INVALID",
        "This page of the list cannot be read. Start again from the first page.",
      );
    }
    return unavailable(view, read.data.error.code, read.provenance);
  }
  const page = read.data.value;
  const answer = { ...page, launches: page.launches.filter(isPublicLaunch) };
  const data = pageData(answer);
  const section = sectionFromRead(
    {
      status: read.status,
      data,
      provenance: read.provenance,
    },
    (data) => data.rows.length === 0 && data.nextCursor === null,
  );
  // The original strict row contract stays byte-for-byte compatible with open older clients.
  const metrics = Object.fromEntries(
    answer.launches.map((launch) => [
      launch.launchId,
      { holders: launch.holders ?? null, market: launch.market ?? null },
    ]),
  );
  const body: DiscoveryResponse = { view, section, metrics, ...(await verifiedTeamOf(data.rows, readVerified)) };
  return withCachePolicy(request, "chain-derived", publicJson(body));
}
