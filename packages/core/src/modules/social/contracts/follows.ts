/**
 * Follows: an account follows another Blast Account (by callsign) or a
 * presale (by presale id). There is no follow of an address.
 *
 * - `PUT /api/social/follows/account/{callsign}` and
 *   `PUT /api/social/follows/presale/{presale_id}`: `204`, idempotent. A new
 *   follow is stored with `source = 'user'`; an existing one is kept as it is.
 * - `DELETE` on the same paths: `204` whether or not the follow existed.
 *
 * Signed-in account required (`401 unauthorized`, `409 account_required`),
 * bucket `social_follow` (120 per minute per account, then `429
 * rate_limited` with `Retry-After`), written on the primary, `Cache-Control:
 * no-store`. Refusals:
 *
 * - a malformed callsign or presale id: `400 invalid_parameter` (`parameter`
 *   names it);
 * - a callsign no account holds, or a presale id not in
 *   `chain_read_v1.presales`: `404 not_found` (a presale `DELETE` needs no
 *   such row, so a follow can always be removed);
 * - following one's own callsign: `422 cannot_follow_self` (a `DELETE` of it
 *   is a `204`: there is nothing to remove);
 * - a new follow past `SOCIAL_FOLLOW_LIMIT` targets: `422 follow_limit`.
 */
export const SOCIAL_FOLLOW_ACCOUNT_ROUTE = "/api/social/follows/account/{callsign}";
export const SOCIAL_FOLLOW_PRESALE_ROUTE = "/api/social/follows/presale/{presale_id}";
export const SOCIAL_FOLLOW_ACCOUNT_PREFIX = "/api/social/follows/account/";
export const SOCIAL_FOLLOW_PRESALE_PREFIX = "/api/social/follows/presale/";

/** The most targets (accounts and presales together) one account can follow. */
export const SOCIAL_FOLLOW_LIMIT = 5_000;

export type SocialFollowTargetKind = "account" | "presale";

/** A follow target as a client names it: an account's callsign or a presale's id. */
export type SocialFollowTarget =
  | Readonly<{ kind: "account"; callsign: string }>
  | Readonly<{ kind: "presale"; presale_id: string }>;

/** The follow route's path for `target`; the id is URL-encoded. */
export function socialFollowPath(target: SocialFollowTarget): string {
  return target.kind === "account"
    ? `${SOCIAL_FOLLOW_ACCOUNT_PREFIX}${encodeURIComponent(target.callsign)}`
    : `${SOCIAL_FOLLOW_PRESALE_PREFIX}${encodeURIComponent(target.presale_id)}`;
}
