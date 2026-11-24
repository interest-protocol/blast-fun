import { z } from "zod";

import type {
  PresaleReadonly,
  socialPresalePersonSchema,
  socialPresaleSummarySchema,
  socialPresaleRowsSchema,
  presaleStatusCountsSchema,
  socialPresaleListPageSchema,
  socialPresaleMomentumSchema,
  socialPresaleBackerSchema,
  socialPresaleThesisSchema,
  socialPresaleRaiseMarkerSchema,
  socialPresaleRaiseSchema,
  socialPresaleShareSchema,
  socialPresaleVestingSchema,
  socialPresaleRecipientSchema,
  socialPresaleTermsSchema,
  socialQuotePriceSchema,
  buyerVestingTotalsSchema,
  buyerVestingPositionSchema,
  socialPresaleDetailSchema,
  socialPresaleViewerRequestSchema,
  socialPresaleFollowedBackerSchema,
  socialPresaleViewerEntrySchema,
  socialPresaleViewerResponseSchema,
} from "./presale-schemas.ts";

/**
 * The presales list and sale pages (canonical UI §9, §10; UI-09/10). Chain
 * facts come from blast-infra's `chain_read_v1` views (presales, lifecycle,
 * positions, prices, activity, vesting schedules), bounded by the watermark
 * (`as_of`); social facts (interest, named backers, theses, rockets) from the
 * social tables under the naming rule (`read-model/naming.ts`). Terms
 * (supply and raise split) come from blast-infra's presale projection
 * through the presale module, and are null while it cannot be read.
 *
 * Public reads (`auth: "none"`, bucket `social_read_presales`, read on the replica,
 * List reads use `public, s-maxage=10, stale-while-revalidate=20` on a 200.
 * Detail reads use `no-store` so lifecycle hints immediately see migrations; errors
 * `no-store`), never a viewer field:
 *
 * - `GET /api/social/presales?status=&sort=&cursor=&limit=`: one page of a
 *   status's presales (`SocialPresaleListPage`). `status` is `live`
 *   (default), `upcoming` or `ended`; `sort` one of that status's
 *   `PRESALE_LIST_SORTS` (default its first); `limit` 1 to 50 (default 20);
 *   `cursor` the previous page's `next_cursor` (keyset; the same `status`,
 *   `sort` and filters must be passed). `verified_team=true` and
 *   `audited=true` (R3-23, each optional, `true` the only value) keep only the
 *   sales whose trust flag is set. Schema `presale-list-page`.
 * - `GET /api/social/presales/featured`: `{ presales: SocialPresaleSummary[] }`,
 *   Blast's ordered editorial IDs resolved against shown canonical presales;
 *   only open and pending projects. Empty configuration returns an empty array.
 * - `GET /api/social/presales/{presale_id}`: one sale (`SocialPresaleDetail`).
 *   Schema `presale-detail`.
 *
 * Personal read (account required, bucket `social_read`, `private,
 * no-store`, never cached):
 *
 * - `POST /api/social/presales/viewer` with `{ presale_ids }` (1 to
 *   `PRESALE_VIEWER_MAX_IDS` ids): for each id, the accounts the caller
 *   follows that backed it (named only) and the caller's own commitment and
 *   commits (`SocialPresaleViewerResponse`). With `{ status }` instead it
 *   answers the presales of that status the caller's follows backed, most
 *   followed backers first (at most `PRESALE_VIEWER_MAX_IDS`, no paging): the
 *   "Backed by people you follow" filter. With `{ mine: true }` it answers
 *   the sales the caller committed to, newest commit first, with their rows
 *   and the caller's position ("Your presales"). Exactly one of the three.
 *   Schemas `presale-viewer-request`, `presale-viewer-response`.
 *
 * Refusals: a malformed parameter is `400 invalid_parameter` (`parameter`
 * names it); a malformed body `400 invalid_request`; an unknown presale `404
 * not_found`; no readable watermark `503 service_unavailable`.
 */
export const SOCIAL_PRESALE_LIST_ROUTE = "GET /api/social/presales";
export const SOCIAL_PRESALE_ROUTE = "GET /api/social/presales/{presale_id}";
export const SOCIAL_PRESALE_VIEWER_ROUTE = "POST /api/social/presales/viewer";
export const SOCIAL_PRESALES_PATH = "/api/social/presales";
// Older tabs parse the original response shape strictly.
export const PRESALE_COMMIT_FIELDS_HEADER = "x-blast-presale-commit-fields";
export const SOCIAL_PRESALE_VIEWER_PATH = "/api/social/presales/viewer";
/** Private creator discovery, using the same ownership rules as the profile's Created section. */
export const SOCIAL_CREATED_PRESALES_PATH = "/api/social/me/presales/created";
export type SocialCreatedPresales = PresaleReadonly<
  z.infer<typeof socialPresaleRowsSchema>
>;

