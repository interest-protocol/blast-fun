import { short as coreShort } from "@blast/core/lib/format.ts";

/** Compact dollars, including the billion-dollar values supported by creation. */
export function short(value: number): string {
  return value >= 1e9 ? `$${(value / 1e9).toFixed(2).replace(/\.?0+$/, "")}B` : coreShort(value);
}
