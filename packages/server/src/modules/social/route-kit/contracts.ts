import type { SocialRateBucket } from "@blast/core/lib/web-security/rate-limits.ts";
import type { SocialAccount } from "@blast/core/modules/social/contracts/me.ts";

/**
 * - `none`: the Authorization header is not read;
 * - `optional`: a valid Privy token or wallet session gives the caller, anything else is anonymous;
 * - `account`: a valid Privy token or wallet session is required (`unauthorized` otherwise).
 */
export type SocialAuthMode = "none" | "optional" | "account";

/**
 * - `none`: the Blast Account is not loaded;
 * - `resolve`: the caller's account, or null (`me`, `accounts`, `callsigns`, `onboarding/*`);
 * - `required`: a signed-in caller without an account is `409 account_required`.
 */
export type SocialAccountMode = "none" | "resolve" | "required";

export type SocialRouteSpec = Readonly<{
  /** `METHOD /path`, for metrics. */
  name: string;
  auth: SocialAuthMode;
  /** Loads the caller's Blast Account before the handler (on the primary). Default `none`. */
  account?: SocialAccountMode;
  /** The bucket every request counts in, after auth and before the account and the handler. */
  bucket?: SocialRateBucket;
  /**
   * `private`: every answer, success or error, is `Cache-Control: private,
   * no-store` (an account's own data).
   * `public`: a success is `SOCIAL_PUBLIC_CACHE_CONTROL` (the CDN may share
   * it); errors stay `no-store`. `public-fresh`: the same, as
   * `SOCIAL_PUBLIC_FRESH_CACHE_CONTROL` (shared 10 s, never served stale),
   * for an answer its owner can withdraw. `public-settled`: the same, as
   * `SOCIAL_PUBLIC_SETTLED_CACHE_CONTROL` (shared 5 minutes), for an answer
   * about a fact that never changes. Only a route that never reads the
   * caller (`auth: "none"`) may be public, so a shared answer cannot depend
   * on who asked. Default `no-store`.
   */
  cache?: "no-store" | "private" | "public" | "public-fresh" | "public-settled";
}>;

/** The caller's Blast Account. Resolving may create a member's row. */
export interface SocialAccountLoader {
  /** By verified Privy DID. */
  resolve(did: string): Promise<SocialAccount | null>;
  /**
   * By a wallet session's Sui address (OA-16): the account that holds the
   * address (a wallet-only account's own, or a wallet linked to an account),
   * or null for a wallet-only visitor who has none yet.
   */
  resolveWallet(address: string): Promise<SocialAccount | null>;
}
