import { z } from "zod";
import { publicJson } from "@blast/core/lib/http-errors.ts";
import { errorLabel, recordMetric } from "@blast/core/lib/metrics.ts";
import { CursorError, pageLimit } from "@blast/core/modules/launchpad-contract/cursor.ts";
import type { RoutedRead } from "@blast/core/modules/launchpad-contract/read.ts";
import { sectionFromRead, type Section } from "@blast/core/modules/launchpad-contract/section.ts";
import { SocialQueryError } from "@blast/server/modules/launchpad-social/contracts.ts";
import { searchTheses, type SearchPage } from "@blast/server/modules/launchpad-social/reads.ts";
import type { PublicPost } from "@blast/core/modules/launchpad-social/post-contract.ts";
import { UNAVAILABLE_RETRY_AFTER_SECONDS } from "@blast/core/modules/database/availability.ts";
import { replicaPooledUrl } from "@blast/core/modules/database/topology.ts";
import type { ChainJoinDependencies } from "@blast/server/modules/read-routing/chain-join.ts";
import { PRIVATE_NO_STORE, withCachePolicy } from "@blast/server/modules/read-routing/cache-policy.ts";
import {
  PAGED_GROUPS,
  type LaunchGroup,
  type LaunchGroupPage,
  type PagedGroup,
  type SearchGroupResult,
  type SearchResponse,
  type ThesisGroupPage,
  type ThesisSnippet,
} from "@blast/core/modules/launchpad-search/contracts.ts";
import { parseSearchQuery, type SearchQuery } from "@blast/server/modules/launchpad-search/query.ts";
import { applicableLaunchGroups, searchLaunchGroup } from "@blast/server/modules/launchpad-search/reads.ts";

/**
 * `GET /api/launchpad/search?q=`: grouped search over canonical Blast
 * launches and their public theses. Without `group`, the first page of
 * every group the query can match, identifier groups first, then Profiles
 * (no source yet: Unavailable). With `group` (and its `cursor`), one page of
 * that group. Each group is its own section, so one that fails or lags is
 * Unavailable or Stale while the others answer. Social records make the
 * answer private: it is never cached publicly.
 */

/** Matches per group page: a few per group first, more on request. */
export const SEARCH_PAGE = Object.freeze({ default: 5, max: 25 });

/** Where each group's matches come from. */
export type SearchSources = Readonly<{
  launches: (
    group: LaunchGroup,
    query: SearchQuery,
    request: Readonly<{ limit: number; cursor: string | null }>,
  ) => Promise<RoutedRead<LaunchGroupPage>>;
  theses: (raw: string, request: Readonly<{ limit: number; cursor: string | null }>) => Promise<RoutedRead<SearchPage>>;
}>;

/** The database reads, as production routes them; null when the read replica is not configured. */
export function databaseSearchSources(dependencies?: ChainJoinDependencies): SearchSources | null {
  if (!dependencies) {
    try {
      replicaPooledUrl();
    } catch {
      return null;
    }
  }
  return {
    launches: (group, query, request) => searchLaunchGroup(group, query, request, dependencies),
    theses: (raw, request) => searchTheses(raw, { limit: String(request.limit), cursor: request.cursor }, dependencies),
  };
}

const QUERY_INVALID = "LAUNCHPAD_QUERY_INVALID";
const KEYS = ["q", "group", "cursor", "limit"];

function refuse(code: string, message: string): Response {
  return publicJson({ error: { code, message } }, { status: 400, headers: { "Cache-Control": PRIVATE_NO_STORE } });
}

type Params = Readonly<{ q: string; group: PagedGroup | null; cursor: string | null; limit: string | null }>;

