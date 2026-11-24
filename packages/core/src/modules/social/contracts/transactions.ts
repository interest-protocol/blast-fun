import { z } from "zod";
import { SUI_OBJECT_ID_PATTERN } from "@blast/core/lib/sui/ids.ts";

/**
 * The per-account transaction log (social feed R3-27; FEATURE-MAP-R3 §15.9
 * "This session" and §21.3's `logTx`). Every money action the product sends
 * for an account is one row of `social_transactions` (migration 0084),
 * written by the path that sends it through one helper
 * (`transactions/log.ts`). It records what **Blast sent**;
 * `chain_read_v1.activity` stays the authority for what the chain did.
 */

/** What was sent. `trade_buy` and `trade_sell` are written only if trading opens (R3-00 Q1, R3-31). */
export const SOCIAL_TRANSACTION_KINDS = [
  "commit",
  "claim_refund",
  "claim_tokens",
  "claim_vesting",
  "vesting_create",
  "vesting_claim",
  "vesting_cancel",
  "vesting_close",
  "collect_fees",
  "claim_residuals",
  "claim_launch_fees",
  "claim_launch_lp_fees",
  "deposit",
  "withdraw",
  "trade_buy",
  "trade_sell",
] as const;
export type SocialTransactionKind = (typeof SOCIAL_TRANSACTION_KINDS)[number];

/** `submitted` moves to `confirmed` or `failed`, once, and nothing else moves. */
export const SOCIAL_TRANSACTION_STATES = ["submitted", "confirmed", "failed"] as const;
export type SocialTransactionState = (typeof SOCIAL_TRANSACTION_STATES)[number];

/**
 * Why a logged transaction failed, as a published code (never a raw chain
 * error string; §22.1 defect 2 is that the gate's claims fail silently):
 *
 * - `execution_failed`: it executed on Sui and aborted; nothing moved.
 * - `mismatch`: the digest is some other transaction (another sender,
 *   recipient, coin or amount than the one recorded).
 * - `dry_run_failed`: refused before signing because it would abort on Sui.
 * - `sponsor_refused`: the withdrawal's sponsor budget or reservation slot definitively refused it.
 * - `rejected`: the wallet declined to sign it; nothing was sent.
 * - `expired`: its sponsorship or quote ran out before it was sent.
 *
 * A trade's own refusals (R3-31), each before anything was sent:
 *
 * - `quote_expired`: its quote was older than its 20 s.
 * - `price_moved`: the pinned pools moved past the quote's slippage (the
 *   dry run, or the chain, refused to fill below the minimum).
 * - `insufficient_balance`: the wallet held less than the trade needed.
 * - `pool_unavailable`: a pinned pool could not be traded (gone, paused, or
 *   the chain could not be read).
 */
export const SOCIAL_TRANSACTION_FAILURES = [
  "execution_failed",
  "mismatch",
  "dry_run_failed",
  "sponsor_refused",
  "rejected",
  "expired",
  "quote_expired",
  "price_moved",
  "insufficient_balance",
  "pool_unavailable",
] as const;
export type SocialTransactionFailure = (typeof SOCIAL_TRANSACTION_FAILURES)[number];

/** The failures only a trade logs (R3-31): every other path refuses before it logs, or never trades. */
export const SOCIAL_TRADE_ONLY_FAILURES = [
  "quote_expired",
  "price_moved",
  "insufficient_balance",
  "pool_unavailable",
] as const satisfies readonly SocialTransactionFailure[];

export const socialTransactionFailureSchema = z.enum(SOCIAL_TRANSACTION_FAILURES);

export function isSocialTransactionFailure(value: unknown): value is SocialTransactionFailure {
  return socialTransactionFailureSchema.safeParse(value).success;
}

/**
 * `GET /api/social/me/transactions?limit=&cursor=`: the caller's logged
 * transactions, newest first, one keyset page at a time on
 * `(created_at_ms, tx_id)`. Signed in with an account, bucket `social_read`,
 * read on the primary and answered `private, no-store`.
 *
 * "This session" (R3-58) is the first page filtered to
 * `created_at_ms >= the session's start` on the client: the list is newest
 * first, so a session's rows are always a prefix of it.
 */
