import { socialPresaleViewerRequestSchema } from "@blast/core/modules/social/contracts/presale-schemas.ts";
import { CREATE_TEST_SUI_QUOTE_TYPE } from "@blast/core/modules/social/contracts/create.ts";
import { socialPresaleListPath } from "@blast/core/modules/social/contracts/presales.ts";
import type { createPublicPresaleReader } from "@blast/server/modules/social/presales/public-reads.ts";
import { withCatalogTerms } from "@blast/server/modules/social/presales/catalog-terms.ts";
import { socialInput, socialParameter, socialSingle } from "@blast/server/modules/social/route-kit/validation.ts";
import { z } from "zod";
import { recordMetric } from "@blast/core/lib/metrics.ts";
import type { ReadableDatabase } from "@blast/core/modules/database/transaction.ts";
import type { SocialConfig } from "@blast/core/modules/social/contracts/config.ts";
import {
  PRESALE_LIST_DEFAULT_LIMIT,
  PRESALE_LIST_MAX_LIMIT,
  PRESALE_LIST_SORTS,
  PRESALE_LIST_TRUST_FILTERS,
  SOCIAL_PRESALE_LIST_ROUTE,
  SOCIAL_PRESALE_ROUTE,
  PRESALE_COMMIT_FIELDS_HEADER,
  SOCIAL_PRESALE_VIEWER_ROUTE,
  isPresaleListSort,
  isPresaleListStatus,
  type PresaleListSort,
  type PresaleListStatus,
  type PresaleListTrustFilter,
  type SocialPresaleDetail,
  type SocialPresaleListPage,
} from "@blast/core/modules/social/contracts/presales.ts";
import { readAsOf } from "@blast/server/modules/social/items/index.ts";
import { readAccountAddresses } from "@blast/server/modules/social/accounts/read-wallet-addresses.ts";
import { SocialRouteError } from "@blast/core/modules/social/route-kit/errors.ts";
import { readSocialJson, type SocialCaller, type SocialRouteKit } from "@blast/server/modules/social/route-kit/route.ts";
import { readPresaleDetail, type PresaleTermsSource } from "@blast/server/modules/social/presales/detail.ts";
import { chainViewsOnly } from "@blast/core/modules/social/presales/sql.ts";
import { decodeListCursor, readStatusCounts, readSummaries, readSummaryPage, summaryOf } from "@blast/server/modules/social/presales/summary.ts";
import { readViewerBackedPresales, readViewerOwnPresales, readViewerPresales } from "@blast/server/modules/social/presales/viewer.ts";
import { readBackerSamples, withBackerSamples } from "@blast/server/modules/social/presales/backer-sample.ts";
import { SUI_OBJECT_ID_PATTERN } from "@blast/core/lib/sui/ids.ts";
import { routeSegments } from "@blast/core/modules/backend-api/route-path.ts";
import { PRESALE_READ, webPath } from "@blast/server/modules/partner-api/v1/paths.ts";

export type PresaleListRequest = Readonly<{
  status: PresaleListStatus;
  sort: PresaleListSort;
  cursor: string | null;
  limit: number;
  /** On-chain partner object ID, independent of the caller's API account. */
  partnerId?: string;
  /** R3-23's trust filters, present only when at least one is on. */
  trust?: readonly PresaleListTrustFilter[];
}>;

function single(url: URL, name: string): string | null {
  return socialSingle(url.searchParams, name);
}

/**
 * The list query from a URL: `status`, `sort`, `cursor`, `limit`,
 * `partner_id`, `verified_team` and `audited`, each at most once; others ignored. A trust
 * filter's only value is `true`.
 */
export function parsePresaleListQuery(url: URL): PresaleListRequest {
  const rawStatus = single(url, "status");
  const status = rawStatus ?? "live";
  if (!isPresaleListStatus(status)) throw new SocialRouteError("invalid_parameter", { extra: { parameter: "status" } });
  const rawSort = single(url, "sort");
  const sort = rawSort ?? PRESALE_LIST_SORTS[status][0];
  if (!isPresaleListSort(status, sort)) throw new SocialRouteError("invalid_parameter", { extra: { parameter: "sort" } });
  const rawLimit = single(url, "limit");
  const limit = socialParameter(z.string().regex(/^[1-9][0-9]?$/).transform(Number).pipe(z.number().max(PRESALE_LIST_MAX_LIMIT)).nullable().transform((value) => value ?? PRESALE_LIST_DEFAULT_LIMIT), rawLimit, "limit");
  const trust = PRESALE_LIST_TRUST_FILTERS.filter((filter) => {
    const raw = single(url, filter);
    socialParameter(z.literal("true").nullable(), raw, filter);
    return raw === "true";
  });
  const partnerId = single(url, "partner_id");
  socialParameter(z.string().regex(SUI_OBJECT_ID_PATTERN).nullable(), partnerId, "partner_id");
  return { status, sort, cursor: single(url, "cursor"), limit,
    ...(partnerId !== null ? { partnerId } : {}), ...(trust.length > 0 ? { trust } : {}) };
}

