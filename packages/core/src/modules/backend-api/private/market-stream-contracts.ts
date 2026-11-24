import { MARKET_STREAM_PATH, MARKET_STREAM_ROUTE_ID } from "../../launchpad-contract/market-stream.ts";
import type { PrivateRouteContract } from "../private-routes.ts";
export const MARKET_STREAM_PRIVATE_ROUTES: readonly PrivateRouteContract[] =
  Object.freeze([
    {
      id: MARKET_STREAM_ROUTE_ID,
      method: "GET",
      path: MARKET_STREAM_PATH,
      maxBodyBytes: 0,
      resourceClass: "ordinary",
      workBudgetMs: 300_000,
    },
    {
      id: MARKET_STREAM_ROUTE_ID,
      method: "HEAD",
      path: MARKET_STREAM_PATH,
      maxBodyBytes: 0,
      resourceClass: "ordinary",
      workBudgetMs: 300_000,
    },
  ]);
