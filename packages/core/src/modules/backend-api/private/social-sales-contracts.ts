import type { PrivateRouteContract } from "../private-routes.ts";
import type { RoutePath } from "../route-path.ts";

export const SOCIAL_SALE_METADATA_PATH = "/api/social/sales/:presale_id/metadata" satisfies RoutePath;
export const SOCIAL_SALE_COVER_PATH = "/api/social/sales/:presale_id/cover" satisfies RoutePath;

export const SOCIAL_SALES_PRIVATE_ROUTES: readonly PrivateRouteContract[] = Object.freeze([
  { id: "social.sales.metadata.read", method: "GET", path: SOCIAL_SALE_METADATA_PATH, maxBodyBytes: 0, resourceClass: "provider-heavy", workBudgetMs: 90_000 },
  { id: "social.sales.metadata.read", method: "HEAD", path: SOCIAL_SALE_METADATA_PATH, maxBodyBytes: 0, resourceClass: "provider-heavy", workBudgetMs: 90_000 },
  { id: "social.sales.metadata.write", method: "PUT", path: SOCIAL_SALE_METADATA_PATH, maxBodyBytes: 4096, resourceClass: "provider-heavy", workBudgetMs: 90_000 },
  { id: "social.sales.cover.upload", method: "POST", path: SOCIAL_SALE_COVER_PATH, maxBodyBytes: 4_016_384, resourceClass: "upload", workBudgetMs: 90_000 },
  { id: "social.sales.cover.delete", method: "DELETE", path: SOCIAL_SALE_COVER_PATH, maxBodyBytes: 0, resourceClass: "bulk", workBudgetMs: 90_000 },
]);
