import { Buffer } from "node:buffer";
import { z } from "zod";

import { base64Schema } from "./primitives.ts";

export const executeRequestSchema = z.strictObject({ user_signature: base64Schema }).meta({
  $id: "https://blast-v2.invalid/presale/contracts/execute-request.schema.json",
  title: "Execute request",
  description: "POST /api/presale/sponsor/{reservation_id}/execute.",
});

// Submission has always required canonical padding and pad bits; the wire
// definition also serves other payloads and keeps its broader base64 pattern.
export const executeSubmissionSchema = executeRequestSchema.extend({
  user_signature: base64Schema.refine(
    (value) => value.length % 4 === 0 && Buffer.from(value, "base64").toString("base64") === value,
  ),
});

export type ExecuteRequest = z.infer<typeof executeRequestSchema>;
