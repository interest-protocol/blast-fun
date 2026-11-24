import { normalizeStructTag } from "@mysten/sui/utils";
import { z } from "zod";
import { boundedInteger } from "@blast/core/lib/config/bounded-integer.ts";
import { SUI_OBJECT_ID_PATTERN } from "@blast/core/lib/sui/ids.ts";

export const objectIdSchema = z.string().regex(SUI_OBJECT_ID_PATTERN);
export const hashSchema = z.string().regex(/^[0-9a-f]{64}$/);
export const u64Schema = z
  .string()
  .regex(/^(0|[1-9][0-9]{0,19})$/)
  .pipe(z.string().refine((value) => BigInt(value) < 1n << 64n));
export const positiveMistSchema = z
  .string()
  .regex(/^[0-9]{1,20}$/)
  .pipe(
    z
      .string()
      .transform(BigInt)
      .pipe(
        z
          .bigint()
          .min(1n)
          .max((1n << 64n) - 1n),
      ),
  );
export const deploymentEnvironmentSchema = z.enum(["production", "non-production"]);
export const normalizedCoinSchema = z.string().transform((value, context) => {
  try {
    return normalizeStructTag(value);
  } catch {
    context.addIssue({ code: "custom", message: "Invalid coin type" });
    return z.NEVER;
  }
});
export const canonicalCoinSchema = z.string().refine((value) => {
  try {
    return normalizeStructTag(value) === value;
  } catch {
    return false;
  }
});

/**
 * `boundedInteger` for a worker setting, written in decimal digits only: `0x10`, `1e3`, `+5` and
 * `1.0` stop the worker at start instead of being read as numbers.
 */
export function wholeNumberSetting(
  environment: Readonly<Record<string, string | undefined>>,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const raw = environment[name]?.trim();
  if (raw && !/^\d+$/.test(raw)) throw new Error(`${name} must be an integer from ${minimum} to ${maximum}.`);
  return boundedInteger(environment, name, fallback, minimum, maximum);
}
