import { z } from "zod";
import { exactAtoms, fixedExact, type Exact } from "@blast/core/lib/exact-amount.ts";

const quoteUsdSchema = z.object({
  price: z.string().regex(/^(0|[1-9][0-9]*)$/),
  expo: z.number().int().min(-255).max(20),
  publish_time: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  age_ms: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
});

/** Convert a pool or swap's quote-atomic cap using its own USD stamp. */
export function marketCapUsd(cap: bigint | string | null, decimals: bigint | string | null, stamp: unknown): string | null {
  if (decimals === null || (typeof decimals === "string" && !/^(0|[1-9][0-9]{0,2})$/.test(decimals))) return null;
  const units = Number(decimals);
  if (units > 255) return null;
  return quoteValueUsd(exactAtoms(cap, units), stamp);
}

/** Convert a value in whole quote units with the matching USD stamp. */
export function quoteValueUsd(amount: Exact | null, stamp: unknown): string | null {
  const quote = quoteUsdSchema.safeParse(stamp);
  if (!amount || !quote.success) return null;
  const value = { n: amount.n * BigInt(quote.data.price), scale: amount.scale - quote.data.expo };
  return fixedExact(value, Math.max(0, value.scale));
}
