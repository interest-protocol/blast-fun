import {
  socialAtomsSchema,
  socialCoinTypeSchema,
  socialDigestSchema,
  socialPositiveAtomsSchema,
} from "./primitives.ts";
import { z } from "zod";
import {
  financialAddressSchema,
  financialUuidSchema,
  financialAtomsSchema,
  financialPositiveAtomsSchema,
  financialDigestSchema,
  financialBase64Schema,
  financialCoinTypeSchema,
  financialDecimalSchema,
  financialIconUrlSchema,
  financialUsdSchema,
  financialIntegerSchema,
  financialTextSchema,
  type FinancialReadonly,
} from "./financial-wire.ts";
/**
 * The coins sheet (social feed UI-14; canonical UI §14 and the live design's
 * "coins: deposit, withdraw and trade any coin in the Blast wallet").
 *
 * The **Blast wallet** is the one address an account deposits to and
 * withdraws from: a Privy account's embedded Sui wallet, or the Slush address
 * of a wallet session (OA-16). Blast's gas pool pays the network fees of both
 * (owner ruling 2026-11-20 reversed OA-17).
 */

/** `GET /api/social/me/wallet`: the Blast wallet and its coins. */
export const SOCIAL_WALLET_ROUTE = "GET /api/social/me/wallet";
export const SOCIAL_WALLET_PATH = "/api/social/me/wallet";

/** Who signs for the Blast wallet: Privy's embedded key, or the session's own wallet (Slush). */
export const SOCIAL_WALLET_SIGNERS = ["privy", "wallet"] as const;
export type SocialWalletSigner = (typeof SOCIAL_WALLET_SIGNERS)[number];

/** How a withdrawal's network fee is paid: by Blast's gas pool, or from the wallet's own SUI. */
export const SOCIAL_TRANSFER_FEES = ["sponsored", "wallet"] as const;
export type SocialTransferFee = (typeof SOCIAL_TRANSFER_FEES)[number];

/** The presale a held sale coin came from, as the coin's sheet shows it. */
export const socialWalletCoinPresaleSchema = z.strictObject({
  presale_id: financialAddressSchema,
  venue: financialTextSchema({ maxLength: 32 }),
  trading: z.boolean(),
  multiple: z
    .string()
    .regex(/^(0|[1-9][0-9]*)\.[0-9]{4}$/)
    .nullable(),
});

export type SocialWalletCoinPresale = FinancialReadonly<
  z.infer<typeof socialWalletCoinPresaleSchema>
>;

/**
 * One coin of the Blast wallet. SUI, USDC and USDsui are always listed (zero when
 * none); every other coin is listed while the wallet holds some, even when
 * its metadata or USD price is unavailable.
 */
export const socialWalletCoinSchema = z.strictObject({
  coin_type: financialCoinTypeSchema,
  symbol: financialTextSchema({ minLength: 1, maxLength: 32 }),
  name: financialTextSchema({ minLength: 1, maxLength: 64 }),
  decimals: financialIntegerSchema
    .min(0)
    .max(255)
    .meta({ type: "integer" })
    .nullable(),
  atoms: financialAtomsSchema,
  usd_price: financialDecimalSchema.nullable(),
  value_usd: financialUsdSchema.nullable(),
  icon_url: financialIconUrlSchema.nullable(),
  presale: z.xor([z.null(), socialWalletCoinPresaleSchema]),
});

export type SocialWalletCoin = FinancialReadonly<
  z.infer<typeof socialWalletCoinSchema>
>;

export const socialWalletSchema = z
  .strictObject({
    address: financialAddressSchema.nullable(),
    signer: z.enum(SOCIAL_WALLET_SIGNERS),
    fee: z.enum(SOCIAL_TRANSFER_FEES),
    coins: z.xor([z.null(), z.array(socialWalletCoinSchema)]),
    as_of_ms: financialIntegerSchema.min(0).meta({ type: "integer" }),
    listing: z
      .strictObject({
        page: financialIntegerSchema.min(1).meta({ type: "integer" }),
        total: financialIntegerSchema.min(0).meta({ type: "integer" }),
        page_size: z.literal(20),
        value_usd: financialUsdSchema.nullable(),
        // The three preferred coins, the open coin and up to five favourites.
        extra_coins: z.array(socialWalletCoinSchema).max(9),
      })
      .optional(),
  })
  .meta({
    title: "The Blast wallet and its coins",
    description:
      "GET /api/social/me/wallet: the account's Blast wallet, who signs for it, how its network fees are paid, and held coins. With page parameters, returns up to 20 filtered holdings and separate common, selected and favourite coin balances.",
  });

