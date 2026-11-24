import type { PrivateRouteContract } from "../private-routes.ts";
import type { RoutePath } from "../route-path.ts";

export const PRESALE_SHARE_IMAGE_PATH = "/presale/:presaleId/share-image" satisfies RoutePath;
export const REFERRAL_IMAGE_PATH = "/referral/:callsign/image" satisfies RoutePath;
export const REFERRAL_CONTEXT_PATH = "/api/social/referral-inviter/:callsign" satisfies RoutePath;

export const SHARE_IMAGE_PRIVATE_ROUTES: readonly PrivateRouteContract[] = Object.freeze([
  ...["GET", "HEAD"].flatMap((method): PrivateRouteContract[] => [
    { id: "presale.share.image", method, path: PRESALE_SHARE_IMAGE_PATH, maxBodyBytes: 0, resourceClass: "render", workBudgetMs: 90_000 },
    { id: "social.referral.image", method, path: REFERRAL_IMAGE_PATH, maxBodyBytes: 0, resourceClass: "render", workBudgetMs: 90_000 },
  ]),
  { id: "social.referral.context", method: "GET", path: REFERRAL_CONTEXT_PATH, maxBodyBytes: 0, workBudgetMs: 30_000, ssrRead: true, ssrOnly: true },
]);
