import { DEVELOP_PRIVATE_ROUTES } from "./private/develop-contracts.ts";
import { ANALYTICS_PRIVATE_ROUTES } from "./private/analytics-contracts.ts";
import { VIEWER_THESES_PRIVATE_ROUTES } from "./private/viewer-theses-contracts.ts";
import { CARD_PRIVATE_ROUTES } from "./private/card-contracts.ts";
import { FRONTEND_SECURITY_PRIVATE_ROUTES } from "./private/frontend-security-contracts.ts";
import { SHARE_IMAGE_PRIVATE_ROUTES } from "./private/share-images-contracts.ts";
import { COMMIT_PRIVATE_ROUTES } from "./private/commit-contracts.ts";
import { SOCIAL_CREATE_PRIVATE_ROUTES } from "./private/social-create-contracts.ts";
import { SOCIAL_LAUNCH_PRIVATE_ROUTES } from "./private/social-launch-contracts.ts";
import { FINANCIAL_PRIVATE_ROUTES } from "./private/financial-contracts.ts";
import { SOCIAL_TRADES_PRIVATE_ROUTES } from "./private/social-trades-contracts.ts";
import { PRESALE_RECEIPT_PRIVATE_ROUTES } from "./private/presale-receipt-contracts.ts";
import { SOCIAL_SALES_PRIVATE_ROUTES } from "./private/social-sales-contracts.ts";
import { SOCIAL_PROFILE_EDIT_PRIVATE_ROUTES } from "./private/social-profile-edit-contracts.ts";
import { LAUNCHPAD_IDENTITY_PRIVATE_ROUTES } from "./private/launchpad-identity-contracts.ts";
import { ASSET_PRIVATE_ROUTES } from "./private/asset-contracts.ts";
import { LAUNCHPAD_TELEMETRY_PRIVATE_ROUTES } from "./private/launchpad-telemetry-contracts.ts";
import { COIN_PAGE_PRIVATE_ROUTES } from "./private/coin-page-contracts.ts";
import { SOCIAL_CLAIMS_PRIVATE_ROUTES } from "./private/social-claims-contracts.ts";
import { SOCIAL_DEPOSITS_PRIVATE_ROUTES } from "./private/social-deposits-contracts.ts";
import { PRESALE_PRIVATE_ROUTES } from "./private/presale-contracts.ts";
import { VESTING_PRIVATE_ROUTES } from "./private/vesting-contracts.ts";
import { SOCIAL_COINS_PRIVATE_ROUTES } from "./private/social-coins-contracts.ts";
import { SOCIAL_INTENTS_PRIVATE_ROUTES } from "./private/social-intents-contracts.ts";
import { SOCIAL_PERSONAL_PRIVATE_ROUTES } from "./private/social-personal-contracts.ts";
import { SOCIAL_HOME_PRIVATE_ROUTES } from "./private/social-home-contracts.ts";
import { SOCIAL_DISCOVERY_PRIVATE_ROUTES } from "./private/social-discovery-contracts.ts";
import { ACCOUNT_PRIVATE_ROUTES } from "./private/account-contracts.ts";
import { NON_SOCIAL_PRIVATE_ROUTES } from "./private/non-social-contracts.ts";
import { SOCIAL_READ_PRIVATE_ROUTES } from "./private/social-read-contracts.ts";
import { SOCIAL_PRIVATE_ROUTES } from "./private/social-contracts.ts";
import { routePattern, type RoutePath } from "./route-path.ts";
export type PrivatePurpose = "browser" | "ssr-read";
export type PrivateRouteContract = Readonly<{
  id: string;
  method: string;
  path: RoutePath;
  maxBodyBytes: number;
  /** Owner resource, independent of the permitted wall-clock duration. Omission is ordinary admission. */
  resourceClass?: "ordinary" | "upload" | "render" | "provider-heavy" | "bulk";
  ssrRead?: boolean;
  /** Internal SSR capability; browser proofs must never authorize it. */
  ssrOnly?: boolean;
  /** A reviewed owner budget; omitted routes retain the ordinary thirty-second envelope. */
  workBudgetMs?: number;
}>;