export const SOCIAL_TRANSACTIONS_ROUTE = "GET /api/social/me/transactions";
export const SOCIAL_TRANSACTIONS_PATH = "/api/social/me/transactions";
export const SOCIAL_TRANSACTIONS_PAGE_DEFAULT = 30;
export const SOCIAL_TRANSACTIONS_PAGE_MAX = 50;

export type SocialTransaction = Readonly<z.infer<typeof socialTransactionSchema>>;

export type SocialTransactionsPage = Readonly<z.infer<typeof socialTransactionsPageSchema>>;

// Scoped metadata retains this document's definitions and descriptions during generation.
export const transactionsSchemaMetadata = z.registry<z.core.JSONSchemaMeta>();

export const socialPublishedTransactionsPageSchema = z
  .strictObject({
    transactions: z
      .array(
        z.strictObject({
          tx_id: z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/),
          kind: z.enum([
            "commit",
            "claim_refund",
            "claim_tokens",
            "claim_vesting",
            "collect_fees",
            "claim_residuals",
            "claim_launch_fees",
            "claim_launch_lp_fees",
            "deposit",
            "withdraw",
            "trade_buy",
            "trade_sell",
          ]),
          state: z.enum(SOCIAL_TRANSACTION_STATES),
          digest: z
            .string()
            .regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/)
            .nullable(),
          failure_code: socialTransactionFailureSchema
            .nullable()
            .register(transactionsSchemaMetadata, {
              enum: [...SOCIAL_TRANSACTION_FAILURES, null],
              anyOf: undefined,
            }),
          presale_id: z
            .string()
            .regex(SUI_OBJECT_ID_PATTERN)
            .nullable(),
          coin_type: z
            .string()
            .refine((value) => [...value].length >= 8)
            .refine((value) => [...value].length <= 512)
            .register(transactionsSchemaMetadata, { minLength: 8, maxLength: 512 })
            .nullable(),
          amount: z
            .string()
            .regex(/^(0|[1-9][0-9]{0,19})$/)
            .nullable(),
          quote_type: z
            .string()
            .refine((value) => [...value].length >= 8)
            .refine((value) => [...value].length <= 512)
            .register(transactionsSchemaMetadata, { minLength: 8, maxLength: 512 })
            .nullable(),
          quote_amount: z
            .string()
            .regex(/^(0|[1-9][0-9]{0,19})$/)
            .nullable(),
          usd_value: z
            .string()
            .regex(/^(0|[1-9][0-9]{0,17})\.[0-9]{2}$/)
            .nullable(),
          recipient: z
            .string()
            .regex(SUI_OBJECT_ID_PATTERN)
            .nullable(),
          created_at_ms: z
            .number()
            .min(1)
            .refine(Number.isInteger)
            .register(transactionsSchemaMetadata, { type: "integer" }),
          settled_at_ms: z
            .number()
            .min(1)
            .refine(Number.isInteger)
            .register(transactionsSchemaMetadata, { type: "integer" })
            .nullable(),
          explorer_url: z
            .string()
            .regex(
              /^https:\/\/(suiscan\.xyz\/mainnet\/tx|suivision\.xyz\/txblock)\/[1-9A-HJ-NP-Za-km-z]{32,44}$/,
            )
            .nullable(),
        }),
      )
      .max(50)
      .readonly(),
    next_cursor: z.xor([
      z.null(),
      z
        .string()
        .refine((value) => [...value].length >= 1)
        .refine((value) => [...value].length <= 200)
        .register(transactionsSchemaMetadata, { minLength: 1, maxLength: 200 }),
    ]),
    explorer: z.enum(["suiscan", "suivision"]),
  })
  .register(transactionsSchemaMetadata, {
    title: "Transaction log page",
    description:
      "GET /api/social/me/transactions 200: one keyset page of the caller's logged transactions, newest first on (created_at_ms, tx_id) (private, never cached).",
  });

// The published partner page predates the utility-vesting log kinds. First-party reads include them.
export const socialTransactionSchema = socialPublishedTransactionsPageSchema.shape.transactions
  .unwrap()
  .element.extend({
    kind: z.enum(SOCIAL_TRANSACTION_KINDS),
  });

export const socialTransactionsPageSchema = socialPublishedTransactionsPageSchema.extend({
  transactions: z.array(socialTransactionSchema).max(SOCIAL_TRANSACTIONS_PAGE_MAX).readonly(),
});