/** A readable watermark, or `service_unavailable`: without it the data's freshness is unknown. */
async function asOfOrUnavailable(db: ReadableDatabase) {
  const asOf = await readAsOf(db);
  if (!asOf) throw new SocialRouteError("service_unavailable");
  return asOf;
}

/** One list page, exactly as the route answers it (the `/presale` page renders the first). */
export async function readPresaleListPage(
  database: ReadableDatabase,
  request: PresaleListRequest,
  nowMs: number,
  terms?: PresaleTermsSource,
): Promise<SocialPresaleListPage> {
  const db = chainViewsOnly(database);
  const cursor = request.cursor === null ? null : decodeListCursor(request.cursor);
  const asOf = await asOfOrUnavailable(db);
  // Windows end at the watermark, never past now.
  const [page, statusCounts] = await Promise.all([
    readSummaryPage(db, { ...request, cursor, nowMs, asOfMs: Math.min(asOf.timestamp_ms, nowMs) }),
    readStatusCounts(db, { ...request, nowMs }),
  ]);
  const [presales, sampled] = await Promise.all([
    withCatalogTerms(page.rows.map((row) => summaryOf(row, nowMs)), terms),
    readBackerSamples(db, page.rows.map((row) => row.presale_id)),
  ]);
  return {
    presales: presales.map((sale) => ({ ...sale, backers_sample: sampled.get(sale.presale_id) ?? [] })),
    next_cursor: page.nextCursor,
    status_counts: statusCounts,
    as_of: asOf,
  };
}

/** Resolve Home's admin pins in one canonical batch, keeping newest-pin order and the list's visibility rules. */
export async function readFeaturedPresales(database: ReadableDatabase, nowMs: number) {
  const db = chainViewsOnly(database);
  await asOfOrUnavailable(db);
  const pins = await db.read<{ presale_id: string }>(`SELECT presale_id FROM social_presale_pins
    ORDER BY pinned_at DESC, presale_id COLLATE "C" DESC`);
  const ordered = pins.rows.map((pin) => pin.presale_id);
  if (ordered.length === 0) return [];
  const summaries = new Map((await readSummaries(db, ordered)).map((row) => [row.presale_id, summaryOf(row, nowMs)]));
  const featured = ordered.flatMap((id) => {
    const sale = summaries.get(id);
    return sale && sale.quote_type !== CREATE_TEST_SUI_QUOTE_TYPE && (sale.phase === "open" || sale.phase === "pending")
      ? [sale]
      : [];
  });
  return withBackerSamples(db, featured);
}

/** One sale, exactly as the route answers it, or null when blast-infra has no such sale. */
export async function readPresalePage(
  database: ReadableDatabase,
  presaleId: string,
  options: Readonly<{ nowMs: number; config: SocialConfig; terms: PresaleTermsSource }>,
): Promise<SocialPresaleDetail | null> {
  const db = chainViewsOnly(database);
  const asOf = await asOfOrUnavailable(db);
  return readPresaleDetail(db, presaleId, { ...options, asOf });
}

const PRESALE_PATH = webPath(PRESALE_READ);

/** The presale id in `/api/social/presales/{presale_id}`, or `invalid_parameter` (`presale_id`). */
export function presaleIdParameter(request: Request): string {
  const raw = routeSegments(PRESALE_PATH, new URL(request.url).pathname)?.presale_id ?? "";
  socialParameter(z.string().regex(SUI_OBJECT_ID_PATTERN), raw, "presale_id");
  return raw;
}

function presaleDetailResponse(detail: SocialPresaleDetail, includeCommitFields: boolean): SocialPresaleDetail {
  if (includeCommitFields || detail.terms?.eligible_uncapped_from_ms === undefined) return detail;
  const { eligible_uncapped_from_ms, ...terms } = detail.terms;
  void eligible_uncapped_from_ms;
  return { ...detail, terms };
}

export type SocialPresaleRouteDependencies = Readonly<{
  kit: SocialRouteKit;
  /** The read replica in production. Resolved per request. */
  database: () => ReadableDatabase;
  followingDatabase?: ReadableDatabase;
  config: () => Promise<SocialConfig>;
  terms: PresaleTermsSource;
  now?: () => number;
  publicRead?: ReturnType<typeof createPublicPresaleReader>;
  blastWallet?: (caller: SocialCaller) => Promise<string | null>;
}>;

