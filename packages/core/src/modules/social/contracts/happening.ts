import type {
  HomeWire,
  happeningPresaleSchema,
  happeningTapeEventSchema,
  happeningTopCoinSchema,
  socialHappeningResponseSchema,
} from "./home-schemas.ts";
import type { z } from "zod";

/**
 * `GET /api/social/happening`: Home's live public reads (FEATURE-MAP §5,
 * §16, §17; T-011): the last hour's totals, the live activity tape, the
 * fastest filling open presales, the presales opening soon and the "Today on
 * Blast" recap. With `recent_presales=1`, it also returns open presales ranked
 * by their latest commit in the last hour for Discover. Version 2 also returns
 * the number of distinct backing wallets and the committed quote atoms in that hour,
 * plus a shortlist of live bonding curves with confirmed activity in that hour.
 * JSON Schema: `schemas/happening-response.schema.json`.
 *
 * - No authentication; the Authorization header and the wallet cookie are
 *   never read. Every answer is the same for every caller, so a 200 is
 *   publicly cached (`public, s-maxage=10, stale-while-revalidate=20`) and
 *   carries no viewer field. What a viewer adds (followed backers' faces,
 *   "Following" and "Follows you" tags, a presale's bell) comes from
 *   `POST /api/social/viewer-state`.
 * - Read on the replica, only through `chain_read_v1` views; bucket
 *   `social_read` (IP).
 * - Bounded by the watermark: activity counts only up to each pipeline's
 *   committed checkpoint, and the chain clock (`clock_ms`) is the earlier of
 *   the presale pipeline's committed time and the server's clock, so a lagging
 *   indexer never shrinks the last hour. With no readable watermark the read
 *   is `503 service_unavailable`; lag itself never fails it (`as_of.lag_ms`).
 * - Only sales the web shows: the tape and the last hour leave out every
 *   activity row of a sale `SHOWN_PRESALES` does not have (T-043's hidden test
 *   sales, which `chain_read_v1.activity` still carries, and a sale whose coin
 *   metadata has not arrived), and a left-out row never takes a tape place.
 *
 * The client reads it again on its own schedule (the home page's 30 s poll
 * while visible, T-012; the blast-infra activity hint later, T-035) and
 * animates what changed.
 */
export const SOCIAL_HAPPENING_ROUTE = "GET /api/social/happening";
export const SOCIAL_HAPPENING_PATH = "/api/social/happening";
export const HAPPENING_RECENT_PRESALES_PARAM = "recent_presales";
export const SOCIAL_HAPPENING_DISCOVER_PATH = `${SOCIAL_HAPPENING_PATH}?${HAPPENING_RECENT_PRESALES_PARAM}=2`;

/** The tape's newest events (four show; the rest let a refresh slide in what it missed). */
export const HAPPENING_TAPE_MAX = 8;
/** At most this many rows in "Fastest filling", "Opening soon" and the original recent-presale read. */
export const HAPPENING_LIST_MAX = 5;
export const HAPPENING_DISCOVER_SALE_MAX = 10;
export const HAPPENING_CURVE_MAX = 20;
/** At most this many slides in "Today on Blast". */
export const HAPPENING_TODAY_MAX = 8;
/** "In the last hour". */
export const HAPPENING_LAST_HOUR_MS = 3_600_000;
/** The activity kinds the tape shows; the trade kinds join them only while trading is visible (OA-7). */
export const HAPPENING_TAPE_KINDS = [
  "presale_commit",
  "presale_claim",
] as const;

export type HappeningTapeKind = HappeningTapeEvent["kind"];

/**
 * A presale on Home: the post chip's presale (`FeedItemPresale`) and what the
 * right column and the recap add.
 */
export type HappeningPresale = HomeWire<z.infer<typeof happeningPresaleSchema>>;

/** One tape row: who did what, to which presale or coin, when. */
export type HappeningTapeEvent = HomeWire<
  z.infer<typeof happeningTapeEventSchema>
>;

export type HappeningCoin = HomeWire<z.infer<typeof happeningTopCoinSchema>>;
export type HappeningCurve = NonNullable<SocialHappeningResponse["active_curves"]>[number];

export type TopCoins = NonNullable<SocialHappeningResponse["top_coins"]>;

export type SocialHappeningResponse = HomeWire<
  z.infer<typeof socialHappeningResponseSchema>
>;