export const PRESALE_LIST_STATUSES = ["live", "upcoming", "ended"] as const;
export type PresaleListStatus = (typeof PRESALE_LIST_STATUSES)[number];

/** The server-side orders of each tab, default first. "Backed by people you follow" is the viewer route; "Watchlist" a later section. */
export const PRESALE_LIST_SORTS = Object.freeze({
  live: ["pinned", "ending", "fastest", "backed"],
  upcoming: ["opening", "interest"],
  ended: ["recent", "best", "backed"],
} as const satisfies Record<PresaleListStatus, readonly string[]>);
export type PresaleListSort =
  (typeof PRESALE_LIST_SORTS)[PresaleListStatus][number];

/**
 * The list's trust filters (R3-23): `?verified_team=true`, `?audited=true`,
 * either or both. Each keeps the sales whose flag is set. There is no LP-lock
 * filter (§22.1 defect 1, OA-25 Q8): every Blast pool's LP position is locked
 * for good by the contracts (OA-26), so it is stated for every sale and would
 * filter nothing.
 */
export const PRESALE_LIST_TRUST_FILTERS = ["verified_team", "audited"] as const;
export type PresaleListTrustFilter =
  (typeof PRESALE_LIST_TRUST_FILTERS)[number];

export const PRESALE_LIST_DEFAULT_LIMIT = 20;
export const PRESALE_LIST_MAX_LIMIT = 50;
export const PRESALE_VIEWER_MAX_IDS = 50;
/** The backers table: the largest this many wallets. */
export const PRESALE_TOP_BACKERS = 25;
/** A list summary's facepile: at most this many named backers, the latest first. */
export const PRESALE_BACKER_SAMPLE = 3;
/** How many of a sale's latest commits the facepile reads to find them (a bounded index walk). */
export const PRESALE_BACKER_SAMPLE_COMMITS = 24;
/** A commit at least this big is marked on the raise chart ("Big commits"). */
export const PRESALE_BIG_COMMIT_USD = 5_000;
/** "Big vs small" counts commits of at least this much as big. */
export const PRESALE_MOMENTUM_BIG_USD = 1_000;
/** The momentum windows, in milliseconds. */
export const PRESALE_MOMENTUM_WINDOWS = Object.freeze({
  "5m": 300_000,
  "1h": 3_600_000,
  "4h": 14_400_000,
  "1d": 86_400_000,
});
export type PresaleMomentumWindow = keyof typeof PRESALE_MOMENTUM_WINDOWS;

/**
 * Where a sale stands: `pending` (not open yet), `open`, `closed` (its end
 * passed, the chain has not settled it yet), `funded`, `trading` (migrated to
 * its pool) or `cancelled`.
 */
export const PRESALE_PHASES = [
  "pending",
  "open",
  "closed",
  "funded",
  "trading",
  "cancelled",
] as const;
export type PresalePhase = (typeof PRESALE_PHASES)[number];

/** A named account, as every social read names one. `verified` = X linked (OA-8). */
export type SocialPresalePerson = PresaleReadonly<
  z.infer<typeof socialPresalePersonSchema>
>;

/**
 * One sale in a list. USD amounts are decimal strings to two places; a
 * USDC-quoted sale's amounts are face value, any other quote is priced at its
 * latest `chain_read_v1.prices` row (null without one). `fill_bps` is raised
 * over target from the atoms. Prices are USD per whole token, decimal
 * strings; `presale_price_usd` is what buyers paid (from the claims of a
 * trading sale; null before the first claim), `multiple` the current price
 * over it.
 */
export type SocialPresaleSummary = PresaleReadonly<
  z.infer<typeof socialPresaleSummarySchema>
>;

/** How many presales each status tab holds now (the "Live 6 · Upcoming 4" tab counts). */
export type PresaleStatusCounts = PresaleReadonly<
  z.infer<typeof presaleStatusCountsSchema>
>;

export type SocialPresaleListPage = PresaleReadonly<
  z.infer<typeof socialPresaleListPageSchema>
>;

export type SocialPresaleMomentum = PresaleReadonly<
  z.infer<typeof socialPresaleMomentumSchema>
>;

export type SocialPresaleBacker = PresaleReadonly<
  z.infer<typeof socialPresaleBackerSchema>
>;

export type SocialPresaleThesis = PresaleReadonly<
  z.infer<typeof socialPresaleThesisSchema>
>;

/** A commit marked on the raise chart: big, or explained by a thesis. */
export type SocialPresaleRaiseMarker = PresaleReadonly<
  z.infer<typeof socialPresaleRaiseMarkerSchema>
>;

export type SocialPresaleRaise = PresaleReadonly<
  z.infer<typeof socialPresaleRaiseSchema>
>;
export const PRESALE_RAISE_POINTS = 160;

export type SocialPresaleShare = PresaleReadonly<
  z.infer<typeof socialPresaleShareSchema>
>;

