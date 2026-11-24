import { SOCIAL_PAGE_PATHS } from "@blast/core/lib/social-page-routes.ts";

export type MissionControlRouteDecision =
  | "allow"
  | "redirect-mission"
  | "rewrite-mission"
  /** `/` while the launchpad is off and the presale is on: an internal rewrite to `PRESALE_ENTRY`. */
  | "rewrite-presale"
  /**
   * `/` while the launchpad and the presale are both off: an internal rewrite
   * to `MISSION_CONTROL_ENTRY`, the brand landing.
   */
  | "rewrite-home"
  /** `/` while the social feed and the presale are on: an internal rewrite to `SOCIAL_ENTRY`. */
  | "rewrite-social"
  /** `/@<callsign>` while the social feed is on: an internal rewrite to the profile page (`socialProfileTarget`). */
  | "rewrite-profile"
  /** `/crew/<callsign>` while the social feed is on: a redirect to `/@<callsign>` (`socialProfileTarget`). */
  | "redirect-profile"
  | "not-found";

/** The brand landing, kept at the historical entry URL. */
export const MISSION_CONTROL_ENTRY = "/mission";
/** The presale's entry: `/` shows it while the launchpad is off and the presale is on. */
export const PRESALE_ENTRY = SOCIAL_PAGE_PATHS.presales;
/** The social feed's home page (`src/app/(app)/(social)/feed`): `/` shows it while the social feed is on. */
export const SOCIAL_ENTRY = SOCIAL_PAGE_PATHS.feed;
/**
 * Marks the page request behind a `"rewrite-home"`: `MISSION_CONTROL_ENTRY`
 * then answers as `/` (canonical `/`), as production `main` does. The proxy
 * drops any copy a client sends.
 */
export const HOME_REWRITE_HEADER = "x-blast-home-rewrite";

// Served whether or not Mission Control is on. `/` belongs to the public
// launchpad while it is on (otherwise see `decideMissionControlRoute`).
const ALWAYS_ALLOWED_PATHS = new Set([
  "/",
  MISSION_CONTROL_ENTRY,
  "/privacy",
  "/terms",
  // The API gate's cookie re-issue (docs/security/bot-protection.md).
  "/api/gate",
]);
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
// The public launchpad owns these namespaces behind its own flag
// (`BLAST_LAUNCHPAD_ENABLED`), whether Mission Control is on or off. With the
// flag off they are not found. With it on they never fall through to Mission
// Control: App Router serves their pages, and malformed launch IDs or unknown
// subpaths get its launchpad 404.
const LAUNCHPAD_NAMESPACES = [SOCIAL_PAGE_PATHS.coin, SOCIAL_PAGE_PATHS.launch, SOCIAL_PAGE_PATHS.bonding, "/api/launchpad"];

// Creating a launch (`/launch`'s drafts and context) is social API answered
// only while the launchpad is on for the request, like `/launch` itself.
const LAUNCH_SOCIAL_API_NAMESPACES = ["/api/social/me/launches", "/api/social/launch-context"];

function isLaunchpadRoute(pathname: string): boolean {
  return LAUNCHPAD_NAMESPACES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
}
// The presale owns these namespaces behind its own flag
// (`BLAST_PRESALE_ENABLED`), whether Mission Control is on or off. With the
// flag off they are not found. The API prefixes are the presale backend's.
const PRESALE_NAMESPACES = [PRESALE_ENTRY, SOCIAL_PAGE_PATHS.signIn, SOCIAL_PAGE_PATHS.settings, "/api/presale", "/api/account", "/vesting", "/api/vesting"];

