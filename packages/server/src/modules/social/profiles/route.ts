import type { ReadableDatabase } from "@blast/core/modules/database/transaction.ts";
import type { SocialConfig } from "@blast/core/modules/social/contracts/config.ts";
import {
  SOCIAL_PROFILE_ITEMS_ROUTE,
  SOCIAL_PROFILE_ROUTE,
  isProfileCallsign,
  profileBioRequested,
} from "@blast/core/modules/social/contracts/profiles.ts";
import {
  SOCIAL_ME_PRESALES_ROUTE,
  SOCIAL_PROFILE_CALLS_ROUTE,
  SOCIAL_PROFILE_MUTUALS_ROUTE,
  SOCIAL_PROFILE_THESES_ROUTE,
  type SocialProfileCalls,
} from "@blast/core/modules/social/contracts/profile-page.ts";
import type { SocialProfileItemsPage } from "@blast/core/modules/social/contracts/profiles.ts";
import { timed } from "@blast/core/lib/metrics.ts";
import { routeParams } from "@blast/core/modules/backend-api/route-path.ts";
import {
  SOCIAL_PROFILE_PNL_PATH,
  SOCIAL_PROFILE_PORTFOLIO_HISTORY_PATH,
  SOCIAL_PROFILE_PORTFOLIO_PATH,
} from "@blast/core/modules/backend-api/private/social-home-contracts.ts";
import {
  SOCIAL_PROFILE_CALLS_PATH,
  SOCIAL_PROFILE_CONNECTIONS_PATH,
  SOCIAL_PROFILE_ITEMS_PATH,
  SOCIAL_PROFILE_MUTUALS_PATH,
  SOCIAL_PROFILE_PATH,
  SOCIAL_PROFILE_THESES_PATH,
} from "@blast/core/modules/backend-api/private/social-read-contracts.ts";
import { parseItemLimit, parseItemPage, readAsOf, toItems } from "@blast/server/modules/social/items/index.ts";
import { SocialRouteError } from "@blast/core/modules/social/route-kit/errors.ts";
import type { SocialRequestContext, SocialRouteKit } from "@blast/server/modules/social/route-kit/route.ts";
import { readCalls } from "@blast/server/modules/social/profiles/calls.ts";
import { ensureMemberAccount, memberProfileExists, readProfile, readProfileAccount, readProfileItemsPage } from "@blast/server/modules/social/profiles/read.ts";
import { decodeThesisCursor, nextThesisCursor, thesisEntriesOf } from "@blast/server/modules/social/profiles/theses.ts";
import { readMePresales, readMutuals } from "@blast/server/modules/social/profiles/viewer.ts";
import { SOCIAL_CREATED_PRESALES_PATH, type SocialCreatedPresales } from "@blast/core/modules/social/contracts/presales.ts";
import { readAccountAddresses } from "@blast/server/modules/social/accounts/read-wallet-addresses.ts";
import { readSummaries, summaryOf } from "@blast/server/modules/social/presales/summary.ts";
import { readCreatedPresaleIds } from "@blast/server/modules/social/profiles/created-presales.ts";
import { parseConnectionQuery, readConnectionCounts, readConnections } from "@blast/server/modules/social/profiles/connections.ts";

export type SocialProfileRouteDependencies = Readonly<{
  kit: SocialRouteKit;
  /** The read replica in production (`socialProfileDatabase`). Resolved per request. */
  database: () => ReadableDatabase;
  /** The tuning values the item mapper needs (`getSocialConfig`). */
  config: () => Promise<SocialConfig>;
  /**
   * Standalone primary reads preserve replica-lag fallback without opening
   * write transactions for unknown callsigns; also used for viewer reads.
   */
  primary: () => ReadableDatabase;
  now?: () => number;
}>;

const PROFILE_PATHS = {
  "": SOCIAL_PROFILE_PATH,
  "/items": SOCIAL_PROFILE_ITEMS_PATH,
  "/portfolio": SOCIAL_PROFILE_PORTFOLIO_PATH,
  "/portfolio/history": SOCIAL_PROFILE_PORTFOLIO_HISTORY_PATH,
  "/pnl": SOCIAL_PROFILE_PNL_PATH,
  "/calls": SOCIAL_PROFILE_CALLS_PATH,
  "/theses": SOCIAL_PROFILE_THESES_PATH,
  "/mutuals": SOCIAL_PROFILE_MUTUALS_PATH,
  "/connections": SOCIAL_PROFILE_CONNECTIONS_PATH,
} as const;

