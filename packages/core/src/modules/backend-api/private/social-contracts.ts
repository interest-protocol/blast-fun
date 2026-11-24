import type { PrivateRouteContract } from "../private-routes.ts";

/** Account data slice: original business auth remains in each canonical handler. */
const SOCIAL_METHODS: readonly PrivateRouteContract[] = [
  { id: "social.follow.account.put", method: "PUT", path: "/api/social/follows/account/:callsign", maxBodyBytes: 4096 },
  { id: "social.follow.account.delete", method: "DELETE", path: "/api/social/follows/account/:callsign", maxBodyBytes: 4096 },
  { id: "social.follow.presale.put", method: "PUT", path: "/api/social/follows/presale/:presale_id", maxBodyBytes: 4096 },
  { id: "social.follow.presale.delete", method: "DELETE", path: "/api/social/follows/presale/:presale_id", maxBodyBytes: 4096 },
  { id: "social.watchlist.list", method: "GET", path: "/api/social/me/watchlist", maxBodyBytes: 0 },
  { id: "social.watchlist.ids", method: "GET", path: "/api/social/me/watchlist/ids", maxBodyBytes: 0 },
  { id: "social.watchlist.keys", method: "GET", path: "/api/social/me/watchlist/keys", maxBodyBytes: 0 },
  { id: "social.watchlist.put", method: "PUT", path: "/api/social/me/watchlist/:presale_id", maxBodyBytes: 4096 },
  { id: "social.watchlist.delete", method: "DELETE", path: "/api/social/me/watchlist/:presale_id", maxBodyBytes: 4096 },
  { id: "social.notifications.page", method: "GET", path: "/api/social/me/notifications", maxBodyBytes: 0 },
  { id: "social.notifications.unread", method: "GET", path: "/api/social/me/notifications/unread", maxBodyBytes: 0 },
  { id: "social.notifications.read", method: "POST", path: "/api/social/me/notifications/:id/read", maxBodyBytes: 64 },
  { id: "social.notifications.read-all", method: "POST", path: "/api/social/me/notifications/read", maxBodyBytes: 64 },
  { id: "social.onboarding.shown", method: "POST", path: "/api/social/onboarding/shown", maxBodyBytes: 4096 },
  { id: "social.onboarding.complete", method: "POST", path: "/api/social/onboarding/complete", maxBodyBytes: 4096 },
  { id: "social.viewer-state", method: "POST", path: "/api/social/viewer-state", maxBodyBytes: 4096 },
];

/** No SSR capability: viewer-state is a browser POST, even though its business SQL only reads. */
export const SOCIAL_PRIVATE_ROUTES: readonly PrivateRouteContract[] = Object.freeze([
  ...SOCIAL_METHODS,
  ...SOCIAL_METHODS.filter((route) => route.method === "GET").map((route) => ({ ...route, method: "HEAD" })),
]);
