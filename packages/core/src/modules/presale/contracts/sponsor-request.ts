import { Buffer } from "node:buffer";
import { z } from "zod";

import { namesPresale, PUBLIC_SPONSOR_INTENTS } from "../../sponsor/intents.ts";
import { addressSchema, base64Schema } from "./primitives.ts";

export const sponsorIntentSchema = z.enum(PUBLIC_SPONSOR_INTENTS);
const presaleIntentSchema = sponsorIntentSchema.extract(PUBLIC_SPONSOR_INTENTS.filter(namesPresale));
const common = { sender: addressSchema, transaction_kind_bytes: base64Schema };

export const sponsorRequestSchema = z
  .union([
    z.strictObject({ presale_id: addressSchema, ...common, intent: presaleIntentSchema }),
    z.strictObject({ ...common, intent: z.literal("withdraw") }),
  ])
  .meta({
    $id: "https://blast-v2.invalid/presale/contracts/sponsor-request.schema.json",
    title: "Sponsor request",
    description:
      "POST /api/presale/sponsor. A presale intent names its presale; withdraw (the embedded wallet sends its own coins to one address, social UI-14) names none.",
  });

export const sponsorSubmissionSchema = sponsorRequestSchema.refine(
  ({ transaction_kind_bytes: value }) =>
    value.length % 4 === 0 && Buffer.from(value, "base64").toString("base64") === value,
);

export type SponsorRequest = z.infer<typeof sponsorRequestSchema>;
export type { PublicSponsorIntent } from "../../sponsor/intents.ts";
