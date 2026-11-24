import {
  socialWalletSchema,
  socialWalletBalanceSchema,
  socialTransferSchema,
  SOCIAL_WALLET_PATH,
  socialTransferPath,
  type SocialTransfer,
  type SocialTransferRequest,
  type SocialWallet,
  type SocialWalletBalance,
} from "@blast/core/web/contracts/coins.ts";

import { callSocialApi, type ApiResult, type SocialApiOptions } from "#web/components/social/social-api.ts";

/**
 * The coins sheet's calls, all through the shared session helper
 * (`callSocialApi`: the Privy token, or the wallet session cookie):
 *
 * - `GET /api/social/me/wallet` (the Blast wallet and its coins);
 * - `PUT /api/social/me/transfers/{request_id}` (record, then settle, a withdrawal).
 *
 * The sponsor's `withdraw` intent goes through the shared pipeline
 * (`sponsored-transaction.ts`).
 */

/** Whether `value` is a well-formed wallet answer (everything the sheet renders). */
export function isSocialWallet(value: unknown): value is SocialWallet {
  return socialWalletSchema.safeParse(value).success;
}

export function isSocialTransfer(value: unknown): value is SocialTransfer {
  return socialTransferSchema.safeParse(value).success;
}

/** `fresh` skips the server's few-second balance cache: the read follows the owner's own trade or a wallet hint. */
export function fetchWallet(options: SocialApiOptions, listing?: Readonly<{ page: number; q?: string; hide_small?: boolean; hide_test_markets?: boolean; mode?: string; key?: string; keys?: string }>, fresh = false): Promise<ApiResult<SocialWallet>> {
  const params = new URLSearchParams(listing ? Object.entries(listing).map(([key, value]) => [key, String(value)]) : []);
  if (fresh) params.set("fresh", "1");
  return callSocialApi(options, params.size ? `${SOCIAL_WALLET_PATH}?${params}` : SOCIAL_WALLET_PATH, { method: "GET" }, socialWalletSchema);
}

export function fetchWalletIdentity(options: SocialApiOptions): Promise<ApiResult<SocialWallet>> {
  return callSocialApi(options, `${SOCIAL_WALLET_PATH}?identity=1`, { method: "GET" }, socialWalletSchema);
}

export function fetchWalletBalance(options: SocialApiOptions, coinType: string): Promise<ApiResult<SocialWalletBalance>> {
  const params = new URLSearchParams({ balance_coin: coinType });
  return callSocialApi(options, `${SOCIAL_WALLET_PATH}?${params}`, { method: "GET" }, socialWalletBalanceSchema);
}

export function putTransfer(options: SocialApiOptions, requestId: string, body: SocialTransferRequest): Promise<ApiResult<SocialTransfer>> {
  return callSocialApi(options, socialTransferPath(requestId), { method: "PUT", body }, socialTransferSchema);
}
