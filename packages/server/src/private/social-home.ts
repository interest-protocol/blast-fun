import { socialHomeRoutes } from "../modules/social/home/runtime.ts";
import { socialPortfolioRoute } from "../modules/social/portfolio/runtime.ts";
import { socialPublicPortfolioRoute } from "../modules/social/portfolio/public-runtime.ts";
import { socialPnlRoutes } from "../modules/social/portfolio/pnl-runtime.ts";
import type { PrivateHandlers } from "./handler.ts";

export const SOCIAL_HOME_HANDLERS = {
  "social.home.trader-profiles": (request, { client }) => socialHomeRoutes().TRADER_PROFILES(request, client),
  "social.home": (request, { client }) => socialHomeRoutes().DISCOVER(request, client),
  "social.home.coins": (request, { client }) => socialHomeRoutes().COINS(request, client),
  "social.home.traders": (request, { client }) => socialHomeRoutes().TRADERS(request, client),
  "social.home.activity": (request, { client }) => socialHomeRoutes().ACTIVITY(request, client),
  "social.home.discussion": (request, { client }) => socialHomeRoutes().DISCUSSION(request, client),
  "social.home.following": (request, { client }) => socialHomeRoutes().FOLLOWING(request, client),
  "social.home.market": (request, { client }) => socialHomeRoutes().MARKET(request, client),
  "social.home.holders": (request, { client }) => socialHomeRoutes().HOLDERS(request, client),
  "social.home.trades": (request, { client }) => socialHomeRoutes().TRADES(request, client),
  "social.home.my_trades": (request, { client }) => socialHomeRoutes().MY_TRADES(request, client),
  "social.portfolio": (request, { client }) => socialPortfolioRoute().GET(request, client),
  "social.portfolio.coins": (request, { client }) => socialPortfolioRoute().COINS(request, client),
  "social.portfolio.history": (request, { client }) => socialPortfolioRoute().HISTORY(request, client),
  "social.pnl": (request, { client }) => socialPnlRoutes().GET(request, client),
  "social.portfolio.public": (request, { client }) => socialPublicPortfolioRoute().GET(request, client),
  "social.portfolio.public.history": (request, { client }) => socialPublicPortfolioRoute().HISTORY(request, client),
  "social.pnl.public": (request, { client }) => socialPnlRoutes().PUBLIC(request, client),
} satisfies PrivateHandlers;
