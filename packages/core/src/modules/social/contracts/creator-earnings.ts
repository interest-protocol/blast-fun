import { z } from "zod";
import { SUI_OBJECT_ID_PATTERN } from "@blast/core/lib/sui/ids.ts";

export const CREATOR_ACTION_KINDS = ["collect_fees", "claim_residuals"] as const;
export type CreatorActionKind = (typeof CREATOR_ACTION_KINDS)[number];
export const creatorActionKindSchema = z.enum(CREATOR_ACTION_KINDS);

export function isCreatorActionKind(value: unknown): value is CreatorActionKind {
  return creatorActionKindSchema.safeParse(value).success;
}

export type CreatorEarning = Readonly<z.infer<typeof creatorEarningSchema>>;
export type CreatorVesting = Readonly<z.infer<typeof creatorVestingSchema>>;
export type CreatorEarnings = Readonly<z.infer<typeof creatorEarningsSchema>>;

const creatorAmountSchema = z.string().regex(/^(0|[1-9][0-9]*)(\.[0-9]+)?$/);
const creatorObjectIdSchema = z.string().regex(SUI_OBJECT_ID_PATTERN);
const creatorAmountsSchema = z.object({ meme: creatorAmountSchema, quote: creatorAmountSchema });

export const creatorEarningSchema = z.object({
  presale_id: creatorObjectIdSchema,
  vault_id: creatorObjectIdSchema,
  name: z.string(),
  symbol: z.string(),
  icon_url: z.string(),
  quote_symbol: z.string(),
  fee_share_bps: z.number().int().min(0).max(10_000),
  collection_status: z.enum(["ready", "empty", "ineligible", "unavailable"]),
  collect: creatorAmountsSchema.nullable(),
  residuals: creatorAmountsSchema.nullable(),
  received: creatorAmountsSchema,
});

export const creatorVestingSchema = z.object({
  schedule_id: creatorObjectIdSchema,
  presale_id: creatorObjectIdSchema,
  name: z.string(),
  symbol: z.string(),
  claimed: creatorAmountSchema,
  claimable: creatorAmountSchema,
  total: creatorAmountSchema,
  end_ms: z.number().int(),
});

export const creatorEarningsSchema = z.object({
  earnings: z.array(creatorEarningSchema).readonly(),
  vestings: z.array(creatorVestingSchema).readonly(),
  next_cursor: creatorObjectIdSchema.nullable(),
});