/** The callsign of the profile route ending in `suffix`; anything else is `invalid_parameter` (parameter `callsign`). */
export function profileCallsignParameter(request: Request, suffix: keyof typeof PROFILE_PATHS): string {
  const value = routeParams(PROFILE_PATHS[suffix], new URL(request.url).pathname)?.callsign;
  if (!isProfileCallsign(value)) throw new SocialRouteError("invalid_parameter", { extra: { parameter: "callsign" } });
  return value;
}

/** `limit` and `cursor` may each appear at most once; other parameters are ignored. */
function pageQuery(url: URL): URLSearchParams {
  for (const name of ["limit", "cursor"]) {
    socialSingle(url.searchParams, name);
  }
  return url.searchParams;
}

/**
 * The profile routes (contracts in `contracts/profiles.ts` and
 * `contracts/profile-page.ts`). The public ones (identity, items, calls,
 * theses) are `auth: "none"` (a token changes nothing and is never read),
 * bucket `social_read`, `cache: "public"`, and read `database()`: the
 * replica. A callsign no account holds may still be a Mission Control
 * member who never opened Blast: its account row is created on the primary
 * (`ensureMemberAccount`) and that request is answered from the primary. The
 * viewer ones (mutuals, `me/presales`) need an account and read the primary.
 */