/**
 * A sale's vesting (OA-18, `contracts/vesting.ts`): nothing unlocks before
 * `cliff_end_ms` (the start without a cliff); then what vested linearly since
 * `start_ms` unlocks at once and the rest steadily until `end_ms`. Times are
 * ms, clamped to `VESTING_MAX_MS`.
 */
export type SocialPresaleVesting = PresaleReadonly<
  z.infer<typeof socialPresaleVestingSchema>
>;
export type SocialPresaleRecipient = PresaleReadonly<
  z.infer<typeof socialPresaleRecipientSchema>
>;

/** The sale's terms from its presale projection (presale scope). Amounts are atoms. */
export type SocialPresaleTerms = PresaleReadonly<
  z.infer<typeof socialPresaleTermsSchema>
>;

/**
 * R3-40: the quote coin's `chain_read_v1.prices` row — USD a whole coin and
 * when it was taken — for a dollar equivalent shown at display time ("at
 * today’s SUI price"). Presentation only: nothing stores, compares or sums it.
 */
export type SocialQuotePrice = PresaleReadonly<
  z.infer<typeof socialQuotePriceSchema>
>;

/** Actual escrow balances, including completed schedules. Amounts are exact token atoms. */
export type BuyerVestingTotals = PresaleReadonly<
  z.infer<typeof buyerVestingTotalsSchema>
>;
export type BuyerVestingPosition = PresaleReadonly<
  z.infer<typeof buyerVestingPositionSchema>
>;

// The application may enrich a detail row with optional list fields (for example
// the backer facepile). Keep that model derived from both published row schemas.
export type SocialPresaleDetail = PresaleReadonly<
  Omit<z.infer<typeof socialPresaleDetailSchema>, "presale"> & {
    presale: z.infer<typeof socialPresaleDetailSchema>["presale"] &
      z.infer<typeof socialPresaleSummarySchema>;
  }
>;

export type SocialPresaleViewerRequest = PresaleReadonly<
  z.infer<typeof socialPresaleViewerRequestSchema>
>;

export type SocialPresaleFollowedBacker = PresaleReadonly<
  z.infer<typeof socialPresaleFollowedBackerSchema>
>;

export type SocialPresaleViewerEntry = PresaleReadonly<
  z.infer<typeof socialPresaleViewerEntrySchema>
>;

export type SocialPresaleViewerResponse = PresaleReadonly<
  z.infer<typeof socialPresaleViewerResponseSchema>
>;

/** `GET` path of a presale list page. */
export function socialPresaleListPath(
  query: Readonly<{
    status?: PresaleListStatus;
    sort?: string;
    cursor?: string | null;
    limit?: number;
    partnerId?: string;
    trust?: readonly PresaleListTrustFilter[];
  }> = {},
): string {
  const params = new URLSearchParams();
  if (query.status) params.set("status", query.status);
  if (query.sort) params.set("sort", query.sort);
  if (query.partnerId) params.set("partner_id", query.partnerId);
  for (const filter of PRESALE_LIST_TRUST_FILTERS)
    if (query.trust?.includes(filter)) params.set(filter, "true");
  if (query.cursor) params.set("cursor", query.cursor);
  if (query.limit) params.set("limit", String(query.limit));
  const search = params.toString();
  return search ? `${SOCIAL_PRESALES_PATH}?${search}` : SOCIAL_PRESALES_PATH;
}

/** `GET` path of one sale. */
export function socialPresalePath(presaleId: string): string {
  return `${SOCIAL_PRESALES_PATH}/${encodeURIComponent(presaleId)}`;
}

export const presaleListStatusSchema = z.enum(PRESALE_LIST_STATUSES);

/**
 * A sale's chain lifecycle as it reads at `nowMs`: a sale shared with a scheduled start is `open` on chain from the
 * share (`blast_presale::share`), but `blast_presale::commit` refuses it until `start_ms`, so it reads `pending`
 * (upcoming) until then. Without a start the chain's lifecycle stands. `upcomingSaleSql` is its SQL twin.
 */
export function saleLifecycleAt<L extends string>(
  lifecycle: L,
  startMs: number | undefined,
  nowMs: number,
): L | "pending" {
  return lifecycle === "open" && startMs !== undefined && startMs > nowMs
    ? "pending"
    : lifecycle;
}

export function isPinnablePresale(
  sale: Readonly<{ lifecycle: string; end_ms: number }>,
  nowMs: number,
): boolean {
  return (
    sale.lifecycle === "pending" ||
    (sale.lifecycle === "open" && sale.end_ms > nowMs)
  );
}

export function isPresaleListStatus(
  value: unknown,
): value is PresaleListStatus {
  return presaleListStatusSchema.safeParse(value).success;
}

export function isPresaleListSort(
  status: PresaleListStatus,
  value: unknown,
): value is PresaleListSort {
  return z.enum(PRESALE_LIST_SORTS[status]).safeParse(value).success;
}
