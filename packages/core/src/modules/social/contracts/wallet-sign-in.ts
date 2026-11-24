import { z } from "zod";

import { socialUuidSchema } from "./primitives.ts";

/**
 * Signing in to the social feed with a Sui wallet (Slush; FEATURE-MAP §8.2,
 * OA-11, OA-16). Privy is not involved: the wallet connects through Mysten's
 * dApp Kit, signs one personal message, and the web app issues its own
 * session. The social route kit accepts that session (the cookie) as well as
 * a Privy access token; the session's Sui address finds the caller's account.
 *
 * 1. `POST /api/social/sign-in/challenge { address }` → 200
 *    `{ challenge_id, message, expires_at_ms }`: a one-time message bound to
 *    the address, the site origin, a fresh attempt id and a 256-bit nonce. It
 *    expires after five minutes. Buckets `social_wallet_sign_in` (per IP) and
 *    Mission Control's `wallet` (per IP, address and operation).
 * 2. The wallet signs `message` as a Sui personal message.
 * 3. `POST /api/social/sign-in/session { challenge_id, address, message,
 *    signature }` → 201 `{ expires_at_ms }` with two cookies: the session
 *    (`__Host-blast_wallet`, HttpOnly) and a hint that one exists
 *    (`__Host-blast_wallet_hint`, readable, no secret: the page reads it to
 *    know a wallet viewer may be signed in). The challenge is consumed
 *    exactly once, under a row lock, and only if the message, address,
 *    origin, attempt, nonce and expiry all match and the signature (Ed25519,
 *    secp256k1, secp256r1, or zkLogin through a fullnode) is valid;
 *    otherwise `400 wallet_proof_invalid`. Same buckets.
 * 4. Every social route then takes the session cookie when no Bearer token is
 *    sent, on a same-origin request only (route kit `isSameOriginRequest`).
 *    A session that has ended answers `401 unauthorized` and clears both
 *    cookies.
 * 5. `DELETE /api/social/sign-in/session` → 200 `{ signed_in: false }`:
 *    revokes the session (if any) and clears both cookies.
 *
 * Every route here needs `Origin` equal to the site's (the cookie routes also
 * refuse a `Sec-Fetch-Site` other than `same-origin`); the cookies are
 * `SameSite=Strict`, so no cross-site request carries them. All answers are
 * `Cache-Control: no-store`.
 */

export const SOCIAL_WALLET_SIGN_IN_CHALLENGE_ROUTE = "POST /api/social/sign-in/challenge";
export const SOCIAL_WALLET_SIGN_IN_CHALLENGE_PATH = "/api/social/sign-in/challenge";
export const SOCIAL_WALLET_SESSION_CREATE_ROUTE = "POST /api/social/sign-in/session";
export const SOCIAL_WALLET_SESSION_DELETE_ROUTE = "DELETE /api/social/sign-in/session";
export const SOCIAL_WALLET_SESSION_PATH = "/api/social/sign-in/session";

/** The HttpOnly session cookie: an opaque 256-bit token, stored server-side only as its SHA-256. */
export const SOCIAL_WALLET_SESSION_COOKIE = "__Host-blast_wallet";
/** A readable cookie that only says a wallet session may exist (the page's signed-in hint; no secret). */
export const SOCIAL_WALLET_HINT_COOKIE = "__Host-blast_wallet_hint";

/** A wallet session lasts at most 30 days and ends after 7 idle days. */
export const SOCIAL_WALLET_SESSION_TTL_MS = 30 * 86_400_000;
export const SOCIAL_WALLET_SESSION_IDLE_MS = 7 * 86_400_000;

const walletSignInAddressSchema = z.string().min(1).max(66);
export const walletChallengeMessageSchema = z.string().min(1).max(2_048);
export const walletChallengeSignatureSchema = z.string().min(1).max(8_192);
export const walletTimestampSchema = z.number().nonnegative().refine(Number.isInteger).meta({ type: "integer" });

export const socialWalletSignInChallengeRequestSchema = z.strictObject({
  address: walletSignInAddressSchema,
}).meta({
  title: "Wallet sign-in challenge request",
  description: "POST /api/social/sign-in/challenge body. Closed. address is a Sui address (0x and up to 64 hex digits); it is canonicalized to 66 lowercase characters.",
});

export type SocialWalletSignInChallengeRequest = Readonly<z.infer<typeof socialWalletSignInChallengeRequestSchema>>;

export const socialWalletSignInChallengeSchema = z.strictObject({
  challenge_id: socialUuidSchema,
  message: walletChallengeMessageSchema,
  expires_at_ms: walletTimestampSchema,
}).meta({
  title: "Wallet sign-in challenge",
  description: "POST /api/social/sign-in/challenge 200: the one-time message the wallet signs as a Sui personal message, bound to the address, the site origin, an attempt and a nonce; it expires five minutes after issue.",
});

export type SocialWalletChallengeResponse = Readonly<z.infer<typeof socialWalletSignInChallengeSchema>>;

export const socialWalletSessionRequestSchema = z.strictObject({
  challenge_id: socialUuidSchema,
  address: walletSignInAddressSchema,
  message: walletChallengeMessageSchema,
  signature: walletChallengeSignatureSchema,
}).meta({
  title: "Wallet sign-in proof",
  description: "POST /api/social/sign-in/session body. Closed, at most 12 KiB. The challenge's id and exact message, the address it was issued for, and the wallet's serialized signature.",
});

export type SocialWalletSessionRequest = Readonly<z.infer<typeof socialWalletSessionRequestSchema>>;

export const socialWalletSessionSchema = z.strictObject({
  expires_at_ms: walletTimestampSchema,
}).meta({
  title: "Wallet session",
  description: "POST /api/social/sign-in/session 201: when the new wallet session ends at the latest. The session itself travels only in the HttpOnly __Host-blast_wallet cookie.",
});

export type SocialWalletSessionResponse = Readonly<z.infer<typeof socialWalletSessionSchema>>;

export const socialWalletSignOutSchema = z.strictObject({
  signed_in: z.literal(false),
}).meta({
  title: "Wallet sign-out",
  description: "DELETE /api/social/sign-in/session 200: the wallet session is revoked (if there was one) and its cookies are cleared.",
});

export type SocialWalletSignOutResponse = Readonly<z.infer<typeof socialWalletSignOutSchema>>;