export type SocialWallet = FinancialReadonly<
  z.infer<typeof socialWalletSchema>
>;

/** A successful `GET /api/social/me/wallet?balance_coin=<canonical coin type>`. */
export const socialWalletBalanceSchema = z.strictObject({
  address: financialAddressSchema,
  coin_type: financialCoinTypeSchema.pipe(socialCoinTypeSchema),
  atoms: socialAtomsSchema,
  as_of_ms: financialIntegerSchema.min(0).meta({ type: "integer" }),
});

export type SocialWalletBalance = FinancialReadonly<
  z.infer<typeof socialWalletBalanceSchema>
>;

/**
 * `PUT /api/social/me/transfers/{request_id}`: records one withdrawal from the
 * Blast wallet and settles it. The client picks `request_id` (a UUID v4)
 * before signing and sends the same body again with `digest` once the
 * transaction executed. The same body is idempotent; a different one for the
 * same id is `409 transfer_conflict` with the recorded transfer.
 *
 * - 201: recorded now (`pending`, or `submitted` when the first call carried a digest);
 * - 200: already recorded, or settled now (`confirmed`, `failed`);
 * - 202: a digest is recorded and the fullnode does not show it yet: send it again shortly.
 */
export const SOCIAL_TRANSFER_ROUTE =
  "PUT /api/social/me/transfers/{request_id}";

export function socialTransferPath(requestId: string): string {
  return `/api/social/me/transfers/${encodeURIComponent(requestId)}`;
}

export const socialTransferRequestSchema = z
  .strictObject({
    coin_type: financialCoinTypeSchema,
    amount: financialPositiveAtomsSchema,
    recipient: financialAddressSchema,
    digest: financialDigestSchema.optional(),
    transaction_bytes: financialBase64Schema
      .min(1)
      .max(180000)
      .describe(
        "Canonical base64 full Sui TransactionData bytes. Required before execution; digest and sender must match the caller’s server-proven Blast wallet.",
      )
      .optional(),
  })
  .meta({
    title: "Record or settle a withdrawal",
    description:
      "PUT /api/social/me/transfers/{request_id}: the withdrawal, then the same body with its executed transaction's digest.",
  });

export type SocialTransferRequest = FinancialReadonly<
  z.infer<typeof socialTransferRequestSchema>
>;

export const SOCIAL_TRANSFER_STATUSES = [
  "pending",
  "submitted",
  "confirmed",
  "failed",
] as const;
export type SocialTransferStatus = (typeof SOCIAL_TRANSFER_STATUSES)[number];

/** Why a settled withdrawal failed: the transaction aborted, or it is not this withdrawal. */
export const SOCIAL_TRANSFER_FAILURES = [
  "execution_failed",
  "mismatch",
] as const;
export type SocialTransferFailure = (typeof SOCIAL_TRANSFER_FAILURES)[number];

export const socialTransferSchema = z
  .strictObject({
    request_id: financialUuidSchema,
    coin_type: financialCoinTypeSchema,
    amount: financialPositiveAtomsSchema,
    recipient: financialAddressSchema,
    fee: z.enum(SOCIAL_TRANSFER_FEES),
    status: z.enum(SOCIAL_TRANSFER_STATUSES),
    digest: financialDigestSchema.nullable(),
    failure: z.enum(SOCIAL_TRANSFER_FAILURES).nullable(),
    created_at_ms: financialIntegerSchema.min(0).meta({ type: "integer" }),
    settled_at_ms: financialIntegerSchema
      .min(0)
      .meta({ type: "integer" })
      .nullable(),
  })
  .meta({
    title: "A withdrawal",
    description:
      "PUT /api/social/me/transfers/{request_id}: the recorded withdrawal and where it stands.",
  });

export type SocialTransfer = FinancialReadonly<
  z.infer<typeof socialTransferSchema>
>;

/** Transaction bytes are verified only at the digest-provenance step, after ownership checks. */
export const socialTransferInputSchema = z.strictObject({
  ...socialTransferRequestSchema.shape,
  coin_type: socialCoinTypeSchema,
  amount: socialPositiveAtomsSchema,
  digest: socialDigestSchema.optional(),
  transaction_bytes: z.unknown().optional(),
});
