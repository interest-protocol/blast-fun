import { z } from "zod";

import { EVENT_CURSOR } from "./cursor.ts";
import { SUI_OBJECT_ID_PATTERN } from "@blast/core/lib/sui/ids.ts";
import { POOL_KEY } from "./venues.ts";

const cursor = z.string().regex(EVENT_CURSOR);
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const bps = z.string().regex(/^(0|[1-9][0-9]{0,3}|10000)$/);
const usd = z.string().regex(/^(0|[1-9][0-9]*)(\.[0-9]+)?$/);
const pool = z.string().regex(POOL_KEY);
const observation = { cursor, timestamp_ms: count };

const marketSchema = z
  .object({
    market_cap_usd: usd.nullable(),
    fdv_usd: usd.nullable().optional(),
    change_24h_bps: z
      .string()
      .regex(/^-?(0|[1-9][0-9]*)$/)
      .nullable(),
    interval_end_ms: count,
    baseline_timestamp_ms: count.nullable(),
    baseline_pool: pool.nullable(),
    current_pool: pool,
    basis: z.literal("usd_price"),
    baseline_resolution_ms: z.literal(300_000),
  })
  .strict()
  .refine(
    (value) =>
      value.change_24h_bps === null ||
      (value.baseline_timestamp_ms !== null &&
        value.baseline_pool !== null &&
        value.baseline_timestamp_ms <= value.interval_end_ms - 86_400_000 &&
        value.baseline_timestamp_ms > value.interval_end_ms - 90_000_000),
  );

const feePolicySchema = z
  .object({
    curve: z
      .object({ protocol_bps: bps, ...observation })
      .strict()
      .nullable(),
    lp: z
      .object({
        policy_id: z.string().regex(SUI_OBJECT_ID_PATTERN),
        meme_bps: bps,
        quote_bps: bps,
        source: z.enum(["default", "override"]),
        override_cursor: cursor.nullable(),
        override_timestamp_ms: count.nullable(),
        ...observation,
      })
      .strict()
      .nullable(),
  })
  .strict();

export type CoinMarket = z.infer<typeof marketSchema>;
export type CoinFeePolicy = z.infer<typeof feePolicySchema>;

/** Optional enrichment is independently validated; older or malformed producers cannot hide a coin. */
export function parseCoinMarket(value: unknown): CoinMarket | null {
  const parsed = marketSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function parseCoinFeePolicy(value: unknown): CoinFeePolicy | null {
  const parsed = feePolicySchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function parseOptionalHolders(value: unknown): number | null {
  const parsed = count.safeParse(value);
  return parsed.success ? parsed.data : null;
}
