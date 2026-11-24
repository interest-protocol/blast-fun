import { z } from "zod";
import { SUI_OBJECT_ID_PATTERN } from "@blast/core/lib/sui/ids.ts";

/**
 * Holder rewards (OA-45, OA-46): `GET /api/social/me/rewards?limit=&cursor=&presale=`
 * (schema `schemas/rewards-page.schema.json`), the caller's own payouts from
 * each launched coin's trading fees. Owner only: there is no public read.
 *
 * - Signed in with an account (`409 account_required` without one), bucket
 *   `social_read`, read on the primary, `private, no-store`. The wallets are
 *   the account's (`social_wallet_owners`, as `/me/portfolio` reads them); no
 *   parameter names an account or a wallet.
 * - Only sales the web shows (`read-model/chain-presales.ts`
 *   `SHOWN_PRESALES`: a sale whose coin or quote metadata blast-infra has not
 *   seen has no amount to draw); blast-infra's view already leaves out the
 *   excluded test-package sales.
 * - `payouts`: blast-infra's `chain_read_v1.vault_reward_payouts` rows
 *   whose `beneficiary` is one of those wallets, newest first, one keyset
 *   page at a time on the chain position `(checkpoint, tx_slot, event_slot)`
 *   (`limit` 1 to 50, default 20; `cursor` from the previous page). With
 *   `presale`, only that sale's. Each payout is only what the chain says:
 *   its sale, round, amounts, time, digest and who sent the claim
 *   (`relayed_by`); `self_claimed` is true when that sender is one of the
 *   account's own wallets (otherwise the rewards relayer delivered it).
 * - `coins`: on a first page without `presale` (no `cursor`), one entry per
 *   sale that paid the account or still owes it, latest payout first:
 *   the sale's coin (`chain_read_v1.presales`), how many payouts and what they added up to,
 *   the native published round count (`chain_read_v1.vault_rounds`,
 *   null when it has none for the sale), and `waiting`. On any other page it
 *   is null.
 * - `waiting`: unpaid positive daily allocations, grouped as `next` (queued
 *   for automatic delivery) or `unpayable` (delivery failed and the holder
 *   claims it). Native paid/closed facts and deadlines suppress finished
 *   allocations. Null when nothing waits or the reader is unavailable.
 * - Amounts are atoms as decimal strings; `round_number` is the chain's
 *   (a vault's first round is 0).
 */
export const SOCIAL_REWARDS_ROUTE = "GET /api/social/me/rewards";
export const SOCIAL_REWARDS_PATH = "/api/social/me/rewards";
export const SOCIAL_REWARDS_PAGE_DEFAULT = 20;
export const SOCIAL_REWARDS_PAGE_MAX = 50;

/** A pair of amounts: the sale coin (`meme`) and its quote coin, in atoms. */
export type RewardAmounts = Readonly<z.infer<typeof rewardsAmountsSchema>>;

export type SocialRewardPayout = Readonly<
  z.infer<typeof socialRewardsPageSchema>["payouts"][number]
>;

export type SocialRewardCoin = Readonly<
  NonNullable<z.infer<typeof socialRewardsPageSchema>["coins"]>[number]
>;

export type SocialRewardsPage = Readonly<z.infer<typeof socialRewardsPageSchema>>;

/** The path one page is read from. */
export function socialRewardsPath(
  query: Readonly<{
    limit?: number;
    cursor?: string | null;
    presale?: string | null;
    vault?: string | null;
  }> = {},
): string {
  const params = new URLSearchParams();
  if (query.vault) params.set("vault", query.vault);
  if (query.presale) params.set("presale", query.presale);
  if (query.limit !== undefined) params.set("limit", String(query.limit));
  if (query.cursor) params.set("cursor", query.cursor);
  const search = params.toString();
  return search ? `${SOCIAL_REWARDS_PATH}?${search}` : SOCIAL_REWARDS_PATH;
}

// Scoped metadata retains this document's definitions and descriptions during generation.
export const rewardsSchemaMetadata = z.registry<z.core.JSONSchemaMeta>();

export const rewardsAtomsSchema = z
  .string()
  .regex(/^(0|[1-9][0-9]{0,39})$/)
  .register(rewardsSchemaMetadata, { id: "atoms" });

export const rewardsObjectIdSchema = z
  .string()
  .regex(SUI_OBJECT_ID_PATTERN)
  .register(rewardsSchemaMetadata, { id: "object_id" });

export const rewardsAmountsSchema = z
  .strictObject({
    meme: rewardsAtomsSchema,
    quote: rewardsAtomsSchema,
  })
  .register(rewardsSchemaMetadata, { id: "amounts" });

