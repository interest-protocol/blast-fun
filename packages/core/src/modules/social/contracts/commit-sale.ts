import { z } from "zod";

import { coinTypeSchema } from "../../presale/contracts/primitives.ts";
import { isFinancialCoinType } from "./financial-wire.ts";
import { socialPresaleDetailRowSchema, socialPresaleTermsSchema, socialPresaleVestingSchema, socialQuotePriceSchema } from "./presale-schemas.ts";

// The dialog also receives a projection from its host; unrelated detail sections are not required.
const commitSaleRowSchema = socialPresaleDetailRowSchema.pick({
  presale_id: true, name: true, symbol: true, icon_url: true, phase: true, venue: true,
  start_ms: true, end_ms: true, target_usd: true, raised_usd: true, fill_bps: true,
  participants: true, interested: true, multiple: true, quote_symbol: true, quote_type: true,
  quote_decimals: true, target_atoms: true, raised_atoms: true, sale_token: true,
  sale_decimals: true, allowlisted: true, min_commitment_usd: true, wallet_cap_usd: true,
  min_commitment_atoms: true, wallet_cap_atoms: true,
}).extend({
  start_ms: socialPresaleDetailRowSchema.shape.start_ms.refine(Number.isSafeInteger),
  end_ms: socialPresaleDetailRowSchema.shape.end_ms.refine(Number.isSafeInteger),
  quote_symbol: socialPresaleDetailRowSchema.shape.quote_symbol.refine((symbol) => symbol.trim().length > 0),
  quote_type: coinTypeSchema.refine(isFinancialCoinType),
  quote_decimals: socialPresaleDetailRowSchema.shape.quote_decimals.refine((decimals) => decimals <= 255),
}).loose();

const commitTermsSchema = socialPresaleTermsSchema.pick({
  eligible_uncapped_from_ms: true, public_buy: true, presale_price_usd: true, presale_price_quote: true,
}).extend({ supply: socialPresaleTermsSchema.shape.supply.pick({ total: true }).loose() }).loose();

export const socialCommitSaleReadSchema = z.looseObject({
  presale: commitSaleRowSchema,
  quote_price: socialQuotePriceSchema.nullish(),
  terms: commitTermsSchema.nullable(),
  vesting: socialPresaleVestingSchema.loose().nullable(),
});
