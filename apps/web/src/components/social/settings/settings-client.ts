import { diagnosticMessage } from "#web/lib/errors.ts";
import {
  SOCIAL_SETTINGS_PATH,
  socialSettingsResponseSchema,
  type SocialSettingsResponse,
} from "@blast/core/web/contracts/settings.ts";
import {
  SOCIAL_WALLET_CHALLENGE_PATH,
  SOCIAL_WALLET_LINK_PATH,
  type SocialLinkedWalletKind,
  socialWalletChallengeSchema,
  socialWalletLinkedSchema,
  type SocialWalletChallenge,
  type SocialWalletLinked,
} from "@blast/core/web/contracts/wallets.ts";

import type { SettingsPatch } from "./settings-model";
import { callSocialApi, type ApiResult, type SocialApiOptions } from "../social-api.ts";

/**
 * The settings page's reads and writes: `GET`/`PUT /api/social/me/settings`
 * and the wallet-link pair (`POST /api/social/me/wallets/challenge`, `POST
 * /api/social/me/wallets`), each with the viewer's Privy access token, never
 * cached and without cookies.
 */
type Options = SocialApiOptions;

export function fetchSettings(options: Options): Promise<ApiResult<SocialSettingsResponse>> {
  return callSocialApi(options, SOCIAL_SETTINGS_PATH, { method: "GET" }, socialSettingsResponseSchema);
}

export function saveSettings(options: Options, patch: SettingsPatch): Promise<ApiResult<SocialSettingsResponse>> {
  return callSocialApi(options, SOCIAL_SETTINGS_PATH, { method: "PUT", body: patch }, socialSettingsResponseSchema);
}

export function requestWalletChallenge(options: Options, address: string): Promise<ApiResult<SocialWalletChallenge>> {
  return callSocialApi(options, SOCIAL_WALLET_CHALLENGE_PATH, { method: "POST", body: { address } }, socialWalletChallengeSchema);
}

export function linkWallet(
  options: Options,
  challenge: SocialWalletChallenge,
  signature: string,
  wallet: SocialLinkedWalletKind,
): Promise<ApiResult<SocialWalletLinked>> {
  return callSocialApi(
    options,
    SOCIAL_WALLET_LINK_PATH,
    {
      method: "POST",
      body: { challenge_id: challenge.challenge_id, address: challenge.address, message: challenge.message, signature, wallet },
    },
    socialWalletLinkedSchema,
  );
}

/** The page's words for a refused or failed save; each says nothing changed and how to recover. */
export function saveFailureMessage(result: Exclude<ApiResult<unknown>, { status: "ok" }>): string {
  if (result.status === "refused") {
    switch (result.code) {
      case "onboarding_required":
        return diagnosticMessage("Finish setting up your account first. Nothing was saved.", result);
      case "unauthorized":
        return diagnosticMessage("Your session ended. Sign in again. Nothing was saved.", result);
      case "rate_limited":
        return diagnosticMessage(result.retryAfterSeconds
          ? `Too many changes. Try again in ${result.retryAfterSeconds} s. Nothing was saved.`
          : "Too many changes. Try again shortly. Nothing was saved.", result);
      default:
        break;
    }
  }
  return diagnosticMessage("Couldn't save that. Nothing was changed. Try again.", result);
}
