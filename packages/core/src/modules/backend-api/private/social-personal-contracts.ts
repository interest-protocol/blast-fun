import type { PrivateRouteContract } from "../private-routes.ts";

const METHODS: readonly PrivateRouteContract[] = [
  { id: "social.me.transactions", method: "GET", path: "/api/social/me/transactions", maxBodyBytes: 0 },
  { id: "social.me.rewards", method: "GET", path: "/api/social/me/rewards", maxBodyBytes: 0 },
  { id: "social.me.referrals", method: "GET", path: "/api/social/me/referrals", maxBodyBytes: 0 },
  { id: "social.me.referrals.invitees", method: "GET", path: "/api/social/me/referrals/invitees", maxBodyBytes: 0 },
];

export const SOCIAL_PERSONAL_PRIVATE_ROUTES: readonly PrivateRouteContract[] = Object.freeze([
  ...METHODS,
  ...METHODS.map((route) => ({ ...route, method: "HEAD" })),
]);
