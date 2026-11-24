import { socialSaleRoutes } from "../modules/social/sales/runtime.ts";
import type { PrivateHandlers } from "./handler.ts";

export const SOCIAL_SALES_HANDLERS = {
  "social.sales.metadata.read": (request, { client }) => socialSaleRoutes().metadata.GET(request, client),
  "social.sales.metadata.write": (request, { client }) => socialSaleRoutes().metadata.PUT(request, client),
  "social.sales.cover.upload": (request, { client }) => socialSaleRoutes().cover.POST(request, client),
  "social.sales.cover.delete": (request, { client }) => socialSaleRoutes().cover.DELETE(request, client),
} satisfies PrivateHandlers;