export const socialRewardsPageSchema = z
  .strictObject({
    coins: z.xor([
      z.null(),
      z
        .array(
          z
            .strictObject({
              presale_id: z.union([rewardsObjectIdSchema, z.null()]),
              name: z
                .string()
                .refine((value) => [...value].length <= 200)
                .register(rewardsSchemaMetadata, { maxLength: 200 }),
              symbol: z
                .string()
                .refine((value) => [...value].length <= 64)
                .register(rewardsSchemaMetadata, { maxLength: 64 }),
              icon_url: z
                .string()
                .refine((value) => [...value].length <= 2048)
                .register(rewardsSchemaMetadata, { maxLength: 2048 }),
              sale_decimals: z
                .number()
                .min(0)
                .max(255)
                .refine(Number.isInteger)
                .register(rewardsSchemaMetadata, { type: "integer" }),
              quote_type: z
                .string()
                .refine((value) => [...value].length >= 8)
                .refine((value) => [...value].length <= 512)
                .register(rewardsSchemaMetadata, { minLength: 8, maxLength: 512 }),
              quote_symbol: z
                .string()
                .refine((value) => [...value].length <= 64)
                .register(rewardsSchemaMetadata, { maxLength: 64 }),
              quote_decimals: z
                .number()
                .min(0)
                .max(255)
                .refine(Number.isInteger)
                .register(rewardsSchemaMetadata, { type: "integer" }),
              rounds: z
                .number()
                .min(1)
                .refine(Number.isInteger)
                .register(rewardsSchemaMetadata, { type: "integer" })
                .nullable(),
              payouts: z
                .number()
                .min(0)
                .refine(Number.isInteger)
                .register(rewardsSchemaMetadata, { type: "integer" }),
              received: rewardsAmountsSchema,
              last_payout_ms: z
                .number()
                .min(0)
                .refine(Number.isInteger)
                .register(rewardsSchemaMetadata, { type: "integer" })
                .nullable(),
              waiting: z.xor([
                z.null(),
                z.strictObject({
                  next: z.xor([z.null(), rewardsAmountsSchema]),
                  unpayable: z.xor([z.null(), rewardsAmountsSchema]),
                }),
              ]),
              source_id: rewardsObjectIdSchema.optional(),
              vault_id: rewardsObjectIdSchema.optional(),
            })
            .refine(
              (value) =>
                value.presale_id !== null ||
                (value.vault_id !== undefined && value.source_id !== undefined),
              "Standalone rewards require vault_id and source_id",
            )
            .register(rewardsSchemaMetadata, {
              allOf: [
                {
                  if: { properties: { presale_id: { type: "null" } } },
                  then: {
                    required: ["vault_id", "source_id"],
                    properties: {
                      vault_id: { $ref: "#/$defs/object_id" },
                      source_id: { $ref: "#/$defs/object_id" },
                    },
                  },
                },
              ],
            }),
        )
        .readonly(),
    ]),
    payouts: z
      .array(
        z
          .strictObject({
            presale_id: z.union([rewardsObjectIdSchema, z.null()]),
            round_id: rewardsObjectIdSchema,
            round_number: z.string().regex(/^(0|[1-9][0-9]{0,19})$/),
            meme_amount: rewardsAtomsSchema,
            quote_amount: rewardsAtomsSchema,
            digest: z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/),
            timestamp_ms: z
              .number()
              .min(0)
              .refine(Number.isInteger)
              .register(rewardsSchemaMetadata, { type: "integer" }),
            relayed_by: rewardsObjectIdSchema,
            self_claimed: z.boolean(),
            source_id: rewardsObjectIdSchema.optional(),
            vault_id: rewardsObjectIdSchema.optional(),
          })
          .refine(
            (value) =>
              value.presale_id !== null ||
              (value.vault_id !== undefined && value.source_id !== undefined),
            "Standalone rewards require vault_id and source_id",
          )
          .register(rewardsSchemaMetadata, {
            allOf: [
              {
                if: { properties: { presale_id: { type: "null" } } },
                then: {
                  required: ["vault_id", "source_id"],
                  properties: {
                    vault_id: { $ref: "#/$defs/object_id" },
                    source_id: { $ref: "#/$defs/object_id" },
                  },
                },
              },
            ],
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
        .register(rewardsSchemaMetadata, { minLength: 1, maxLength: 200 }),
    ]),
  })
  .register(rewardsSchemaMetadata, {
    title: "Holder rewards page",
    description:
      "GET /api/social/me/rewards 200: a private keyset page of the caller's holder rewards, with a source summary on the first unfiltered page. Sources are presales or standalone vaults.",
  });

/** A source id identifies its presale or standalone vault; keep UI attribution unambiguous. */
function rewardSourceMatches(value: { presale_id: string | null; source_id?: string; vault_id?: string }): boolean {
  return value.presale_id === null
    ? value.source_id === value.vault_id
    : value.source_id === undefined || value.source_id === value.presale_id;
}

export const socialRewardsResponseSchema = socialRewardsPageSchema.refine(({ coins, payouts }) =>
  (coins === null || coins.every(rewardSourceMatches)) && payouts.every(rewardSourceMatches));
