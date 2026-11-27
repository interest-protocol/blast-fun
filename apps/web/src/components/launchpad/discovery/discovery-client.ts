import { gatedFetch } from "#web/lib/api-gate-client.ts";
import { almostGraduated, parseDiscoveryResponse, type DiscoveryResponse, type DiscoveryViewName } from "@blast/core/modules/launchpad-discovery/rows.ts";

import { discoveryPageUrl, RAIL_PAGE_SIZE } from "./discovery-model";
import { discoveryNext, discoveryRows, readVisiblePage, withoutTestLaunches } from "#web/lib/test-launches.ts";

/**
 * One page of a view from `/api/launchpad/discovery`, as the rail reads it;
 * null when the request did not complete or was refused. Answers carry the
 * CDN's `s-maxage=10, stale-while-revalidate=30`, so the read bypasses the
 * browser's HTTP cache: Refresh and Load more must reach the server, or an
 * outage would show a cached page as current. Almost graduated reads the
 * bonding catalog by progress and keeps only curves at 60% or more.
 */
export async function readRailPage(
  view: DiscoveryViewName,
  cursor: string | null,
  fetcher: typeof fetch = gatedFetch,
  limit = RAIL_PAGE_SIZE,
): Promise<DiscoveryResponse | null> {
  try {
    const read = async (cursor: string | null) => {
      const response = await fetcher(discoveryPageUrl(view, cursor, limit), {
        cache: "no-store",
        headers: { Accept: "application/json" },
      });
      // A refused query or page token (400) carries no section.
      if (response.status === 400) throw new Error("refused");
      const answer = parseDiscoveryResponse(await response.json());
      // The bonding catalog answers under the `new` view name.
      if (view === "near_graduation" && answer.view === "new") return { ...answer, view };
      if (answer.view !== view) throw new Error("wrong view");
      return answer;
    };
    const visible = view === "near_graduation" ? (answer: DiscoveryResponse) => almostGraduated(withoutTestLaunches(answer)) : withoutTestLaunches;
    return await readVisiblePage(cursor, read, visible, discoveryRows, discoveryNext);
  } catch {
    return null;
  }
}

export { almostGraduated };
