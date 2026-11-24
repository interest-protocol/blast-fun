import { TransactionDataBuilder } from "@mysten/sui/transactions";
import { fromBase64, normalizeSuiAddress, toBase64 } from "@mysten/sui/utils";

import { readSocialBody, readSocialJson, SOCIAL_BODY_LIMIT_BYTES } from "@blast/server/modules/social/route-kit/route.ts";

import { SocialRouteError } from "@blast/core/modules/social/route-kit/errors.ts";

export type DigestProvenanceInput = Readonly<{
  digest: string;
  sender: string;
  transactionBytes?: unknown;
}>;

/** Prove ownership before reserving a globally unique digest. Gas ownership is independent. */
export async function verifyDigestProvenance(
  input: DigestProvenanceInput,
  executedSender: () => Promise<string | null>,
): Promise<void> {
  let sender: string | null;
  if (input.transactionBytes !== undefined) {
    try {
      const encoded = input.transactionBytes;
      if (typeof encoded !== "string" || encoded.length === 0 || encoded.length > 180_000) throw new Error("Invalid bytes");
      const bytes = fromBase64(encoded);
      if (toBase64(bytes) !== encoded || TransactionDataBuilder.getDigestFromBytes(bytes) !== input.digest) throw new Error("Digest mismatch");
      sender = TransactionDataBuilder.fromBytes(bytes).getData().sender ?? null;
    } catch {
      throw new SocialRouteError("invalid_request");
    }
  } else {
    // Older clients can submit an already executed digest without bytes.
    // Unknown transactions and outages reserve nothing; pending clients send bytes.
    sender = await executedSender().catch(() => null);
    if (sender === null) throw new SocialRouteError("service_unavailable");
  }
  if (sender === null || normalizeSuiAddress(sender) !== normalizeSuiAddress(input.sender)) throw new SocialRouteError("invalid_request");
}

/** Allow bounded proof bytes while retaining the small limit for the financial facts. */
export async function readDigestJson<const Required extends string, const Optional extends string>(
  request: Request,
  required: readonly Required[],
  optional: readonly Optional[],
) {
  if (request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") throw new SocialRouteError("invalid_request");
  const raw = await readSocialBody(request, 192 * 1_024);
  let proofSize = 0;
  try {
    const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw)) as Record<string, unknown> | null;
    if (value && typeof value.transaction_bytes === "string") proofSize = Buffer.byteLength(value.transaction_bytes);
  } catch {
    // Preserve the ordinary body limit even for oversized malformed JSON.
  }
  if (raw.byteLength - proofSize > SOCIAL_BODY_LIMIT_BYTES) throw new SocialRouteError("body_too_large");
  const bounded = new Request(request.url, { method: "POST", headers: request.headers, body: raw });
  return readSocialJson(bounded, required, [...optional, "transaction_bytes"], 192 * 1_024);
}
