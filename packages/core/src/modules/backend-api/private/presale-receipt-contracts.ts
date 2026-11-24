import type { PrivateRouteContract } from "../private-routes.ts";
import type { RoutePath } from "../route-path.ts";

export const PRESALE_RECEIPT_IMAGE_PATH = "/api/presale/receipts/:presale_id/:wallet/image" satisfies RoutePath;

/** The public PNG receipt keeps its original owner bucket and parameter errors. */
// Bounded render workflow retains its reviewed four-workflow capacity pending resource assessment.
export const PRESALE_RECEIPT_PRIVATE_ROUTES: readonly PrivateRouteContract[] = Object.freeze([
  { id: "presale.receipt.image", method: "GET", path: PRESALE_RECEIPT_IMAGE_PATH, maxBodyBytes: 0, resourceClass: "bulk", workBudgetMs: 90_000 },
  { id: "presale.receipt.image", method: "HEAD", path: PRESALE_RECEIPT_IMAGE_PATH, maxBodyBytes: 0, resourceClass: "bulk", workBudgetMs: 90_000 },
]);
