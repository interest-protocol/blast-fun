import { z } from "zod";

import { addressSchema, digestSchema } from "./primitives.ts";

export const outcomeRequestSchema = z
  .strictObject({ presale_id: addressSchema, tx_digest: digestSchema })
  .meta({
    $id: "https://blast-v2.invalid/presale/contracts/outcome-request.schema.json",
    title: "Outcome registration",
    description: "POST /api/presale/outcomes/commitments and POST /api/presale/outcomes.",
  });

// Submission has always required a 43–44 character digest; the published wire
// definition also serves other payloads and deliberately remains broader.
export const outcomeSubmissionSchema = outcomeRequestSchema.extend({
  tx_digest: digestSchema.min(43),
});

export type OutcomeRequest = z.infer<typeof outcomeRequestSchema>;