export function createSocialProfileRoutes(dependencies: SocialProfileRouteDependencies) {
  const { kit, database, config } = dependencies;
  const now = dependencies.now ?? Date.now;
  const spec = (name: string) => ({ name, auth: "none", bucket: "social_read", cache: "public" }) as const;
  const viewerSpec = (name: string) => ({ name, auth: "account", account: "required", bucket: "social_read", cache: "private" }) as const;

  /** Runs a viewer read on the primary without a write transaction. */
  function onPrimary<Result>(read: (db: ReadableDatabase) => Promise<Result>): Promise<Result> {
    return read(dependencies.primary());
  }

  /**
   * Read the replica, then the primary on a miss. Only an existing Mission
   * Control member without an account needs a write transaction; random
   * missing callsigns return not_found after primary reads.
   */
  async function publicRead<Result>(
    context: SocialRequestContext,
    callsign: string,
    read: (db: ReadableDatabase) => Promise<Result | null>,
  ): Promise<Result> {
    const found = await read(database());
    if (found !== null) return found;
    const primary = dependencies.primary();
    const current = await read(primary);
    if (current !== null) return current;
    if (!(await memberProfileExists(primary, callsign))) throw new SocialRouteError("not_found");
    const created = await context.transaction(async (social) => {
      await ensureMemberAccount(social, callsign);
      return read(social);
    }, { label: "social.profile_member" });
    if (created === null) throw new SocialRouteError("not_found");
    return created;
  }

  return Object.freeze({
    connections: Object.freeze({
      GET: kit.route({ name: "GET /api/social/profiles/{callsign}/connections", auth: "optional", account: "resolve", bucket: "social_read", cache: "private" }, async (context) => {
        const callsign = profileCallsignParameter(context.request, "/connections");
        const query = parseConnectionQuery(new URL(context.request.url), callsign);
        const viewerId = context.request.headers.get("x-blast-public-view") === "1" ? null : context.account?.account_id ?? null;
        if (query.tab === null) return context.json(await onPrimary((db) => readConnectionCounts(db, callsign, viewerId)));
        const page = { ...query, tab: query.tab };
        return context.json(await onPrimary((db) => readConnections(db, callsign, viewerId, page)));
      }),
    }),
    profile: Object.freeze({
      GET: kit.route(spec(SOCIAL_PROFILE_ROUTE), async (context) => {
        const callsign = profileCallsignParameter(context.request, "");
        const includeBio = profileBioRequested(context.request);
        const profile = await timed("social.profile", () => publicRead(context, callsign, (db) => readProfile(db, callsign, includeBio)),
          { part: "identity" }, { sampleRate: 0.1 });
        return context.json(profile);
      }),
    }),
    items: Object.freeze({
      GET: kit.route(spec(SOCIAL_PROFILE_ITEMS_ROUTE), async (context) => {
        const url = new URL(context.request.url);
        const callsign = profileCallsignParameter(context.request, "/items");
        const { limit, before } = parseItemPage(pageQuery(url));
        const settings = await config();
        const page = await timed("social.profile", () =>
          publicRead(context, callsign, (db) => readProfileItemsPage(db, callsign, { config: settings, nowMs: now(), limit, before })),
        { part: "items" }, { sampleRate: 0.1 });
        return context.json(page);
      }),
    }),
    calls: Object.freeze({
      GET: kit.route(spec(SOCIAL_PROFILE_CALLS_ROUTE), async (context) => {
        const callsign = profileCallsignParameter(context.request, "/calls");
        const body = await timed("social.profile", () =>
          publicRead(context, callsign, async (db): Promise<SocialProfileCalls | null> => {
            const [account, asOf] = await Promise.all([readProfileAccount(db, callsign), readAsOf(db)]);
            if (!account) return null;
            if (!asOf) throw new SocialRouteError("service_unavailable");
            return { ...(await readCalls(db, account.accountId, now())), as_of: asOf };
          }),
        { part: "calls" }, { sampleRate: 0.1 });
        return context.json(body);
      }),
    }),
    theses: Object.freeze({
      GET: kit.route(spec(SOCIAL_PROFILE_THESES_ROUTE), async (context) => {
        const url = new URL(context.request.url);
        const callsign = profileCallsignParameter(context.request, "/theses");
        const query = pageQuery(url);
        const limit = parseItemLimit(query.get("limit"));
        const cursor = query.get("cursor");
        const before = cursor === null ? null : decodeThesisCursor(cursor);
        const settings = await config();
        const page = await timed("social.profile", () =>
          publicRead(context, callsign, async (db): Promise<SocialProfileItemsPage | null> => {
            const [account, asOf] = await Promise.all([readProfileAccount(db, callsign), readAsOf(db)]);
            if (!account) return null;
            if (!asOf) throw new SocialRouteError("service_unavailable");
            const entries = await thesisEntriesOf(db, account.accountId, { limit, before });
            return {
              items: await toItems(db, entries, { nowMs: now(), config: settings }),
              next_cursor: nextThesisCursor(entries, limit),
              as_of: asOf,
            };
          }),
        { part: "theses" }, { sampleRate: 0.1 });
        return context.json(page);
      }),
    }),
    mutuals: Object.freeze({
      GET: kit.route(viewerSpec(SOCIAL_PROFILE_MUTUALS_ROUTE), async (context) => {
        const callsign = profileCallsignParameter(context.request, "/mutuals");
        const viewerId = context.account!.account_id;
        const body = await timed("social.profile_viewer", () => onPrimary(async (db) => {
          if (!(await readProfileAccount(db, callsign))) throw new SocialRouteError("not_found");
          return readMutuals(db, viewerId, callsign);
        }), { part: "mutuals" }, { sampleRate: 0.1 });
        return context.json(body);
      }),
    }),
    createdPresales: Object.freeze({
      GET: kit.route(viewerSpec(`GET ${SOCIAL_CREATED_PRESALES_PATH}`), async (context) => {
        const presales = await onPrimary(async (db) => {
          const accountId = context.account!.account_id;
          const addresses = await readAccountAddresses(db, accountId);
          const ids = await readCreatedPresaleIds(db, accountId, addresses);
          const nowMs = now();
          const summaries = new Map((await readSummaries(db, ids)).map((row) => [row.presale_id, summaryOf(row, nowMs)]));
          return ids.flatMap((id) => {
            const sale = summaries.get(id);
            return sale ? [sale] : [];
          });
        });
        return context.json({ presales } satisfies SocialCreatedPresales);
      }),
    }),
    mePresales: Object.freeze({
      GET: kit.route(viewerSpec(SOCIAL_ME_PRESALES_ROUTE), async (context) => {
        const accountId = context.account!.account_id;
        const body = await timed("social.profile_viewer", () => onPrimary((db) => readMePresales(db, accountId, now())),
          { part: "me_presales" }, { sampleRate: 0.1 });
        return context.json(new URL(context.request.url).searchParams.get("view") === "positions" ? { ...body, coins: [] } : body);
      }),
    }),
  });
}
import { socialSingle } from "@blast/server/modules/social/route-kit/validation.ts";
