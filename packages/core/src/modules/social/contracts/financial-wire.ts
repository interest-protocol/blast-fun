import { z } from "zod";

import { COIN_TYPE, COIN_TYPE_WITH_GENERICS } from "../../../lib/sui/ids.ts";

export {
  socialAddressSchema as financialAddressSchema,
  socialUuidSchema as financialUuidSchema,
  socialRequestIdSchema as financialRequestIdSchema,
} from "./primitives.ts";

/** Published syntax bounds; execution also verifies SDK identities and u64 ranges. */
export const financialAtomsSchema = z.string().regex(/^(0|[1-9][0-9]{0,19})$/);
export const financialPositiveAtomsSchema = z
  .string()
  .regex(/^[1-9][0-9]{0,19}$/);
export const financialDigestSchema = z
  .string()
  .regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
export const financialBase64Schema = z
  .string()
  .regex(new RegExp("^[A-Za-z0-9+/]+={0,2}$"));
export const financialPlainCoinTypeSchema = z.string().regex(COIN_TYPE);

export function isFinancialCoinType(value: string): boolean {
  return COIN_TYPE_WITH_GENERICS.test(value);
}

export const financialCoinTypeSchema = z
  .string()
  .min(8)
  .max(512)
  .regex(COIN_TYPE_WITH_GENERICS);
export const financialDecimalSchema = z
  .string()
  .regex(/^(0|[1-9][0-9]*)(\.[0-9]+)?$/);
export const financialUsdSchema = z
  .string()
  .regex(/^(0|[1-9][0-9]*)\.[0-9]{2}$/);

// JSON Schema integers have no implicit JavaScript safe-integer ceiling.
export const financialIntegerSchema = z.number().refine(Number.isInteger);

export type FinancialReadonly<T> = T extends readonly unknown[]
  ? Readonly<{ [Key in keyof T]: FinancialReadonly<T[Key]> }>
  : T extends object
    ? { readonly [Key in keyof T]: FinancialReadonly<T[Key]> }
    : T;

/** JSON Schema measures string bounds in Unicode code points, including astral symbols. */
export function financialTextSchema(bounds: {
  minLength?: number;
  maxLength: number;
}) {
  return z
    .string()
    .refine((value) => {
      const length = [...value].length;
      return length >= (bounds.minLength ?? 0) && length <= bounds.maxLength;
    })
    .meta(bounds);
}

/** A coin logo URL on the wire: at most 2,048 code points. */
export const financialIconUrlSchema = financialTextSchema({ maxLength: 2048 });

/**
 * `url` when the wire can carry it, else null. Many coins store their logo
 * inline as a `data:` image far over the bound, and one such logo would make
 * the client reject the whole answer.
 */
export function wireIconUrl(url: string | null | undefined): string | null {
  return url && financialIconUrlSchema.safeParse(url).success ? url : null;
}

/** `text` cut to `maxLength` code points, or null when it is missing or blank. */
export function wireText(text: string | null | undefined, maxLength: number): string | null {
  return text?.trim() ? [...text].slice(0, maxLength).join("") : null;
}

/** A coin type's own name, without its generics, in at most `maxLength` code points: `WHALE` for `0x…::whale::WHALE`. */
export function coinTypeName(coinType: string, maxLength: number): string {
  return [...(coinType.split("<", 1)[0]!.split("::").at(-1) || coinType)].slice(0, maxLength).join("");
}

/**
 * The symbol and name a coin shows, never empty: its own symbol, else its
 * type's name (else `COIN`); its own name, else the symbol. Anyone can publish a coin, and
 * a presale or vault can sell one, with an empty symbol or name.
 */
export function coinLabel(coin: Readonly<{ coinType: string; symbol: string | null | undefined; name: string | null | undefined }>): { symbol: string; name: string } {
  const symbol = (coin.symbol?.trim() && coin.symbol) || coinTypeName(coin.coinType, 32) || "COIN";
  return { symbol, name: (coin.name?.trim() && coin.name) || symbol };
}
