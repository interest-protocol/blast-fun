import { z } from "zod";

const vestingTermsSchema = z.union([
  z.object({
    kind: z.literal("linear"),
    start_ms: z.string(),
    cliff_ms: z.string(),
    period_ms: z.string(),
    periods: z.string(),
  }),
  z.object({
    kind: z.literal("checkpoints"),
    checkpoints: z.array(z.object({ timestamp_ms: z.string(), cumulative_amount: z.string() })),
  }),
  z.object({
    kind: z.literal("checkpoints"),
    checkpoints: z.null(),
    checkpoint_count: z.string(),
  }),
]);

export const publicVestingSchema = z.object({
  schedule_id: z.string(),
  coin_type: z.string(),
  beneficiary: z.string(),
  creator: z.string().nullable(),
  total: z.string(),
  released: z.string(),
  refunded: z.string(),
  refund_recipient: z.string().nullable(),
  cancel_cap_id: z.string().nullable(),
  terms: vestingTermsSchema,
  status: z.enum(["active", "canceled", "closed"]),
  created_timestamp_ms: z.string().nullable(),
  created_digest: z.string().nullable(),
  coin_name: z.string().nullable(),
  coin_symbol: z.string().nullable(),
  coin_decimals: z.number().nullable(),
  coin_icon_url: z.string().nullable(),
  indexed: z.boolean(),
});

export const walletVestingSchedulesSchema = z.object({
  wallet: z.string().nullable(),
  schedules: z.array(publicVestingSchema),
});

export const vestingEligibilitySchema = z.object({ can_cancel: z.boolean() });

// Byte decoding and transaction review remain in the signing workflow. This boundary
// checks the response shape without interpreting or normalizing transaction material.
export const vestingAttemptResponseSchema = z.object({
  request_id: z.string(),
  action: z.enum(["create", "claim", "cancel", "close"]),
  state: z.enum(["submitted", "confirmed", "failed"]),
  digest: z.string(),
  transaction_bytes: z.string(),
  schedule_id: z.string().nullable(),
  gas_budget: z.string(),
  expires_at_ms: z.number(),
  // Historical wallet-paid attempts omit this; every preparation is now sponsored and never falls back to wallet gas.
  sponsor_reservation_id: z.string().nullable().optional(),
});
