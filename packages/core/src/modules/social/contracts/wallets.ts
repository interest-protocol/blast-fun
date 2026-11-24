import { z } from "zod";

import { SOCIAL_WALLET_KINDS } from "./me.ts";
import { socialAddressInputSchema, socialAddressSchema, socialUuidSchema } from "./primitives.ts";
import { walletChallengeMessageSchema, walletChallengeSignatureSchema, walletTimestampSchema } from "./wallet-sign-in.ts";

/**
 * Linking an external Sui wallet to the caller's Blast Account by a signed
 * challenge (T-017; canonical UI §14.3). Both routes need an account, count
 * in the `social_wallet_link` bucket (10 per hour per account) and answer
 * `private, no-store`.
 *
 * 1. `POST /api/social/me/wallets/challenge { address }` issues a
 *    personal-message challenge through Mission Control's wallet-challenge
 *    service (action `link_wallet`, bound to the account, this site's origin
 *    and the address; it expires after 5 minutes). Answer
 *    `SocialWalletChallenge` (201). An address another account already holds,
 *    through any wallet source, is `409 wallet_taken` before anything is
 *    signed.
 * 2. The wallet signs `message` as a Sui personal message.
 * 3. `POST /api/social/me/wallets { challenge_id, address, message,
 *    signature, wallet? }` verifies the signature (Ed25519, secp256k1,
 *    secp256r1, multisig or zkLogin) and links the address: answer
 *    `SocialWalletLinked` (201, or 200 when the address was already the
 *    caller's). A wrong, reused or expired signature, or a message that is not
 *    the challenge's, is `400 invalid_signature` and links nothing. An address
 *    another account holds is `409 wallet_taken`.
 *
 * The challenge service keeps only hashes of the message and its nonce, so
 * the client sends the message (and its address) back with the signature;
 * the service compares both with the stored challenge.
 *
 * `wallet` names the wallet that signed, for display: `slush` lists the
 * address as "Slush"; anything else (the default) as an external wallet.
 * Unlinking is deferred.
 */
export const SOCIAL_WALLET_CHALLENGE_ROUTE = "POST /api/social/me/wallets/challenge";
export const SOCIAL_WALLET_CHALLENGE_PATH = "/api/social/me/wallets/challenge";
export const SOCIAL_WALLET_LINK_ROUTE = "POST /api/social/me/wallets";
export const SOCIAL_WALLET_LINK_PATH = "/api/social/me/wallets";

/** What a linked wallet is listed as: "Slush", or an external wallet. */
export const SOCIAL_LINKED_WALLET_KINDS = ["slush", "external"] as const;
export type SocialLinkedWalletKind = (typeof SOCIAL_LINKED_WALLET_KINDS)[number];

export const socialWalletChallengeRequestSchema = z.strictObject({
  address: socialAddressInputSchema,
}).meta({
  title: "Wallet link challenge request",
  description: "POST /api/social/me/wallets/challenge body. Closed.",
});

export type SocialWalletChallengeRequest = Readonly<z.infer<typeof socialWalletChallengeRequestSchema>>;

export const socialWalletChallengeSchema = z.strictObject({
  challenge_id: socialUuidSchema,
  address: socialAddressSchema,
  message: walletChallengeMessageSchema,
  expires_at_ms: walletTimestampSchema,
}).meta({
  title: "Wallet link challenge",
  description: "POST /api/social/me/wallets/challenge 201: the personal message to sign, bound to the caller's account, this site and the address.",
});

export type SocialWalletChallenge = Readonly<z.infer<typeof socialWalletChallengeSchema>>;

export const socialWalletLinkRequestSchema = z.strictObject({
  challenge_id: socialUuidSchema,
  address: socialAddressInputSchema,
  message: walletChallengeMessageSchema,
  signature: walletChallengeSignatureSchema,
  wallet: z.enum(SOCIAL_LINKED_WALLET_KINDS).optional(),
}).meta({
  title: "Wallet link request",
  description: "POST /api/social/me/wallets body. Closed: the challenge, its message and address as issued, the wallet's signature, and optionally which wallet signed.",
});

export type SocialWalletLinkRequest = Readonly<z.infer<typeof socialWalletLinkRequestSchema>>;

export const socialWalletLinkedSchema = z.strictObject({
  wallet: z.strictObject({
    address: socialAddressSchema,
    kind: z.enum(SOCIAL_WALLET_KINDS),
    linked_at_ms: walletTimestampSchema,
  }),
}).meta({
  title: "Linked wallet",
  description: "POST /api/social/me/wallets 201 (200 when it was already linked): the wallet as GET /api/social/me lists it.",
});

export type SocialWalletLinked = Readonly<z.infer<typeof socialWalletLinkedSchema>>;

export { isSuiAddressInput } from "@blast/core/lib/sui/ids.ts";
