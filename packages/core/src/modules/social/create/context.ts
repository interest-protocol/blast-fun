import type { CreateFeePolicy, CreatePublishAvailability, CreateQuotePrice } from "../contracts/create.ts";
import { CREATE_PUBLISH_BLOCKERS } from "../contracts/create.ts";
import type { BluefinCreateOptions } from "./bluefin-options.ts";
import type { CreateCetusTiers } from "./cetus-options.ts";

export const CREATE_CONTEXT_MAX_BYTES = 1024 * 1024;
export type CreatePageContext = Readonly<{
  fees: CreateFeePolicy;
  publish: CreatePublishAvailability;
  quotes: readonly string[];
  suiPrice: CreateQuotePrice | null;
  cetusTiers: CreateCetusTiers | null;
  bluefinOptions: BluefinCreateOptions;
}>;

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid create context");
  return value as Record<string, unknown>;
}
function strings(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}
function keys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === expected.length && actual.every((key) => expected.includes(key));
}
function feesValid(value: unknown): boolean {
  const fees = record(value);
  return keys(fees, ["raise_bps", "token_bps", "lp_fee_meme_bps", "lp_fee_quote_bps", "source"])
    && [fees.raise_bps, fees.token_bps, fees.lp_fee_meme_bps, fees.lp_fee_quote_bps]
    .every((item) => typeof item === "number" && Number.isSafeInteger(item) && item >= 0 && item <= 10_000)
    && (fees.source === "chain" || fees.source === "config");
}
function publishValid(value: unknown): boolean {
  const publish = record(value);
  if (publish.available === true) return keys(publish, ["available"]);
  return keys(publish, ["available", "reasons"]) && publish.available === false && strings(publish.reasons)
    && publish.reasons.every((reason) => (CREATE_PUBLISH_BLOCKERS as readonly string[]).includes(reason));
}
function venuesValid(context: Record<string, unknown>): boolean {
  const bluefin = record(context.bluefinOptions);
  if (bluefin.status === "unavailable") {
    if (!keys(bluefin, ["status"])) return false;
  } else if (!keys(bluefin, ["status", "min_tick", "max_tick"]) || bluefin.status !== "ready"
    || !Number.isSafeInteger(bluefin.min_tick) || !Number.isSafeInteger(bluefin.max_tick)) return false;
  if (context.cetusTiers === null) return true;
  return Object.values(record(context.cetusTiers)).every((tiers) => Array.isArray(tiers)
    && tiers.every((pair) => Array.isArray(pair) && pair.length === 2 && pair.every((item) => Number.isSafeInteger(item))));
}
function priceValid(value: unknown): boolean {
  if (value === null) return true;
  const price = record(value);
  return keys(price, ["usd_price", "as_of_ms"]) && typeof price.usd_price === "string" && Number.isSafeInteger(price.as_of_ms);
}

/** Internal authenticated producer, with a closed primitive DTO and bounded raw JSON. */
export function decodeCreateContext(text: string): CreatePageContext {
  if (Buffer.byteLength(text) > CREATE_CONTEXT_MAX_BYTES) throw new Error("Invalid create context");
  const wire = record(JSON.parse(text));
  if (wire.schema !== "blast.create-context.v1" || !keys(wire, ["context", "schema"])) throw new Error("Invalid create context");
  const value = record(wire.context);
  if (!keys(value, ["bluefinOptions", "cetusTiers", "fees", "publish", "quotes", "suiPrice"])
    || !feesValid(value.fees) || !publishValid(value.publish) || !strings(value.quotes)
    || !priceValid(value.suiPrice) || !venuesValid(value)) throw new Error("Invalid create context");
  return value as CreatePageContext;
}

export function encodeCreateContext(context: CreatePageContext): string {
  const result = JSON.stringify({ schema: "blast.create-context.v1", context });
  // Validate the actual serialized representation, including accidental non-JSON producer values.
  decodeCreateContext(result);
  return result;
}
