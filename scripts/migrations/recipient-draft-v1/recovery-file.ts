import { createHash } from "node:crypto";
import {
  normalizeRecipientDraftV1,
  RecipientDraftNormalizationError,
} from "./normalize.ts";

const MAX_BYTES = 1_048_576;

/** Compare decimal tokens exactly without expanding exponents or rounding them. */
function decimalToken(source: string): string {
  const match = /^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(source);
  if (!match) throw new Error("recipient_recovery_invalid: number");
  const [, sign, whole, fraction = "", exponent = "0"] = match;
  const digits = (whole + fraction).replace(/^0+/, "");
  if (!digits) return "0";
  if (exponent.replace(/^[+-]?0*/, "").length > 8)
    throw new Error("recipient_recovery_invalid: number");
  const significant = digits.replace(/0+$/, "");
  const scale = BigInt(exponent) - BigInt(fraction.length) + BigInt(digits.length - significant.length);
  return `${sign}${significant}e${scale}`;
}

export function recipientRecoveryFile(source: Uint8Array): string {
  if (source.byteLength > MAX_BYTES)
    throw new Error("recipient_recovery_invalid: size");
  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(source),
      (_key: string, value: unknown, context?: { source?: string }) => {
        if (typeof value === "number" &&
          (!Number.isFinite(value) || !context?.source || decimalToken(context.source) !== decimalToken(String(value))))
          throw new Error("recipient_recovery_invalid: number");
        return value;
      });
  } catch {
    throw new Error("recipient_recovery_invalid: json_or_utf8");
  }
  try {
    const normalized = normalizeRecipientDraftV1(body);
    const output =
      JSON.stringify({
        schema: "blast.social-create-guest-draft",
        version: 1,
        draft: normalized.body,
        recovered_from: createHash("sha256").update(source).digest("hex"),
      }) + "\n";
    if (Buffer.byteLength(output, "utf8") > MAX_BYTES)
      throw new Error("recipient_recovery_invalid: size");
    return output;
  } catch (error) {
    if (error instanceof RecipientDraftNormalizationError)
      throw new Error(`recipient_recovery_invalid: ${error.field}`);
    throw new Error("recipient_recovery_invalid: draft");
  }
}
