import { routedCurveBuy } from "../modules/social/trades/curve-buy.ts";
import { socialTradeRoutes, socialSwapRoutes } from "@blast/server/modules/social/trades/runtime.ts";
import type { PrivateHandlers } from "./handler.ts";

export const SOCIAL_TRADES_HANDLERS = {
  "social.trades.curve-buy": (request, { client }) => routedCurveBuy(request, client),
  "social.trades.coins": (request, { client }) => socialTradeRoutes().coins.GET(request, client),
  "social.trades.quote": (request, { client }) => socialTradeRoutes().quote.POST(request, client),
  "social.trades.create": (request, { client }) => socialSwapRoutes().create.POST(request, client),
  "social.trades.settle": (request, { client }) => socialSwapRoutes().settle.POST(request, client),
} satisfies PrivateHandlers;
