import { z } from "zod";

import { addressSchema, base64Schema, coinTypeSchema, digestSchema, uintSchema } from "./primitives.ts";

import type { DecimalString } from "./wire.ts";

const timestampSchema = z.number().nonnegative().refine(Number.isInteger).meta({ type: "integer" });

export const sponsorResponseSchema = z.strictObject({
  reservation_id: z.string().min(1).refine((value) => [...value].length <= 128).meta({ maxLength: 128 }),
  transaction_bytes: base64Schema,
  sponsor_signature: z.literal(""),
  expires_at_ms: timestampSchema,
  gas_budget: uintSchema,
});

export const executeResponseSchema = z.strictObject({
  digest: digestSchema,
  effects: z.strictObject({
    status: z.enum(["success", "failure"]),
    gas_used: z.string().regex(/^(0|-?[1-9][0-9]*)$/),
  }),
});

export const allowlistProofResponseSchema = z.strictObject({
  index: uintSchema,
  wallet_cap: uintSchema,
  proof: z.array(z.string().regex(/^[0-9a-f]{64}$/)).max(16),
});

export type AllowlistLeaf = Readonly<Omit<z.infer<typeof allowlistProofResponseSchema>, "proof"> & { proof: readonly string[] }>;

const allowlistAtomsSchema = uintSchema.transform((value) => value as DecimalString);
const allowlistCountSchema = z.number().nonnegative().refine(Number.isInteger);
const allowlistSourceSchema = z.strictObject({
  file_name: z.string().refine((value) => [...value].length <= 200),
  uploaded_count: allowlistCountSchema,
  include_blast_holders: z.boolean(),
  added_count: allowlistCountSchema,
  holder_cap: allowlistAtomsSchema.nullable(),
});

export const allowlistEntriesResponseSchema = z.strictObject({
  quote: coinTypeSchema,
  source: allowlistSourceSchema.nullable(),
  entries: z.array(z.strictObject({ wallet: addressSchema, cap: allowlistAtomsSchema })).min(1).max(65_536),
});

export const allowlistResponseSchema = z.strictObject({
  allowlist_id: z.string().min(1).refine((value) => [...value].length <= 128),
  root: z.string().regex(/^[0-9a-f]{64}$/),
  leaf_count: allowlistAtomsSchema,
  entry_count: allowlistCountSchema,
  total_cap: allowlistAtomsSchema,
  warnings: z.array(z.strictObject({
    code: z.enum(["quote_not_allowed", "normalized_address"]),
    message: z.string().min(1),
    row: allowlistCountSchema.min(1).optional(),
  })),
});

// Signing flows consume these projections; keep the rest of the server answer intact.
// Byte decoding and digest equality belong to the signing verifier and its specific refusals.
export const sponsoredTransactionSchema = sponsorResponseSchema
  .pick({ reservation_id: true, transaction_bytes: true, expires_at_ms: true })
  .extend({ transaction_bytes: z.string() }).loose();
export type SponsoredTransaction = Readonly<z.infer<typeof sponsoredTransactionSchema>>;

export const executedSponsoredSchema = executeResponseSchema.pick({ digest: true }).extend({
  digest: z.string(),
  effects: executeResponseSchema.shape.effects.pick({ status: true }).loose(),
}).loose();
export type ExecutedSponsored = Readonly<z.infer<typeof executedSponsoredSchema>>;