/** Closed identity slice. Later families require their own reviewed parser/auth contract. */
const IDENTITY_ROUTES: readonly PrivateRouteContract[] = [
  {
    id: "social.me",
    method: "GET",
    path: "/api/social/me",
    maxBodyBytes: 0,
    ssrRead: true,
  },
  {
    id: "social.accounts.create",
    method: "POST",
    path: "/api/social/accounts",
    maxBodyBytes: 4096,
  },
  {
    id: "social.callsign",
    method: "GET",
    path: "/api/social/callsigns/:callsign",
    maxBodyBytes: 0,
  },
  {
    id: "social.settings.read",
    method: "GET",
    path: "/api/social/me/settings",
    maxBodyBytes: 0,
  },
  {
    id: "social.settings.write",
    method: "PUT",
    path: "/api/social/me/settings",
    maxBodyBytes: 4096,
  },
  {
    id: "social.x-handle",
    method: "POST",
    path: "/api/social/me/x-handle",
    maxBodyBytes: 0,
  },
  {
    id: "social.wallet.challenge",
    method: "POST",
    path: "/api/social/me/wallets/challenge",
    maxBodyBytes: 4096,
  },
  {
    id: "social.wallet.link",
    method: "POST",
    path: "/api/social/me/wallets",
    maxBodyBytes: 4096,
  },
  {
    id: "social.sign-in.challenge",
    method: "POST",
    path: "/api/social/sign-in/challenge",
    maxBodyBytes: 4096,
  },
  {
    id: "social.sign-in.session",
    method: "POST",
    path: "/api/social/sign-in/session",
    maxBodyBytes: 12288,
  },
  {
    id: "social.sign-in.logout",
    method: "DELETE",
    path: "/api/social/sign-in/session",
    maxBodyBytes: 0,
  },
];

// Next automatically implements HEAD for GET; preserve the actual HTTP method in the proof.
export const PRIVATE_ROUTES: readonly PrivateRouteContract[] = Object.freeze([
  ...ANALYTICS_PRIVATE_ROUTES,
  ...VIEWER_THESES_PRIVATE_ROUTES,
  ...DEVELOP_PRIVATE_ROUTES,
  ...CARD_PRIVATE_ROUTES,
  ...FRONTEND_SECURITY_PRIVATE_ROUTES,
  ...SHARE_IMAGE_PRIVATE_ROUTES,
  ...COMMIT_PRIVATE_ROUTES,
  ...SOCIAL_CREATE_PRIVATE_ROUTES,
  ...SOCIAL_LAUNCH_PRIVATE_ROUTES,
  ...FINANCIAL_PRIVATE_ROUTES,
  ...SOCIAL_TRADES_PRIVATE_ROUTES,
  ...PRESALE_RECEIPT_PRIVATE_ROUTES,
  ...SOCIAL_SALES_PRIVATE_ROUTES,
  ...SOCIAL_PROFILE_EDIT_PRIVATE_ROUTES,
  ...LAUNCHPAD_IDENTITY_PRIVATE_ROUTES,
  ...ASSET_PRIVATE_ROUTES,
  ...LAUNCHPAD_TELEMETRY_PRIVATE_ROUTES,
  ...COIN_PAGE_PRIVATE_ROUTES,
  ...SOCIAL_PRIVATE_ROUTES,
  ...SOCIAL_READ_PRIVATE_ROUTES,
  ...NON_SOCIAL_PRIVATE_ROUTES,
  ...ACCOUNT_PRIVATE_ROUTES,
  ...PRESALE_PRIVATE_ROUTES,
  ...SOCIAL_DISCOVERY_PRIVATE_ROUTES,
  ...SOCIAL_HOME_PRIVATE_ROUTES,
  ...SOCIAL_PERSONAL_PRIVATE_ROUTES,
  ...VESTING_PRIVATE_ROUTES,
  ...SOCIAL_COINS_PRIVATE_ROUTES,
  ...SOCIAL_INTENTS_PRIVATE_ROUTES,
  ...SOCIAL_DEPOSITS_PRIVATE_ROUTES,
  ...SOCIAL_CLAIMS_PRIVATE_ROUTES,
  ...IDENTITY_ROUTES,
  ...IDENTITY_ROUTES.filter((route) => route.method === "GET").map((route) => ({
    ...route,
    method: "HEAD",
  })),
]);

const PRIVATE_MATCHERS = PRIVATE_ROUTES.map((route) => ({
  route,
  pattern: routePattern(route.path),
}));

export function privateRoute(
  method: string,
  pathname: string,
  purpose: PrivatePurpose,
): PrivateRouteContract | null {
  const route = PRIVATE_MATCHERS.find(
    (entry) => entry.route.method === method && entry.pattern.test(pathname),
  )?.route;
  return route && (purpose === "browser" ? !route.ssrOnly : route.ssrRead)
    ? route
    : null;
}