function isPresaleRoute(pathname: string): boolean {
  return PRESALE_NAMESPACES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
}
// The social feed owns these namespaces behind its own flag
// (`BLAST_SOCIAL_ENABLED`) together with the presale's, whose sign-in and
// accounts it uses. With either off, its API and pages are unavailable.
// `/p/<post id>` is a post's permalink (FEATURE-MAP §3.7); `/portfolio` is the
// viewer's Portfolio page (R3-74).
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
// The API namespaces gated by the presale, launchpad and social flags. Their
// not-found answer carries the presale's published `not_found` body; pages
// keep the empty 404.
const GATED_API_NAMESPACES = ["/api/presale", "/api/account", "/api/launchpad", SOCIAL_API_NAMESPACE];

/** A `"not-found"` decision for `pathname` answers the published `not_found` JSON body. */
export function notFoundAnswersJson(pathname: string): boolean {
  return GATED_API_NAMESPACES.some((prefix) => isWithin(pathname, prefix));
}

/**
 * The launch flag reader resolves the presale, launchpad and social flags.
 * The social feed needs the presale. The legacy API has its own flag.
 */
export function decideMissionControlRoute(
  pathname: string,
  experienceEnabled: boolean,
  presaleEnabled: boolean,
  launchpadEnabled: boolean,
  socialEnabled = false,
): MissionControlRouteDecision {
  if (RETIRED_MISSION_CONTROL_API_PATHS.has(pathname) || RETIRED_NAMESPACES.some((prefix) => isWithin(pathname, prefix))) {
    return "not-found";
  }
  if (isPresaleRoute(pathname)) return presaleEnabled === true ? "allow" : "not-found";
  const social = socialEnabled === true && presaleEnabled === true;
  if (LAUNCH_SOCIAL_API_NAMESPACES.some((prefix) => isWithin(pathname, prefix)) && launchpadEnabled !== true) return "not-found";
  if (isWithin(pathname, SOCIAL_API_NAMESPACE)) return social ? "allow" : "not-found";
  const socialDecision = social ? decideSocialPage(pathname) : null;
  if (socialDecision) return socialDecision;
  const launchpadDecision = decideLaunchpadRoute(pathname, launchpadEnabled, presaleEnabled);
  if (launchpadDecision) return launchpadDecision;
  if (
    ALWAYS_ALLOWED_PATHS.has(pathname) ||
    isLaunchpadRoute(pathname) ||
    pathname.startsWith(MAINTENANCE_API_PREFIX)
  ) {
    return "allow";
  }
  // Published cards remain available regardless of the legacy API flag.
  if (CARD_PAGE.test(pathname) || CARD_IMAGE.test(pathname) || PNL_CARD.test(pathname) || REFERRAL_IMAGE.test(pathname)) return "allow";
  return decideLegacyRoute(pathname, experienceEnabled);
}

function decideLegacyRoute(pathname: string, experienceEnabled: boolean): MissionControlRouteDecision {
  if (pathname.startsWith("/api/")) return experienceEnabled ? "allow" : "not-found";
  if (experienceEnabled && pathname === "/closed") return "redirect-mission";
  return "rewrite-mission";
}

function decideSocialPage(pathname: string): MissionControlRouteDecision | null {
  // The feed is home, whether or not the launchpad is on.
  if (pathname === "/") return "rewrite-social";
  // Profiles live at `/@<callsign>`; the page's own path redirects there.
  if (PROFILE_ALIAS.test(pathname)) return "rewrite-profile";
  if (PROFILE_PAGE.test(pathname)) return "redirect-profile";
  if (SOCIAL_PAGE_NAMESPACES.some((prefix) => isWithin(pathname, prefix))) return "allow";
  return null;
}

function decideLaunchpadRoute(pathname: string, launchpadEnabled: boolean, presaleEnabled: boolean): MissionControlRouteDecision | null {
  if (launchpadEnabled !== true) {
    // The launchpad is off: none of its pages or APIs answers, and `/` shows
    // the presale, or the brand landing when both flags are off.
    if (isLaunchpadRoute(pathname)) return "not-found";
    if (pathname === "/") return presaleEnabled === true ? "rewrite-presale" : "rewrite-home";
  }
  return null;
}
