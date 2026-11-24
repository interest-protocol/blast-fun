import type { PrivateRouteContract } from "../private-routes.ts";

const METHODS: readonly PrivateRouteContract[] = [
  { id: "social.activity", method: "GET", path: "/api/social/activity", maxBodyBytes: 0 },
  { id: "social.happening", method: "GET", path: "/api/social/happening", maxBodyBytes: 0, ssrRead: true },
  { id: "social.search", method: "GET", path: "/api/social/search", maxBodyBytes: 0 },
];

export const SOCIAL_DISCOVERY_PRIVATE_ROUTES: readonly PrivateRouteContract[] = Object.freeze([
  ...METHODS,
  ...METHODS.map((route) => ({ ...route, method: "HEAD" })),
]);
