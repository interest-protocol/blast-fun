import {
  SOCIAL_ONBOARDING_COMPLETE_ROUTE,
  SOCIAL_ONBOARDING_SHOWN_ROUTE,
  socialOnboardingCompleteRequestSchema,
  type SocialOnboardingShownResponse,
} from "@blast/core/modules/social/contracts/onboarding.ts";
import { SocialRouteError } from "@blast/core/modules/social/route-kit/errors.ts";
import { readSocialBody, readSocialJsonWithSchema, type SocialRouteKit } from "@blast/server/modules/social/route-kit/route.ts";
import { completeOnboarding, markOnboardingShown, type OnboardingRepositoryOptions } from "@blast/server/modules/social/onboarding/repository.ts";

/**
 * `POST /api/social/onboarding/shown` and `POST /api/social/onboarding/complete`
 * (contracts in `contracts/onboarding.ts`). Order: kit (origin, auth,
 * `social_account_update`, account required: a member's row is created on
 * first resolution, a caller with no account is `409 account_required`),
 * body, then one primary transaction that locks the account row.
 */
export function createSocialOnboardingRoutes(
  dependencies: Readonly<{ kit: SocialRouteKit }> & OnboardingRepositoryOptions,
) {
  const { kit, createId } = dependencies;
  return Object.freeze({
    shown: Object.freeze({
      POST: kit.route(
        { name: SOCIAL_ONBOARDING_SHOWN_ROUTE, auth: "account", account: "required", bucket: "social_account_update", cache: "private" },
        async (context) => {
          // No body is defined; anything sent is refused rather than ignored.
          if ((await readSocialBody(context.request)).byteLength > 0) throw new SocialRouteError("invalid_request");
          const accountId = context.account!.account_id;
          const follows = await context.transaction((social) => markOnboardingShown(social, accountId, { createId }), {
            label: "social.onboarding_shown",
          });
          const body: SocialOnboardingShownResponse = { follows };
          return context.json(body);
        },
      ),
    }),
    complete: Object.freeze({
      POST: kit.route(
        { name: SOCIAL_ONBOARDING_COMPLETE_ROUTE, auth: "account", account: "required", bucket: "social_account_update", cache: "private" },
        async (context) => {
          const { private: makePrivate } = await readSocialJsonWithSchema(context.request, socialOnboardingCompleteRequestSchema);
          const accountId = context.account!.account_id;
          const state = await context.transaction(
            (social) => completeOnboarding(social, accountId, makePrivate, { createId }),
            { label: "social.onboarding_complete" },
          );
          return context.json(state);
        },
      ),
    }),
  });
}
