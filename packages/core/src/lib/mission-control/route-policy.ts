import { SOCIAL_PAGE_PATHS } from "@blast/core/lib/social-page-routes.ts";

export type MissionControlRouteDecision =
  | "allow"
  | "render-not-found"
  /** `/` while the social feed is on: an internal rewrite to `SOCIAL_ENTRY`. */
  | "rewrite-social"
  /** `/@<callsign>` while the social feed is on: an internal rewrite to the profile page (`socialProfileTarget`). */
  | "rewrite-profile"
  /** `/crew/<callsign>` while the social feed is on: a redirect to `/@<callsign>` (`socialProfileTarget`). */
  | "redirect-profile"
  | "not-found";

/** The social feed's home page (`src/app/(app)/(social)/feed`): `/` shows it while the social feed is on. */
export const SOCIAL_ENTRY = SOCIAL_PAGE_PATHS.feed;
// Vercel Cron calls these with CRON_SECRET; they keep running while hidden.
const MAINTENANCE_API_PREFIX = "/api/mission-control/maintenance/";
const CARD_PAGE = /^\/card\/[0-9a-f-]{36}$/i;
const CARD_IMAGE = /^\/card\/[0-9a-f-]{36}\/image$/i;
const REFERRAL_IMAGE = /^\/referral\/[a-z0-9_]{3,20}\/image$/i;
const PNL_CARD = /^\/card\/pnl\/[a-f0-9]{64}(?:\/image)?$/;
const RETIRED_NAMESPACES = ["/dev", "/posts", "/team", "/api/team-access", "/mission-control"];
const RETIRED_MISSION_CONTROL_API_PATHS = new Set([
  "/api/mission-control/admission",
  "/api/mission-control/callsign",
  "/api/mission-control/completion",
  "/api/mission-control/completion/wallet-challenge",
  "/api/mission-control/completion/wallet-proof",
  "/api/mission-control/owner/share",
]);
const PUBLIC_PAGE_NAMESPACES = [
  SOCIAL_PAGE_PATHS.coin, SOCIAL_PAGE_PATHS.launch, SOCIAL_PAGE_PATHS.bonding,
  SOCIAL_PAGE_PATHS.presales, SOCIAL_PAGE_PATHS.signIn, SOCIAL_PAGE_PATHS.settings, "/vesting",
];
const PUBLIC_API_NAMESPACES = ["/api/launchpad", "/api/presale", "/api/account", "/api/vesting"];

const SOCIAL_PAGE_NAMESPACES = [SOCIAL_ENTRY, "/crew", "/p", SOCIAL_PAGE_PATHS.notifications, SOCIAL_PAGE_PATHS.create, SOCIAL_PAGE_PATHS.portfolio, SOCIAL_PAGE_PATHS.invites, "/competitions"];
const SOCIAL_API_NAMESPACE = "/api/social";

/** The canonical profile URL (OA-4): `/@<one segment>`, the `@` possibly percent-encoded. */
const PROFILE_ALIAS = /^\/(?:@|%40)([^/]+)(\/(?:followers|following))?$/i;
/** The profile page's own path, which redirects to the alias while the feed is on. */
const PROFILE_PAGE = /^\/crew\/([^/]+)(\/(?:followers|following))?$/;
/** The profile page's route (`src/app/(app)/(social)/crew/[callsign]`); a folder name cannot start with `@`. */
const PROFILE_PAGE_PREFIX = "/crew/";

/**
 * Where a profile decision sends `pathname`: for `/@<callsign>` the profile
 * page it is rewritten to (`/crew/<callsign>`), for `/crew/<callsign>` the
 * canonical `/@<callsign>` it redirects to; null for any other path. The
 * segment is kept as given (the page answers not-found for one that is not a
 * callsign).
 */
export function socialProfileTarget(pathname: string): string | null {
  const alias = PROFILE_ALIAS.exec(pathname);
  if (alias) return `${PROFILE_PAGE_PREFIX}${alias[1]}${alias[2] ?? ""}`;
  const page = PROFILE_PAGE.exec(pathname);
  if (page) return `/@${page[1]}${page[2] ?? ""}`;
  return null;
}

function isWithin(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}
/** A `"not-found"` decision for `pathname` answers the published `not_found` JSON body. */
export function notFoundAnswersJson(pathname: string): boolean {
  return isWithin(pathname, SOCIAL_API_NAMESPACE);
}

export function decideMissionControlRoute(
  pathname: string,
  experienceEnabled: boolean,
  socialEnabled = false,
): MissionControlRouteDecision {
  if (RETIRED_MISSION_CONTROL_API_PATHS.has(pathname) || RETIRED_NAMESPACES.some((prefix) => isWithin(pathname, prefix))) {
    return "not-found";
  }
  if (pathname.startsWith("/api/")) return decideApiRoute(pathname, experienceEnabled, socialEnabled);

  if (pathname === "/") return socialEnabled ? "rewrite-social" : "allow";
  const socialDecision = decideSocialPage(pathname);
  if (socialDecision) return socialEnabled ? socialDecision : "not-found";

  // Only published card and referral URL formats may reach their dynamic routes.
  if (isWithin(pathname, "/card")) {
    return CARD_PAGE.test(pathname) || CARD_IMAGE.test(pathname) || PNL_CARD.test(pathname) ? "allow" : "not-found";
  }
  if (isWithin(pathname, "/referral")) return REFERRAL_IMAGE.test(pathname) ? "allow" : "not-found";
  return isPublicPage(pathname) ? "allow" : "render-not-found";
}

function isPublicPage(pathname: string): boolean {
  return pathname === "/privacy" || pathname === "/terms" ||
    PUBLIC_PAGE_NAMESPACES.some((prefix) => isWithin(pathname, prefix));
}

function decideApiRoute(pathname: string, experienceEnabled: boolean, socialEnabled: boolean): MissionControlRouteDecision {
  if (isWithin(pathname, SOCIAL_API_NAMESPACE)) return socialEnabled ? "allow" : "not-found";
  if (
    experienceEnabled ||
    pathname === "/api/gate" ||
    pathname.startsWith(MAINTENANCE_API_PREFIX) ||
    PUBLIC_API_NAMESPACES.some((prefix) => isWithin(pathname, prefix))
  ) return "allow";
  return "not-found";
}

function decideSocialPage(pathname: string): MissionControlRouteDecision | null {
  // Profiles live at `/@<callsign>`; the page's own path redirects there.
  if (PROFILE_ALIAS.test(pathname)) return "rewrite-profile";
  if (PROFILE_PAGE.test(pathname)) return "redirect-profile";
  if (SOCIAL_PAGE_NAMESPACES.some((prefix) => isWithin(pathname, prefix))) return "allow";
  return null;
}
