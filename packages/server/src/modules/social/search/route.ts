import { recordMetric } from "@blast/core/lib/metrics.ts";
import type { ReadableDatabase } from "@blast/core/modules/database/transaction.ts";
import { SOCIAL_SEARCH_ROUTE, normalizeSearchQuery } from "@blast/core/modules/social/contracts/search.ts";
import { SocialRouteError } from "@blast/core/modules/social/route-kit/errors.ts";
import type { SocialRouteKit } from "@blast/server/modules/social/route-kit/route.ts";
import { readSearch } from "@blast/server/modules/social/search/read.ts";

/** The term of a search URL (`q`, at most once), normalized; anything else is `invalid_parameter` (`q`). */
export function searchTermOf(url: URL): string {
  const term = normalizeSearchQuery(socialSingle(url.searchParams, "q") ?? "");
  if (term === null) throw new SocialRouteError("invalid_parameter", { extra: { parameter: "q" } });
  return term;
}

/** The term's length as a metric label: never the term itself. */
export function termLengthLabel(term: string): string {
  const length = [...term].length;
  return length === 0 ? "none" : length < 3 ? String(length) : "3+";
}

export type SocialSearchRouteDependencies = Readonly<{
  kit: SocialRouteKit;
  /** The read replica in production. Resolved per request. */
  database: () => ReadableDatabase;
  now?: () => number;
}>;

/**
 * `GET /api/social/search` (contract in `contracts/search.ts`): public, never
 * reads the caller, so the CDN shares one answer per term; on the replica.
 * One `social.search` metric per answer: the term's length class (never the
 * term), how many presales and people it found, and how long it took.
 */
export function createSocialSearchRoutes(dependencies: SocialSearchRouteDependencies) {
  const { kit, database } = dependencies;
  const now = dependencies.now ?? Date.now;
  return Object.freeze({
    search: Object.freeze({
      GET: kit.route({ name: SOCIAL_SEARCH_ROUTE, auth: "none", bucket: "social_read_search", cache: "public" }, async (context) => {
        const started = performance.now();
        const term = searchTermOf(new URL(context.request.url));
        const answer = await readSearch(database(), term, now());
        recordMetric("social.search", {
          term: termLengthLabel(term),
          presales: answer.presales.length,
          people: answer.people.length,
          ms: Math.round(performance.now() - started),
        });
        return context.json(answer);
      }),
    }),
  });
}

export type SocialSearchRoutes = ReturnType<typeof createSocialSearchRoutes>;
import { socialSingle } from "@blast/server/modules/social/route-kit/validation.ts";
