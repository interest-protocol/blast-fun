import { z } from "zod";

/**
 * Numbers on the launchpad wire, as blast-infra's `/v1` writes them (its
 * docs/api.md "Numbers on the wire"): amounts, reserves, supply, prices,
 * market caps and USD values are decimal strings, never JSON numbers; counts,
 * milliseconds and checkpoints are JSON safe integers. Both hosts use these
 * rules, and a value that breaks them is a contract violation, never a zero.
 * These parsers are shared with browser read contracts: Zod is the only external
 * runtime in that graph; SDK value imports and server modules stay excluded.
 */

/** A value that does not meet the wire contract. `field` names where. */
export class ContractViolation extends Error {
  readonly field: string;

  constructor(field: string, message: string) {
    super(`${field}: ${message}`);
    this.name = "ContractViolation";
    this.field = field;
  }
}

export const unsignedAtomicSchema = z.string().regex(/^(0|[1-9][0-9]*)$/);
export const signedAtomicSchema = z.string().regex(/^(0|-?[1-9][0-9]*)$/);
export const countSchema = z.number().int().nonnegative();
export const recordSchema = z.record(z.string(), z.unknown());
export const listSchema = z.array(z.unknown());

export function matchesSchema<Value>(schema: z.ZodType<Value>, value: unknown): value is Value {
  return schema.safeParse(value).success;
}

const objectSchemas = new Map<string, z.ZodObject>();

/** Preserve the contract's field errors while Zod owns the closed object shape. */
export function contractObject(value: unknown, field: string, keys: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  contractValue(recordSchema, value, field, "must be an object");
  const cacheKey = JSON.stringify([keys, optional]);
  let schema = objectSchemas.get(cacheKey);
  if (!schema) {
    const optionalKeys = new Set(optional);
    const shape = Object.fromEntries([...new Set([...keys, ...optional])].map((key) => [key,
      optionalKeys.has(key) ? z.unknown().optional() : z.unknown().nonoptional(),
    ]));
    schema = z.strictObject(shape);
    objectSchemas.set(cacheKey, schema);
  }
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  const extra = parsed.error.issues.find((issue) => issue.code === "unrecognized_keys");
  if (extra?.code === "unrecognized_keys") throw new ContractViolation(`${field}.${extra.keys[0]}`, "is not in the contract");
  const missing = parsed.error.issues[0]?.path[0];
  throw new ContractViolation(`${field}.${String(missing)}`, "is required");
}

export function contractValue<Schema extends z.ZodType>(schema: Schema, value: unknown, field: string, message: string): z.output<Schema> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new ContractViolation(field, message);
  // Record guards must retain every own key for subsequent closed-shape checks.
  // Zod drops __proto__ while cloning records, so preserve the checked input.
  return (Object.is(schema, recordSchema) ? value : parsed.data) as z.output<Schema>;
}

const PRICE = /^(0|[1-9][0-9]*)(\.[0-9]{0,35}[1-9])?$/;
const USD = /^(0|[1-9][0-9]*)(\.[0-9]{0,17}[1-9])?$/;
const SIGNED_USD = /^-?(0|[1-9][0-9]*)(\.[0-9]{0,17}[1-9])?$/;
const bigintSchema = z.bigint();
const priceSchema = z.string().regex(PRICE);
const usdSchema = z.string().regex(USD).refine((text) => text !== "-0");
const signedUsdSchema = z.string().regex(SIGNED_USD).refine((text) => text !== "-0");

/** An unsigned atomic value: a decimal string of at most `bits` bits (unbounded by default). */
export function parseAtomic(value: unknown, field: string, bits?: 64 | 128 | 256): bigint {
  const text = contractValue(unsignedAtomicSchema, value, field, "must be an unsigned decimal string");
  const parsed = BigInt(text);
  if (bits !== undefined && parsed >= 1n << BigInt(bits)) {
    throw new ContractViolation(field, `must fit in ${bits} bits`);
  }
  return parsed;
}

/** A signed atomic value: a decimal string with an optional leading `-`, never `-0`. */
export function parseSignedAtomic(value: unknown, field: string): bigint {
  return BigInt(contractValue(signedAtomicSchema, value, field, "must be a signed decimal string"));
}

/** An exact bigint as the wire writes it. */
export function atomicString(value: bigint): string {
  return contractValue(bigintSchema, value, "value", "must be a bigint").toString();
}

/**
 * The canonical price string: quote atoms per meme atom, truncated toward zero
 * at 36 fractional digits, without exponent or trailing fractional zeros.
 */
export function parsePriceString(value: unknown, field: string): string {
  return contractValue(priceSchema, value, field, "must be a canonical price decimal string");
}

/** A USD string: at most 18 fractional digits; negative only for `signed` results, never `-0`. */
export function parseUsdString(value: unknown, field: string, options: { signed?: boolean } = {}): string {
  const schema = options.signed ? signedUsdSchema : usdSchema;
  return contractValue(schema, value, field,
    `must be a${options.signed ? " signed" : ""} USD decimal string`);
}

/** A count, checkpoint or millisecond value: a JSON safe integer, never negative. */
export function parseCount(value: unknown, field: string): number {
  return contractValue(countSchema, value, field, "must be a non-negative JSON safe integer");
}
