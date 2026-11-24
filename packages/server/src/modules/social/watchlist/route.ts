import { readWatchlistPage, readWatchlistIds, readWatchlistKeys, star, unstar, type WatchlistCursor, type WatchlistQuery } from "./store.ts";
import { socialParameter, socialSingle } from "@blast/server/modules/social/route-kit/validation.ts";
import { z } from "zod";

import { recordMetric } from "@blast/core/lib/metrics.ts";
import type { ReadableDatabase } from "@blast/core/modules/database/transaction.ts";
import {
  SOCIAL_WATCHLIST_IDS_ROUTE,
  SOCIAL_WATCHLIST_ITEM_PREFIX,
  SOCIAL_WATCHLIST_ITEM_ROUTE,
  SOCIAL_WATCHLIST_KEYS_ROUTE,
  SOCIAL_WATCHLIST_ROUTE,
  WATCHLIST_INCLUDE_FOLLOWS,
  WATCHLIST_PAGE_DEFAULT,
  WATCHLIST_PAGE_MAX,
} from "@blast/core/modules/social/contracts/watchlist.ts";
import { followPathParameter } from "@blast/server/modules/social/follows/route.ts";

import { withCatalogTerms } from "@blast/server/modules/social/presales/catalog-terms.ts";
import type { PresaleTermsSource } from "@blast/server/modules/social/presales/detail.ts";
import { SocialRouteError } from "@blast/core/modules/social/route-kit/errors.ts";
import type { SocialRequestContext, SocialRouteKit } from "@blast/server/modules/social/route-kit/route.ts";
import { COIN_TYPE, SUI_OBJECT_ID_PATTERN } from "@blast/core/lib/sui/ids.ts";

/** A star's key: a presale id, or a bonding-curve coin's type. */
const WATCHLIST_KEY_PATTERN = new RegExp(`${SUI_OBJECT_ID_PATTERN.source}|${COIN_TYPE.source}`);

/**
 * The watchlist (contract in `contracts/watchlist.ts`; OA-11): an account's
 * starred presales in `social_watchlist` (0072), owned by module `social`;
 * the right column's card adds the presales the account follows (OA-17,
 * `social_follows`).
 * Writes run in one primary transaction; reads on `database()`, the primary
 * too (the account reads its own stars right after writing them). Every
 * answer is `private, no-store`.
 */


/** A cursor from `encodeWatchlistCursor`, or `invalid_parameter` (`cursor`). */
const watchlistPosition = [z.string().regex(/^(0|[1-9][0-9]{0,18})$/), z.string().regex(SUI_OBJECT_ID_PATTERN)] as const;
const watchlistCursorSchema = z.union([
  z.tuple(watchlistPosition),
  z.tuple([...watchlistPosition, z.literal("f")]),
]);

export function decodeWatchlistCursor(raw: string): WatchlistCursor {
  let parsed: unknown = null;
  if (raw.length <= 200) {
    try {
      parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
    } catch {
      parsed = null;
    }
  }
  const decoded = watchlistCursorSchema.safeParse(parsed);
  if (!decoded.success) throw new SocialRouteError("invalid_parameter", { extra: { parameter: "cursor" } });
  return { atUs: decoded.data[0], presaleId: decoded.data[1], followed: decoded.data.length === 3 };
}

/**
 * `limit`, `cursor` and `include` of a list URL, each at most once; others
 * ignored. `include` is `follows` or absent; a followed presale's cursor
 * needs it.
 */
export function parseWatchlistQuery(url: URL): WatchlistQuery {
  const one = (name: string) => socialSingle(url.searchParams, name);
  const rawLimit = one("limit");
  const limit = socialParameter(z.string().regex(/^[1-9][0-9]?$/).transform(Number).pipe(z.number().max(WATCHLIST_PAGE_MAX)).nullable().transform((value) => value ?? WATCHLIST_PAGE_DEFAULT), rawLimit, "limit");
  const include = one("include");
  socialParameter(z.literal(WATCHLIST_INCLUDE_FOLLOWS).nullable(), include, "include");
  const rawCursor = one("cursor");
  const cursor = rawCursor === null ? null : decodeWatchlistCursor(rawCursor);
  if (cursor?.followed && include === null) throw new SocialRouteError("invalid_parameter", { extra: { parameter: "cursor" } });
  return { limit, cursor, includeFollows: include !== null };
}