/**
 * The presale pages' routes (contract in `contracts/presales.ts`). The two
 * public reads never read the caller and are CDN-cacheable; the viewer read
 * requires an account and is `private, no-store`. Every read runs on
 * `database()`, the replica.
 */
export function createSocialPresaleRoutes(dependencies: SocialPresaleRouteDependencies) {
  const { kit, database, config, terms } = dependencies;
  const followingDatabase = dependencies.followingDatabase && chainViewsOnly(dependencies.followingDatabase);
  const now = dependencies.now ?? Date.now;
  const publicRead = dependencies.publicRead ?? ((_key, load) => load());
  const publicSpec = (name: string) => ({ name, auth: "none", bucket: "social_read_presales", cache: "public" }) as const;
  return Object.freeze({
    featured: Object.freeze({
      GET: kit.route(publicSpec("GET /api/social/presales/featured"), async (context) =>
        context.json({ presales: await publicRead("featured", () => readFeaturedPresales(database(), now()), 10_000) })),
    }),
    list: Object.freeze({
      GET: kit.route(publicSpec(SOCIAL_PRESALE_LIST_ROUTE), async (context) => {
        const started = performance.now();
        const request = parsePresaleListQuery(new URL(context.request.url));
        const page = await publicRead(`list:${socialPresaleListPath(request)}`, () => readPresaleListPage(database(), request, now(), terms), 10_000);
        recordMetric("social.presales", {
          route: "list",
          status: request.status,
          sort: request.sort,
          trust: request.trust?.join(",") ?? "none",
          ms: Math.round(performance.now() - started),
        });
        return context.json(page);
      }),
    }),
    presale: Object.freeze({
      // Lifecycle hints must read the current phase, without the edge stale window.
      GET: kit.route({ ...publicSpec(SOCIAL_PRESALE_ROUTE), cache: "no-store" }, async (context) => {
        const started = performance.now();
        const presaleId = presaleIdParameter(context.request);
        const detail = await publicRead(`detail:${presaleId}`, async () => readPresalePage(database(), presaleId, { nowMs: now(), config: await config(), terms }), 0);
        if (!detail) throw new SocialRouteError("not_found");
        recordMetric("social.presales", { route: "detail", terms: detail.terms ? "ok" : "missing", ms: Math.round(performance.now() - started) });
        const answer = context.json(presaleDetailResponse(detail, context.request.headers.get(PRESALE_COMMIT_FIELDS_HEADER) === "1"));
        answer.headers.append("Vary", PRESALE_COMMIT_FIELDS_HEADER);
        return answer;
      }),
    }),
    viewer: Object.freeze({
      POST: kit.route(
        { name: SOCIAL_PRESALE_VIEWER_ROUTE, auth: "account", account: "required", bucket: "social_read", cache: "private" },
        async (context) => {
          const started = performance.now();
          const body = socialInput(
            socialPresaleViewerRequestSchema,
            await readSocialJson(context.request, [], ["presale_ids", "status", "mine"]),
          );
          const accountId = context.account!.account_id;
          const db = chainViewsOnly(database());
          const own = await readAccountAddresses(db, accountId);
          const claimWallet = dependencies.blastWallet ? await dependencies.blastWallet(context.caller!) : own.length === 1 ? own[0]! : null;
          if ("mine" in body) {
            const answer = await readViewerOwnPresales(db, own, now(), claimWallet);
            recordMetric("social.presales", { route: "viewer", scope: "mine", ms: Math.round(performance.now() - started) });
            return context.json({ ...answer, rows: await withCatalogTerms(answer.rows ?? [], terms) });
          }
          if ("presale_ids" in body) {
            const includeCommitFields = context.request.headers.get(PRESALE_COMMIT_FIELDS_HEADER) === "1";
            let followingUnavailable = false;
            const following = followingDatabase ? {
              database: followingDatabase,
              onUnavailable: () => { followingUnavailable = true; },
            } : undefined;
            const answer = await readViewerPresales(db, accountId, own, body.presale_ids, claimWallet, includeCommitFields, following);
            recordMetric("social.presales", { route: "viewer", scope: "ids", ms: Math.round(performance.now() - started) });
            const response = context.json(answer);
            if (followingUnavailable) response.headers.set("X-Blast-Presale-Following", "unavailable");
            return response;
          }
          const answer = await readViewerBackedPresales(db, accountId, own, body.status, now(), claimWallet, followingDatabase);
          recordMetric("social.presales", { route: "viewer", scope: "status", ms: Math.round(performance.now() - started) });
          return context.json({ ...answer, rows: await withCatalogTerms(answer.rows ?? [], terms) });
        },
      ),
    }),
  });
}
