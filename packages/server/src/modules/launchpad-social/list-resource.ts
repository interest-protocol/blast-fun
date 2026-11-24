import { publicJson } from "@blast/core/lib/http-errors.ts";
import { parseLaunchId } from "@blast/core/lib/launchpad/launch-id.ts";
import { CursorError } from "@blast/core/modules/launchpad-contract/cursor.ts";
import type { RoutedRead } from "@blast/core/modules/launchpad-contract/read.ts";
import { sectionFromRead } from "@blast/core/modules/launchpad-contract/section.ts";
import { UNAVAILABLE_RETRY_AFTER_SECONDS } from "@blast/core/modules/database/availability.ts";
import { replicaPooledUrl } from "@blast/core/modules/database/topology.ts";
import type { ChainJoinDependencies } from "@blast/server/modules/read-routing/chain-join.ts";
import {
  PRIVATE_NO_STORE,
  withCachePolicy,
} from "@blast/server/modules/read-routing/cache-policy.ts";
import type {
  ThesisListPage,
  ThesisListResponse,
} from "@blast/core/modules/launchpad-social/list-contract.ts";
import {
  listLaunchTheses,
  type ThesisPage,
} from "@blast/server/modules/launchpad-social/reads.ts";

/**
 * `GET /api/launchpad/theses?launchId=&cursor=&limit=`: one page of a
 * canonical launch's public posts (`listLaunchTheses`), newest first post
 * first, as one section. Hidden and superseded records and launches the
 * chain views do not list give nothing. Social records make the answer
 * private: it is never cached publicly.
 */

/** Where the page comes from: `listLaunchTheses` as production routes it. */
export type ThesisListSource = (
  launchId: string,
  request: Readonly<{ limit: string | null; cursor: string | null }>,
) => Promise<RoutedRead<ThesisPage>>;

/** The database read; null when the read replica is not configured. */
export function databaseThesisSource(
  dependencies?: ChainJoinDependencies,
): ThesisListSource | null {
  if (!dependencies) {
    try {
      replicaPooledUrl();
    } catch {
      return null;
    }
  }
  return (launchId, request) =>
    listLaunchTheses(launchId, request, dependencies);
}

const KEYS = ["launchId", "cursor", "limit"];

function refuse(code: string, message: string): Response {
  return publicJson(
    { error: { code, message } },
    { status: 400, headers: { "Cache-Control": PRIVATE_NO_STORE } },
  );
}

export async function handleThesisListRequest(
  request: Request,
  source: ThesisListSource | null,
): Promise<Response> {
  const params = new URL(request.url).searchParams;
  const keys = [...params.keys()];
  if (
    keys.length !== new Set(keys).size ||
    keys.some((key) => !KEYS.includes(key))
  ) {
    return refuse(
      "LAUNCHPAD_QUERY_INVALID",
      "The list takes launchId, and optionally cursor and limit, once each.",
    );
  }
  const launchId = parseLaunchId(params.get("launchId") ?? "");
  if (!launchId)
    return refuse(
      "LAUNCHPAD_QUERY_INVALID",
      "launchId must be a canonical launch ID.",
    );

  let body: ThesisListResponse;
  if (source === null) {
    body = {
      launchId,
      theses: { state: "unavailable", reason: "unconfigured" },
    };
  } else {
    let read: RoutedRead<ThesisPage>;
    try {
      read = await source(launchId, {
        limit: params.get("limit"),
        cursor: params.get("cursor"),
      });
    } catch (error) {
      if (error instanceof CursorError)
        return refuse(error.code, error.message);
      throw error;
    }
    const page: RoutedRead<ThesisListPage> =
      read.status === "unavailable"
        ? read
        : {
            ...read,
            data: { items: read.data.theses, nextCursor: read.data.nextCursor },
          };
    body = {
      launchId,
      theses: sectionFromRead(page, (data) => data.items.length === 0),
    };
  }
  const response =
    body.theses.state === "unavailable"
      ? publicJson(body, {
          status: 503,
          headers: { "Retry-After": String(UNAVAILABLE_RETRY_AFTER_SECONDS) },
        })
      : publicJson(body);
  return withCachePolicy(request, "social", response);
}