export type SocialWatchlistRouteDependencies = Readonly<{
  kit: SocialRouteKit;
  /** The primary in production (read-your-writes). Resolved per request. */
  database: () => ReadableDatabase;
  now?: () => number;
  terms?: PresaleTermsSource;
}>;

/** A `204` for a private route. */
function noContent(context: SocialRequestContext): Response {
  return new Response(null, { status: 204, headers: { "Cache-Control": "private, no-store", "X-Request-ID": context.requestId } });
}

/**
 * The watchlist routes. Each request, after the kit (auth, bucket, account
 * required): the path or query parameters (`invalid_parameter`), then the
 * read or one primary transaction. `social.watchlist` metrics carry the
 * operation and its time, never an id.
 */
export function createSocialWatchlistRoutes(dependencies: SocialWatchlistRouteDependencies) {
  const { kit, database } = dependencies;
  const now = dependencies.now ?? Date.now;
  const write = (method: "PUT" | "DELETE") =>
    ({ name: `${method} ${SOCIAL_WATCHLIST_ITEM_ROUTE}`, auth: "account", account: "required", bucket: "social_watchlist", cache: "private" }) as const;
  const read = (name: string) => ({ name, auth: "account", account: "required", bucket: "social_read", cache: "private" }) as const;
  const presaleIdOf = (request: Request) =>
    followPathParameter(request, SOCIAL_WATCHLIST_ITEM_PREFIX, WATCHLIST_KEY_PATTERN, "presale_id");
  const timed = async <T>(op: string, run: () => Promise<T>): Promise<T> => {
    const started = performance.now();
    const result = await run();
    recordMetric("social.watchlist", { op, ms: Math.round(performance.now() - started) });
    return result;
  };

  return Object.freeze({
    list: Object.freeze({
      GET: kit.route(read(SOCIAL_WATCHLIST_ROUTE), async (context) => {
        const query = parseWatchlistQuery(new URL(context.request.url));
        const page = await timed("list", () => readWatchlistPage(database(), context.account!.account_id, query, now()));
        const sales = await withCatalogTerms(page.items.map(item => item.presale), dependencies.terms);
        return context.json({ ...page, items: page.items.map((item, index) => ({ ...item, presale: sales[index]! })) });
      }),
    }),
    ids: Object.freeze({
      GET: kit.route(read(SOCIAL_WATCHLIST_IDS_ROUTE), async (context) => {
        const ids = await timed("ids", () => readWatchlistIds(database(), context.account!.account_id));
        return context.json(ids);
      }),
    }),
    keys: Object.freeze({
      GET: kit.route(read(SOCIAL_WATCHLIST_KEYS_ROUTE), async (context) => {
        const keys = await timed("keys", () => readWatchlistKeys(database(), context.account!.account_id));
        return context.json(keys);
      }),
    }),
    item: Object.freeze({
      PUT: kit.route(write("PUT"), async (context) => {
        const presaleId = presaleIdOf(context.request);
        const accountId = context.account!.account_id;
        await timed("add", () => context.transaction((social) => star(social, accountId, presaleId), { label: "social.watchlist" }));
        return noContent(context);
      }),
      DELETE: kit.route(write("DELETE"), async (context) => {
        const presaleId = presaleIdOf(context.request);
        const accountId = context.account!.account_id;
        await timed("remove", () => context.transaction((social) => unstar(social, accountId, presaleId), { label: "social.watchlist" }));
        return noContent(context);
      }),
    }),
  });
}

export type SocialWatchlistRoutes = ReturnType<typeof createSocialWatchlistRoutes>;
