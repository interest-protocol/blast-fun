import { z } from "zod";

import { addressSchema, coinTypeSchema, uintSchema } from "./primitives.ts";

export const allowlistBindRequestSchema = z.strictObject({ presale_id: addressSchema }).meta({
  $id: "https://blast-v2.invalid/presale/contracts/allowlist-bind-request.schema.json",
  title: "Allowlist bind request",
  description: "POST /api/presale/allowlists/{allowlist_id}/bind.",
});

export const allowlistCreateRequestSchema = z
  .strictObject({
    quote: coinTypeSchema,
    entries: z
      .array(z.strictObject({ wallet: addressSchema, cap: uintSchema }))
      .min(1)
      .max(65_536),
    include_blast_holders: z.boolean().meta({ default: false }).optional(),
  })
  .meta({
    $id: "https://blast-v2.invalid/presale/contracts/allowlist-create-request.schema.json",
    title: "Allowlist create request (JSON)",
    description:
      "POST /api/presale/allowlists as JSON; cap is Quote atoms. The CSV form is multipart/form-data with a file part file (header wallet,cap) and a form field quote (CL-6c).",
  });

// Upload rows accept short addresses and zero-padded caps, reporting row errors
// after validating the envelope so error precedence and warnings remain stable.
export const allowlistUploadEnvelopeSchema = z.strictObject({
  quote: z.unknown().nonoptional(),
  entries: z.array(z.unknown()),
  include_blast_holders: z.unknown().optional(),
});

export const allowlistUploadRowSchema = z
  .strictObject({ wallet: z.unknown(), cap: z.unknown() })
  .refine((value) => Object.hasOwn(value, "wallet") && Object.hasOwn(value, "cap"));

export type AllowlistBindRequest = z.infer<typeof allowlistBindRequestSchema>;
export type AllowlistCreateRequest = z.infer<typeof allowlistCreateRequestSchema>;
