import type { PrivateRouteContract } from "../private-routes.ts";
import type { RoutePath } from "../route-path.ts";

export const SOCIAL_PROFILE_PORTFOLIO_PATH = "/api/social/profiles/:callsign/portfolio" satisfies RoutePath;
export const SOCIAL_PROFILE_PORTFOLIO_HISTORY_PATH = "/api/social/profiles/:callsign/portfolio/history" satisfies RoutePath;
export const SOCIAL_PROFILE_PNL_PATH = "/api/social/profiles/:callsign/pnl" satisfies RoutePath;

const METHODS: readonly PrivateRouteContract[] = [
  { id: "social.home.trader-profiles", method: "GET", path: "/api/social/home/trader-profiles", maxBodyBytes: 0 },
  { id: "social.home", method: "GET", path: "/api/social/home", maxBodyBytes: 0, ssrRead: true },
  { id: "social.home.coins", method: "GET", path: "/api/social/home/coins", maxBodyBytes: 0, ssrRead: true },
  { id: "social.home.traders", method: "GET", path: "/api/social/home/traders", maxBodyBytes: 0, ssrRead: true },
  { id: "social.home.activity", method: "GET", path: "/api/social/home/activity", maxBodyBytes: 0 },
  { id: "social.home.discussion", method: "GET", path: "/api/social/home/discussion", maxBodyBytes: 0 },
  { id: "social.home.following", method: "POST", path: "/api/social/me/home/following", maxBodyBytes: 4096 },
  { id: "social.home.market", method: "GET", path: "/api/social/home/market", maxBodyBytes: 0 },
  { id: "social.home.holders", method: "GET", path: "/api/social/home/holders", maxBodyBytes: 0 },
  { id: "social.home.trades", method: "GET", path: "/api/social/home/trades", maxBodyBytes: 0 },
  { id: "social.home.my_trades", method: "GET", path: "/api/social/me/home/trades", maxBodyBytes: 0 },
  { id: "social.portfolio", method: "GET", path: "/api/social/me/portfolio", maxBodyBytes: 0 },
  { id: "social.portfolio.coins", method: "GET", path: "/api/social/me/portfolio/coins", maxBodyBytes: 0 },
  { id: "social.portfolio.history", method: "GET", path: "/api/social/me/portfolio/history", maxBodyBytes: 0 },
  { id: "social.pnl", method: "GET", path: "/api/social/me/pnl", maxBodyBytes: 0 },
  { id: "social.portfolio.public", method: "GET", path: SOCIAL_PROFILE_PORTFOLIO_PATH, maxBodyBytes: 0 },
  { id: "social.portfolio.public.history", method: "GET", path: SOCIAL_PROFILE_PORTFOLIO_HISTORY_PATH, maxBodyBytes: 0 },
  { id: "social.pnl.public", method: "GET", path: SOCIAL_PROFILE_PNL_PATH, maxBodyBytes: 0 },
];

export const SOCIAL_HOME_PRIVATE_ROUTES: readonly PrivateRouteContract[] = Object.freeze([
  ...METHODS,
  ...METHODS.filter((route) => route.method === "GET").map((route) => ({ ...route, method: "HEAD" })),
]);
