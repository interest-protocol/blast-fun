import type { PrivateRouteContract } from "../private-routes.ts";
import type { RoutePath } from "../route-path.ts";

export const SOCIAL_TRADE_SETTLE_PATH = "/api/social/trades/:trade_id/settle" satisfies RoutePath;

export const SOCIAL_TRADES_PRIVATE_ROUTES: readonly PrivateRouteContract[] = Object.freeze([
  { id: "social.trades.curve-buy", method: "POST", path: "/api/social/trades/curve-buy", maxBodyBytes: 4096, resourceClass: "provider-heavy", workBudgetMs: 120_000 },
  { id: "social.trades.coins", method: "GET", path: "/api/social/trades/coins", maxBodyBytes: 0 },
  { id: "social.trades.coins", method: "HEAD", path: "/api/social/trades/coins", maxBodyBytes: 0 },
  { id: "social.trades.quote", method: "POST", path: "/api/social/trades/quote", maxBodyBytes: 4096, resourceClass: "provider-heavy", workBudgetMs: 120_000 },
  { id: "social.trades.create", method: "POST", path: "/api/social/trades", maxBodyBytes: 4096, resourceClass: "provider-heavy", workBudgetMs: 180_000 },
  { id: "social.trades.settle", method: "POST", path: SOCIAL_TRADE_SETTLE_PATH, maxBodyBytes: 0 },
]);
