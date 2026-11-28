import { publicErrorResponse } from "@blast/core/lib/http-errors.ts";
import { withErrorBoundary, type PrivateContext, type PrivateHandlers } from "./handler.ts";
import { ACCOUNT_HANDLERS } from "./account.ts";
import { ANALYTICS_HANDLERS } from "./analytics.ts";
import { cardHandlers } from "./cards.ts";
import { COIN_PAGE_HANDLERS } from "./coin-page.ts";
import { COMMIT_HANDLERS } from "./commit.ts";
import { FINANCIAL_HANDLERS } from "./financial.ts";
import { submitFeedback } from "../modules/feedback/routes.ts";
import { FRONTEND_SECURITY_HANDLERS } from "./frontend-security.ts";
import { IDENTITY_HANDLERS } from "./identity.ts";
import { LAUNCH_ASSET_HANDLERS } from "./launch-assets.ts";
import { LAUNCH_DETAILS_HANDLERS } from "./launch-details.ts";
import { LAUNCHPAD_IDENTITY_HANDLERS } from "./launchpad-identity.ts";
import { LAUNCHPAD_TELEMETRY_HANDLERS } from "./launchpad-telemetry.ts";
import { NON_SOCIAL_HANDLERS } from "./non-social.ts";
import { PRESALE_RECEIPT_HANDLERS } from "./presale-receipt.ts";
import { PRESALE_HANDLERS } from "./presale.ts";
import { SHARE_IMAGE_HANDLERS } from "./share-images.ts";
import { SOCIAL_CLAIMS_HANDLERS } from "./social-claims.ts";
import { SOCIAL_COINS_HANDLERS } from "./social-coins.ts";
import { SOCIAL_CREATE_HANDLERS } from "./social-create.ts";
import { SOCIAL_DEPOSITS_HANDLERS } from "./social-deposits.ts";
import { SOCIAL_DISCOVERY_HANDLERS } from "./social-discovery.ts";
import { SOCIAL_HOME_HANDLERS } from "./social-home.ts";
import { SOCIAL_INTENTS_HANDLERS } from "./social-intents.ts";
import { SOCIAL_LAUNCH_HANDLERS } from "./social-launch.ts";
import { SOCIAL_PERSONAL_HANDLERS } from "./social-personal.ts";
import { SOCIAL_PROFILE_EDIT_HANDLERS } from "./social-profile-edit.ts";
import { SOCIAL_READ_HANDLERS } from "./social-reads.ts";
import { SOCIAL_SALES_HANDLERS } from "./social-sales.ts";
import { SOCIAL_TRADES_HANDLERS } from "./social-trades.ts";
import { SOCIAL_HANDLERS } from "./social.ts";
import { VESTING_HANDLERS } from "./vesting.ts";
import { VIEWER_THESES_HANDLERS } from "./viewer-theses.ts";

/** One handler family per business owner; the two stream ids are served by the hints backend. */
export const PRIVATE_HANDLER_FAMILIES: readonly PrivateHandlers[] = [
  ANALYTICS_HANDLERS,
  ACCOUNT_HANDLERS,
  cardHandlers(),
  COIN_PAGE_HANDLERS,
  COMMIT_HANDLERS,
  FINANCIAL_HANDLERS,
  { "feedback.submit": submitFeedback },
  FRONTEND_SECURITY_HANDLERS,
  IDENTITY_HANDLERS,
  LAUNCH_ASSET_HANDLERS,
  LAUNCH_DETAILS_HANDLERS,
  LAUNCHPAD_IDENTITY_HANDLERS,
  LAUNCHPAD_TELEMETRY_HANDLERS,
  NON_SOCIAL_HANDLERS,
  PRESALE_RECEIPT_HANDLERS,
  PRESALE_HANDLERS,
  SHARE_IMAGE_HANDLERS,
  SOCIAL_CLAIMS_HANDLERS,
  SOCIAL_COINS_HANDLERS,
  SOCIAL_CREATE_HANDLERS,
  SOCIAL_DEPOSITS_HANDLERS,
  SOCIAL_DISCOVERY_HANDLERS,
  SOCIAL_HOME_HANDLERS,
  SOCIAL_INTENTS_HANDLERS,
  SOCIAL_LAUNCH_HANDLERS,
  SOCIAL_PERSONAL_HANDLERS,
  SOCIAL_PROFILE_EDIT_HANDLERS,
  SOCIAL_READ_HANDLERS,
  SOCIAL_SALES_HANDLERS,
  SOCIAL_TRADES_HANDLERS,
  SOCIAL_HANDLERS,
  VESTING_HANDLERS,
  VIEWER_THESES_HANDLERS,
];

export const PRIVATE_HANDLERS: PrivateHandlers = Object.freeze(
  Object.assign({}, ...PRIVATE_HANDLER_FAMILIES),
);

export async function privateApi(request: Request, context: PrivateContext): Promise<Response> {
  const handler = Object.hasOwn(PRIVATE_HANDLERS, context.proof.route.id)
    ? PRIVATE_HANDLERS[context.proof.route.id]
    : undefined;
  if (!handler) {
    return publicErrorResponse("not_found", "Not found.", 404);
  }
  return withErrorBoundary(handler)(request, context);
}
