import { z } from "zod";
import { matchesSchema, contractObject, contractValue, recordSchema, ContractViolation, parseAtomic, parsePriceString } from "./decimal.ts";
import { readMarketData, type MarketDataDependencies } from "../read-routing/market-data.ts";
import type { MarketResource } from "../read-routing/resources.ts";
import type { RoutedRead } from "./read.ts";
import { recordMetric } from "@blast/core/lib/metrics.ts";
import { VENUES, type Venue } from "./venues.ts";

/**
 * The validated `/v1` client. blast-infra's answers are checked
 * against the wire contract before any projection uses them: decimal strings
 * stay exact (`bigint`), and an answer that breaks the contract is
 * Unavailable (`contract-violation`), never a zero or a guess. Display
 * economics come from blast-infra; the web app recomputes nothing from SQL,
 * and signing-time economics stay in the SDK.
 */

/** A summary's or trade's `inputs`: everything its price, market cap and supply come from. */
export type MarketInputs = Readonly<{
  virtualQuote: bigint | null;
  memeReserve: bigint | null;
  quoteReserve: bigint | null;
  graduationTarget: bigint | null;
  sqrtPriceX64: bigint | null;
  memeIsCoinA: boolean | null;
  currencySupply: bigint;
  pendingBurnTotal: bigint;
  balance0x0: bigint;
  memeDecimals: bigint;
  quoteDecimals: bigint | null;
}>;

/** The derived values blast-infra published and the inputs they come from. */
export type MarketEconomics = Readonly<{
  venue: Venue;
  price: string | null;
  marketCap: bigint | null;
  /** The live supply; a trade carries none (its inputs hold the supply as it stood). */
  supply: bigint | null;
  inputs: MarketInputs;
}>;

const INPUT_KEYS = [
  "virtual_quote", "meme_reserve", "quote_reserve", "graduation_target", "sqrt_price_x64", "meme_is_coin_a",
  "currency_supply", "pending_burn_total", "balance_0x0", "meme_decimals", "quote_decimals",
];

function record(value: unknown, field: string): Record<string, unknown> {
  return contractValue(recordSchema, value, field, "must be an object");
}

function optional<T>(value: unknown, parse: (value: unknown) => T): T | null {
  return value === null ? null : parse(value);
}

function parseInputs(value: unknown, field: string): MarketInputs {
  const inputs = contractObject(value, field, INPUT_KEYS, INPUT_KEYS);
  const atomic = (key: string, bits?: 64 | 128) => parseAtomic(inputs[key], `${field}.${key}`, bits);
  const maybe = (key: string, bits?: 64 | 128) => optional(inputs[key], () => atomic(key, bits));
  if (inputs.meme_is_coin_a !== null && !matchesSchema(z.boolean(), inputs.meme_is_coin_a)) {
    throw new ContractViolation(`${field}.meme_is_coin_a`, "must be a boolean or null");
  }
  return {
    virtualQuote: maybe("virtual_quote", 64),
    memeReserve: maybe("meme_reserve", 64),
    quoteReserve: maybe("quote_reserve", 64),
    graduationTarget: maybe("graduation_target", 64),
    sqrtPriceX64: maybe("sqrt_price_x64", 128),
    memeIsCoinA: inputs.meme_is_coin_a as boolean | null,
    currencySupply: atomic("currency_supply", 64),
    pendingBurnTotal: atomic("pending_burn_total", 64),
    balance0x0: atomic("balance_0x0", 64),
    memeDecimals: atomic("meme_decimals"),
    quoteDecimals: maybe("quote_decimals"),
  };
}

/**
 * The curve has reserves and no sqrt price (its Meme reserve is unknown until
 * the first trade); a venue pool has a sqrt price, its orientation and no
 * curve fields.
 */
function checkVenueShape(venue: Venue, inputs: MarketInputs, field: string): void {
  const curve = venue === "blast_curve";
  const curveFields = { virtualQuote: inputs.virtualQuote, quoteReserve: inputs.quoteReserve, graduationTarget: inputs.graduationTarget };
  const venueFields = { sqrtPriceX64: inputs.sqrtPriceX64, memeIsCoinA: inputs.memeIsCoinA };
  const [present, absent] = curve ? [curveFields, venueFields] : [venueFields, { ...curveFields, memeReserve: inputs.memeReserve }];
  for (const [name, value] of Object.entries(present)) {
    if (value === null) throw new ContractViolation(`${field}.${name}`, `is required for ${venue}`);
  }
  for (const [name, value] of Object.entries(absent)) {
    if (value !== null) throw new ContractViolation(`${field}.${name}`, `must be null for ${venue}`);
  }
}

/** A pool summary's or trade's economics; other fields are the projection's to parse. */
export function parseMarketEconomics(value: unknown, field = "summary"): MarketEconomics {
  const summary = record(value, field);
  const venue = contractValue(z.enum(VENUES), summary.venue, `${field}.venue`, "is unknown");
  const inputs = parseInputs(summary.inputs, `${field}.inputs`);
  checkVenueShape(venue, inputs, `${field}.inputs`);
  return {
    venue,
    price: optional(summary.price, (price) => parsePriceString(price, `${field}.price`)),
    marketCap: optional(summary.market_cap, (cap) => parseAtomic(cap, `${field}.market_cap`)),
    supply: "supply" in summary ? parseAtomic(summary.supply, `${field}.supply`, 64) : null,
    inputs,
  };
}

/** blast-infra's error envelope. */
export function parseV1Error(value: unknown): Readonly<{ code: string; message: string }> {
  const error = record(record(value, "body").error, "error");
  return {
    code: contractValue(z.string().regex(/^[a-z_]{1,32}$/), error.code, "error.code", "must be a lower_snake code"),
    message: contractValue(z.string(), error.message, "error.message", "must be a string"),
  };
}

/** A validated answer, or blast-infra's refusal (4xx) with its error. */
export type V1Answer<T> =
  | Readonly<{ kind: "answer"; value: T }>
  | Readonly<{ kind: "refused"; httpStatus: number; error: Readonly<{ code: string; message: string }> }>;

/**
 * Reads `path` through the routed market read (provenance, freshness,
 * deployment check) and validates the answer with `parse`.
 */
export async function readV1<T>(
  resource: MarketResource,
  path: string,
  parse: (body: unknown) => T,
  dependencies: MarketDataDependencies,
): Promise<RoutedRead<V1Answer<T>>> {
  const read = await readMarketData<unknown>(resource, path, dependencies);
  if (read.status === "unavailable") return read;
  try {
    const data: V1Answer<T> =
      read.data.httpStatus === 200
        ? { kind: "answer", value: parse(read.data.body) }
        : { kind: "refused", httpStatus: read.data.httpStatus, error: parseV1Error(read.data.body) };
    return { status: read.status, data, provenance: read.provenance };
  } catch (error) {
    if (!(error instanceof ContractViolation)) throw error;
    recordMetric("read.degraded", { resource, outcome: "unavailable", reason: "contract-violation", field: error.field });
    return { status: "unavailable", provenance: { ...read.provenance, reason: "contract-violation" } };
  }
}