/** Exactly the known keys, once each; a token only with its group. */
function parseParams(params: URLSearchParams): Params | Response {
  const keys = [...params.keys()];
  if (keys.length !== new Set(keys).size || !z.array(z.enum(KEYS)).safeParse(keys).success) {
    return refuse(QUERY_INVALID, "Search takes q, and optionally group, cursor and limit, once each.");
  }
  const group = params.get("group");
  if (group !== null && !z.enum(PAGED_GROUPS).safeParse(group).success) {
    return refuse(QUERY_INVALID, "Choose a group: onchain, wallets, coins or theses.");
  }
  if (params.has("cursor") && group === null) return refuse(QUERY_INVALID, "A page token needs its group.");
  return { q: params.get("q") ?? "", group: group as PagedGroup | null, cursor: params.get("cursor"), limit: params.get("limit") };
}

function snippet(post: PublicPost): ThesisSnippet {
  return {
    id: post.id,
    thesisId: post.thesisId,
    kind: post.kind,
    stance: post.stance,
    body: post.body,
    authorLabels: post.authorLabels,
    postedAt: post.postedAt,
    createdAt: post.createdAt,
  };
}

function thesisRead(read: RoutedRead<SearchPage>): RoutedRead<ThesisGroupPage> {
  if (read.status === "unavailable") return read;
  return {
    ...read,
    data: {
      items: read.data.theses.map((hit) => ({ match: "words", thesis: snippet(hit.thesis), launch: hit.launch })),
      nextCursor: read.data.nextCursor,
    },
  };
}

function unavailable(reason: string): Section<never> {
  return { state: "unavailable", reason };
}

/** A refusal that belongs to the request (a bad token or group), not to a source. */
function requestError(error: unknown): Response | null {
  if (error instanceof CursorError) return refuse(error.code, error.message);
  if (error instanceof SocialQueryError) return refuse(error.code, error.message);
  return null;
}

export async function handleSearchRequest(request: Request, sources: SearchSources | null): Promise<Response> {
  const params = parseParams(new URL(request.url).searchParams);
  if (params instanceof Response) return params;
  let query: SearchQuery;
  let limit: number;
  try {
    query = parseSearchQuery(params.q);
    limit = pageLimit(params.limit, SEARCH_PAGE);
  } catch (error) {
    const refusal = requestError(error);
    if (refusal) return refusal;
    throw error;
  }
  const launchGroups = applicableLaunchGroups(query);
  if (params.group !== null && params.group !== "theses" && !launchGroups.includes(params.group)) {
    return refuse(QUERY_INVALID, "This search has no such group.");
  }
  const groups: PagedGroup[] = params.group === null ? [...launchGroups, "theses"] : [params.group];
  const page = { limit, cursor: params.cursor };

  const reads = sources === null
    ? groups.map(() => Promise.resolve(null))
    : groups.map((group) => group === "theses"
      ? sources.theses(params.q, page).then(thesisRead)
      : sources.launches(group, query, page));
  const settled = await Promise.allSettled(reads);
  if (params.group !== null && settled[0].status === "rejected") {
    const refusal = requestError(settled[0].reason);
    if (refusal) return refusal;
  }

  const results: SearchGroupResult[] = groups.map((group, index) => {
    const outcome = settled[index];
    let section: Section<LaunchGroupPage | ThesisGroupPage>;
    if (outcome.status === "rejected") {
      recordMetric("launchpad.search", { group, outcome: "error", error: errorLabel(outcome.reason) });
      section = unavailable("error");
    } else if (outcome.value === null) {
      section = unavailable("unconfigured");
    } else {
      // A page with a token is never empty: the theses group may skip posts of unlisted launches and still have more.
      section = sectionFromRead<LaunchGroupPage | ThesisGroupPage>(
        outcome.value,
        (data) => data.items.length === 0 && data.nextCursor === null,
      );
    }
    return { group, section } as SearchGroupResult;
  });
  const down = results.every((result) => result.section.state === "unavailable");
  if (params.group === null) results.push({ group: "profiles", section: unavailable("no-source") });

  const body: SearchResponse = { groups: results };
  const response = down
    ? publicJson(body, { status: 503, headers: { "Retry-After": String(UNAVAILABLE_RETRY_AFTER_SECONDS) } })
    : publicJson(body);
  return withCachePolicy(request, "social", response);
}
