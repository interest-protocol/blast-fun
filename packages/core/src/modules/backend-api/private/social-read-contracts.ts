import type { PrivateRouteContract } from "../private-routes.ts";
import type { RoutePath } from "../route-path.ts";

export const SOCIAL_ITEM_PATH = "/api/social/items/:entry_id" satisfies RoutePath;
export const SOCIAL_REACTION_PATH = "/api/social/items/:entry_id/reactions/:reaction" satisfies RoutePath;
export const SOCIAL_WHY_PATH = "/api/social/items/:entry_id/why" satisfies RoutePath;
export const SOCIAL_WHY_RECORD_PATH = "/api/social/whys/:why_id" satisfies RoutePath;
export const SOCIAL_WHY_REPORTS_PATH = "/api/social/whys/:why_id/reports" satisfies RoutePath;
export const SOCIAL_PROFILE_PATH = "/api/social/profiles/:callsign" satisfies RoutePath;
export const SOCIAL_PROFILE_ITEMS_PATH = "/api/social/profiles/:callsign/items" satisfies RoutePath;
export const SOCIAL_PROFILE_CALLS_PATH = "/api/social/profiles/:callsign/calls" satisfies RoutePath;
export const SOCIAL_PROFILE_THESES_PATH = "/api/social/profiles/:callsign/theses" satisfies RoutePath;
export const SOCIAL_PROFILE_CONNECTIONS_PATH = "/api/social/profiles/:callsign/connections" satisfies RoutePath;
export const SOCIAL_PROFILE_MUTUALS_PATH = "/api/social/profiles/:callsign/mutuals" satisfies RoutePath;

/** Exact feed/profile/comment entry points; user authorization remains in the original owners. */
const SOCIAL_READ_METHODS: readonly PrivateRouteContract[] = [
  { id: "social.feed", method: "GET", path: "/api/social/feed", maxBodyBytes: 0, ssrRead: true },
  { id: "social.feed.new", method: "GET", path: "/api/social/feed/new", maxBodyBytes: 0 },
  { id: "social.post", method: "GET", path: SOCIAL_ITEM_PATH, maxBodyBytes: 0, ssrRead: true },
  { id: "social.reaction.put", method: "PUT", path: SOCIAL_REACTION_PATH, maxBodyBytes: 4096 },
  { id: "social.reaction.delete", method: "DELETE", path: SOCIAL_REACTION_PATH, maxBodyBytes: 4096 },
  { id: "social.why.create", method: "POST", path: SOCIAL_WHY_PATH, maxBodyBytes: 4096 },
  { id: "social.why.delete", method: "DELETE", path: SOCIAL_WHY_RECORD_PATH, maxBodyBytes: 4096 },
  { id: "social.why.report", method: "POST", path: SOCIAL_WHY_REPORTS_PATH, maxBodyBytes: 4096 },
  { id: "social.profile", method: "GET", path: SOCIAL_PROFILE_PATH, maxBodyBytes: 0, ssrRead: true },
  { id: "social.profile.items", method: "GET", path: SOCIAL_PROFILE_ITEMS_PATH, maxBodyBytes: 0 },
  { id: "social.profile.calls", method: "GET", path: SOCIAL_PROFILE_CALLS_PATH, maxBodyBytes: 0, ssrRead: true },
  { id: "social.profile.theses", method: "GET", path: SOCIAL_PROFILE_THESES_PATH, maxBodyBytes: 0 },
  { id: "social.profile.connections", method: "GET", path: SOCIAL_PROFILE_CONNECTIONS_PATH, maxBodyBytes: 0 },
  { id: "social.profile.mutuals", method: "GET", path: SOCIAL_PROFILE_MUTUALS_PATH, maxBodyBytes: 0 },
  { id: "social.me.presales", method: "GET", path: "/api/social/me/presales", maxBodyBytes: 0 },
  { id: "social.me.presales.created", method: "GET", path: "/api/social/me/presales/created", maxBodyBytes: 0 },
];

export const SOCIAL_READ_PRIVATE_ROUTES: readonly PrivateRouteContract[] = Object.freeze([
  ...SOCIAL_READ_METHODS,
  ...SOCIAL_READ_METHODS.filter((route) => route.method === "GET").map((route) => ({ ...route, method: "HEAD" })),
]);
