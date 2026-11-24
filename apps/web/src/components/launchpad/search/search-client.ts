import { gatedFetch } from "#web/lib/api-gate-client.ts";
import { parseSearchResponse } from "@blast/core/modules/launchpad-search/contracts.ts";

import type { SearchAnswer } from "./search-model.ts";

/**
 * One read of `/api/launchpad/search`: the served groups (a 503 still names
 * each group's state), "invalid" for a refused request, or null when the
 * request did not complete or its answer broke the contract. Answers are
 * private and current, so the read bypasses the browser's HTTP cache.
 */
export async function readSearch(
  url: string,
  options: Readonly<{ signal?: AbortSignal; fetcher?: typeof fetch }> = {},
): Promise<SearchAnswer> {
  const fetcher = options.fetcher ?? gatedFetch;
  try {
    const response = await fetcher(url, { cache: "no-store", headers: { Accept: "application/json" }, signal: options.signal });
    if (response.status === 400) return "invalid";
    if (response.status !== 200 && response.status !== 503) return null;
    return parseSearchResponse(await response.json());
  } catch {
    return null;
  }
}
