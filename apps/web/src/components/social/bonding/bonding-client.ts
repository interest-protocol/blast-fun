import { queryOptions } from "@tanstack/react-query";
import { queryKeys } from "#web/lib/query/keys.ts";
import type { DiscoveryResponse } from "@blast/core/modules/launchpad-discovery/rows.ts";
import { socialRequestAuth, type AccessTokenSource } from "../social-fetch.ts";
import { gatedFetch } from "#web/lib/api-gate-client.ts";
import { parseDiscoveryResponse } from "@blast/core/modules/launchpad-discovery/rows.ts";
import { GRADUATED_MARKET_CAP_PATH, type BondingSort } from "@blast/core/modules/launchpad-discovery/bonding.ts";
import { launchDetailsPath, parseLaunchDetails } from "@blast/core/modules/launchpad-coin/transfer.ts";
import { isHighlightable } from "@blast/core/modules/social/create/coin-text-policy.ts";
import { discoveryNext, discoveryRows, readVisiblePage, withoutTestLaunches } from "#web/lib/test-launches.ts";

const DISCOVERY_PATH = "/api/launchpad/discovery";

export function pageOf(answer: DiscoveryResponse | undefined) {
  const section = answer?.section;
  return section && (section.state === "available" || section.state === "stale")
    ? section.data
    : null;
}

/** Home's highlighted curve: the closest live one, never a slur or a coin about the founder. */
export function closestLiveCurve(answer: DiscoveryResponse | undefined) {
  return pageOf(answer)?.rows.find((row) => row.lifecycle === "live" && row.progressBps !== null && isHighlightable(row));
}

async function fetchBondingCatalog(path: string, signal?: AbortSignal) {
  const response = await gatedFetch(path, {
    signal,
    cache: "no-store",
    headers: { Accept: "application/json" },
  });
  if (!response.ok) throw new Error("Bonding curves could not load.");
  const answer = parseDiscoveryResponse(await response.json());
  if (answer.section.state === "unavailable")
    throw new Error("Bonding curves could not load.");
  return answer;
}

function fetchBondingPage(
  stage: "bonding" | "graduated",
  sort: BondingSort,
  search: string,
  cursor: string | null,
  limit: number,
  signal?: AbortSignal,
) {
  const query = new URLSearchParams({ catalog: stage, sort, q: search, limit: String(limit) });
  if (cursor) query.set("cursor", cursor);
  return fetchBondingCatalog(`${DISCOVERY_PATH}?${query}`, signal);
}

export async function readBondingCatalog(
  stage: "bonding" | "graduated",
  sort: BondingSort,
  search: string,
  cursor: string | null,
  limit = 12,
  signal?: AbortSignal,
) {
  const read = (next: string | null) => fetchBondingPage(stage, sort, search, next, limit, signal);
  return readVisiblePage(cursor, read, withoutTestLaunches, discoveryRows, discoveryNext);
}

/** Continue past a page of migration-ready launches only when Home needs a live curve. */
export function closestLiveCurveQuery(cursor: string | null) {
  return queryOptions({
    queryKey: ["blast", "public", "bonding-catalog", "closest-live", cursor],
    queryFn: ({ signal }) => readVisiblePage(
      cursor,
      (next) => fetchBondingPage("bonding", "progress", "", next, 100, signal),
      withoutTestLaunches,
      (page) => Number(closestLiveCurve(page) !== undefined),
      discoveryNext,
    ),
    enabled: cursor !== null,
    retry: false,
    staleTime: 15_000,
  });
}

/** Every legacy pool is in the first Graduated answer, even when its launch rows are filtered out. */
export function legacyCoinMarketQuery() {
  return queryOptions({
    queryKey: ["blast", "public", "legacy-coin-market"],
    queryFn: async ({ signal }) => {
      const query = new URLSearchParams({ catalog: "graduated", sort: "newest", q: "", limit: "12" });
      const { legacyMarket, legacyFdvUsd } = await fetchBondingCatalog(`${DISCOVERY_PATH}?${query}`, signal);
      return { legacyMarket, legacyFdvUsd };
    },
    retry: false,
    staleTime: 15_000,
  });
}

export function graduatedMarketCapQuery() {
  return queryOptions({
    queryKey: ["blast", "public", "bonding-catalog", "graduated-market-cap"],
    queryFn: async ({ signal }) => withoutTestLaunches(await fetchBondingCatalog(GRADUATED_MARKET_CAP_PATH, signal)),
    retry: false,
    staleTime: 15_000,
  });
}

/**
 * One catalog page as a query, shared by the Bonding page and Home's Bonding
 * Curves, so both read the same CDN-cached URL and the same cache entry.
 */
export function bondingCatalogQuery(
  stage: "bonding" | "graduated",
  sort: BondingSort,
  search: string,
  cursor: string | null,
) {
  return {
    queryKey: ["blast", "public", "bonding-catalog", stage, sort, search, cursor],
    queryFn: ({ signal }: { signal: AbortSignal }): Promise<DiscoveryResponse> =>
      readBondingCatalog(stage, sort, search, cursor, 12, signal),
    retry: false,
    staleTime: 15_000,
  };
}

/** The banner has its own selection and never changes catalog pagination. */
export async function readBondingFeatured(signal?: AbortSignal): Promise<DiscoveryResponse> {
  const response = await gatedFetch(`${DISCOVERY_PATH}?catalog=featured`, {
    signal, cache: "no-store", headers: { Accept: "application/json" },
  });
  if (!response.ok) throw new Error("Featured launch could not load.");
  return withoutTestLaunches(parseDiscoveryResponse(await response.json()));
}

/** The carousel's read, shared by the Bonding board and Home so one cache entry serves both. */
export function bondingFeaturedQuery() {
  return queryOptions({
    queryKey: queryKeys.bonding.featured(),
    queryFn: ({ signal }) => readBondingFeatured(signal),
    staleTime: 15_000,
    retry: false,
  });
}

export async function readBondingLaunchDetails(launchId: string, signal?: AbortSignal) {
  const response = await gatedFetch(launchDetailsPath(launchId), { signal, cache: "no-store" });
  if (!response.ok) {
    throw new Error("Launch details could not load.");
  }
  const body = (await response.json()) as { details?: unknown };
  return parseLaunchDetails(body.details);
}

/** Account ownership stays on the backend; the browser supplies only its linked wallet selection. */
export async function readMyBondingLaunches(
  address: string,
  search: string,
  cursor: string | null,
  getAccessToken?: AccessTokenSource,
  signal?: AbortSignal,
): Promise<DiscoveryResponse> {
  const auth = await socialRequestAuth(getAccessToken);
  if (!auth) throw new Error("Your session could not be read.");
  const params = new URLSearchParams({
    wallet: address,
    q: search,
    limit: "12",
  });
  if (cursor) params.set("cursor", cursor);
  const response = await gatedFetch(
    `/api/social/me/launches/discovery?${params}`,
    {
      ...auth,
      cache: "no-store",
      headers: { ...auth.headers, Accept: "application/json" },
      signal,
    },
  );
  if (!response.ok) throw new Error("Your launches could not load.");
  const answer = parseDiscoveryResponse(await response.json());
  if (answer.section.state === "unavailable")
    throw new Error("Your launches could not load.");
  return answer;
}
