import { SUI_ADDRESS_INPUT_PATTERN, SUI_OBJECT_ID_PATTERN } from "@blast/core/lib/sui/ids.ts";
import { isValidTransactionDigest, normalizeStructTag } from "@mysten/sui/utils";
import { z } from "zod";

export const socialAddressSchema = z.string().regex(SUI_OBJECT_ID_PATTERN);
export const socialAddressInputSchema = z.string().regex(SUI_ADDRESS_INPUT_PATTERN);
export const socialCallsignSchema = z.string().regex(/^[a-z0-9][a-z0-9_]{1,18}[a-z0-9]$/);
export const socialUuidSchema = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
export const socialRequestIdSchema = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
export const socialCountSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const socialAtomsSchema = z.string().regex(/^(0|[1-9][0-9]{0,19})$/)
  .pipe(z.string().refine((value) => BigInt(value) <= 18_446_744_073_709_551_615n));
export const socialPositiveAtomsSchema = z.string().regex(/^[1-9][0-9]{0,19}$/)
  .pipe(z.string().refine((value) => BigInt(value) <= 18_446_744_073_709_551_615n));
export const socialDigestSchema = z.string().refine(isValidTransactionDigest);
export const socialCoinTypeSchema = z.string().min(8).max(512).refine((value) => {
  try {
    return normalizeStructTag(value) === value;
  } catch {
    return false;
  }
});
