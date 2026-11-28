import { z } from "zod";
import {
  socialCoinTypeSchema,
  socialPositiveAtomsSchema,
} from "../social/contracts/primitives.ts";
import { SUI_OBJECT_ID_PATTERN } from "@blast/core/lib/sui/ids.ts";

export const CURVE_PAYMENT_PATH = "/api/social/trades/curve-buy";
export const curvePaymentRequestSchema = z
  .object({
    launch_id: z.string().regex(SUI_OBJECT_ID_PATTERN),
    quote_id: z.string().min(1).max(3000),
    min_meme_out: socialPositiveAtomsSchema,
    wallet_pays_gas: z.literal(true).optional(),
  })
  .strict();
export const curvePaymentBuildSchema = z.object({
  launch_id: z.string(),
  sender: z.string(),
  quote_type: socialCoinTypeSchema,
  quote_amount: socialPositiveAtomsSchema,
  payment_type: socialCoinTypeSchema,
  payment_amount: socialPositiveAtomsSchema,
  min_meme_out: socialPositiveAtomsSchema,
  expires_at_ms: z.number().int().positive(),
  transaction_kind_bytes: z.string().min(1).max(200_000),
});
export type CurvePaymentRequest = z.infer<typeof curvePaymentRequestSchema>;
export type CurvePaymentBuild = z.infer<typeof curvePaymentBuildSchema>;

/** Only these server-built curve actions can request Blast gas. */
export const curveSponsorRequestSchema = z.object({
  launch_id: z.string().regex(SUI_OBJECT_ID_PATTERN),
  sponsor: z.literal(true),
  direction: z.enum(["buy", "sell"]),
  amount: socialPositiveAtomsSchema,
  min_out: socialPositiveAtomsSchema,
  quote_id: z.string().min(1).max(3000).optional(),
}).strict().refine(value => value.direction === "buy" || value.quote_id === undefined);
export const curveSponsoredBuildSchema = z.object({
  reservation_id: z.string().uuid(),
  transaction_bytes: z.string().min(1).max(200_000),
  expires_at_ms: z.number().int().positive(),
  transaction_kind_bytes: z.string().min(1).max(200_000),
});
export type CurveSponsorRequest = z.infer<typeof curveSponsorRequestSchema>;
export type CurveSponsoredBuild = z.infer<typeof curveSponsoredBuildSchema>;
