import { z } from "zod";

import { socialAsOfSchema } from "@blast/core/modules/social/contracts/items.ts";
import { SUI_OBJECT_ID_PATTERN } from "@blast/core/lib/sui/ids.ts";

/**
 * `GET /api/social/prices`: a coin's USD price over time, and the two
 * figures derived from it — the move over 24 hours and the price at the
 * day's open (R3-20, OA-27). The web's only reader of blast-infra's
 * `chain_read_v1.price_history` (bucketed prices: `5m` kept 7 days, `1h`
 * kept 400 days, `1d` for ever, each bucket holding the last price in it,
 * `as_of_ms` that price's own time) beside `chain_read_v1.prices` (the price
 * now). Migrated sales without USD pricing may include `quote`: real pool
 * prices in the quote coin, with sparse observations and no synthetic endpoints.
 * Missing USD fields stay null. The partner v1 response uses
 * `schemas/prices-response.schema.json` and omits `price_as_of_ms`.
 *
 * Public (`auth: "none"`, bucket `social_read_prices`, read on the replica,
 * `public, s-maxage=10, stale-while-revalidate=20` on a 200; errors
 * `no-store`); no viewer field, the same answer for every caller.
 *
 * Query:
 * - `presale`: a sale (repeatable, 1 to `PRICE_MAX_PRESALES`): its coin's
 *   prices, once the sale trades. A sale the web does not show
 *   (`SHOWN_PRESALES`) or that does not trade yet has no entry.
 * - `coin`: a coin type (repeatable, 1 to `PRICE_MAX_COINS`), for the quote
 *   coins (SUI's "today" in the coin sheet and the dock).
 * - `window`: `1h`, `6h`, `24h` (default), `7d`, `30d`, or `launch` — since
 *   the sale started trading (presales only).
 * - `interval`: optional `5m`, `1h` or `1d` source tier. The server uses a
 *   coarser tier if needed to bound the read; each history reports its tier.
 * - `points`: how many points the chart draws, 2 to `PRICE_MAX_POINTS`
 *   (default `PRICE_DEFAULT_POINTS`).
 *
 * At least one `presale` or `coin`; a malformed or repeated-past-the-limit
 * parameter is `400 invalid_parameter`; no readable watermark is
 * `503 service_unavailable`.
 *
 * **Every number is the chain's, nothing is drawn in.** Windows end at the
 * chain clock (`clock_ms`, the earlier of the watermark and the server's
 * clock). A series is the window's buckets from the finest tier that covers
 * it in at most `PRICE_MAX_POINTS` buckets (`5m` up to a day, `1h` up to 12
 * days, `1d` beyond: blast-infra's rule), thinned to evenly spaced buckets
 * when the chart draws fewer, each plotted at its price's own time; a bucket
 * with no move has no row, so a gap is a straight segment between two real
 * prices. The 24 h window starts on the price at its cutoff and the series
 * ends with the price now (`chain_read_v1.prices`). The cutoff price uses
 * the native coin's pool close repriced at the cutoff when available, or
 * the newest `5m` price published in the hour leading up to the cutoff.
 * The UTC day opens on the newest `5m` price published in the hour before
 * midnight. A missing cutoff price leaves the 24 h change null.
 */
export const SOCIAL_PRICES_ROUTE = "GET /api/social/prices";
export const SOCIAL_PRICES_PATH = "/api/social/prices";

export const PRICE_WINDOWS = ["1h", "6h", "24h", "7d", "30d", "launch"] as const;
export type PriceWindow = (typeof PRICE_WINDOWS)[number];
export const PRICE_WINDOW_MS = {
  "1h": 3_600_000,
  "6h": 21_600_000,
  "24h": 86_400_000,
  "7d": 604_800_000,
  "30d": 2_592_000_000,
} as const;
export const PRICE_WINDOW_LABELS: Readonly<Record<PriceWindow, string>> = {
  "1h": "1H",
  "6h": "6H",
  "24h": "24H",
  "7d": "7D",
  "30d": "30D",
  launch: "All",
};
export const PRICE_TIERS = ["5m", "1h", "1d"] as const;

/** blast-infra's bucket tiers and their spans (`usd_price_bucket_tiers()`). */
export const PRICE_TIER_SPAN_MS = Object.freeze({
  "5m": 300_000,
  "1h": 3_600_000,
  "1d": 86_400_000,
} as const);
export type PriceTier = keyof typeof PRICE_TIER_SPAN_MS;

/** The most buckets one window reads from its tier, and the most points a series carries. */
export const PRICE_MAX_POINTS = 288;
/** What a sparkline draws (the gate's live spark keeps 60 ticks). */
export const PRICE_DEFAULT_POINTS = 60;
export const PRICE_MAX_PRESALES = 50;
export const PRICE_MAX_COINS = 4;

/** The observation time (ms) and decimal price, in USD or the enclosing quote's units. */
export type PricePoint = z.infer<typeof pricesHistorySchema>["points"][number];

export type SocialPriceHistory = Readonly<z.infer<typeof socialPriceHistorySchema>>;

export type SocialPricesResponse = Readonly<z.infer<typeof socialPricesResponseSchema>>;

/** The finest tier whose span splits `windowMs` into at most `PRICE_MAX_POINTS` buckets. */
export function priceTierFor(windowMs: number): PriceTier {
  if (Math.ceil(windowMs / PRICE_TIER_SPAN_MS["5m"]) <= PRICE_MAX_POINTS) return "5m";
  if (Math.ceil(windowMs / PRICE_TIER_SPAN_MS["1h"]) <= PRICE_MAX_POINTS) return "1h";
  return "1d";
}

/**
 * The spacing of the buckets a series keeps: the tier's span, or a whole
 * multiple of it so the window holds at most `points` of them. Buckets are
 * epoch-aligned, so `bucket_ms % step = 0` keeps evenly spaced ones.
 */
export function priceStepFor(windowMs: number, tier: PriceTier, points: number): number {
  const span = PRICE_TIER_SPAN_MS[tier];
  return span * Math.max(1, Math.ceil(windowMs / span / Math.max(1, points)));
}

/** The path a page of prices is read from. */
export function socialPricesPath(
  query: Readonly<{
    presales?: readonly string[];
    coins?: readonly string[];
    window?: PriceWindow;
    points?: number;
    interval?: PriceTier;
  }>,
): string {
  const params = new URLSearchParams();
  for (const id of query.presales ?? []) params.append("presale", id);
  for (const coin of query.coins ?? []) params.append("coin", coin);
  if (query.window !== undefined && query.window !== "24h") params.set("window", query.window);
  if (query.points !== undefined && query.points !== PRICE_DEFAULT_POINTS)
    params.set("points", String(query.points));
  if (query.interval !== undefined) params.set("interval", query.interval);
  return `${SOCIAL_PRICES_PATH}?${params.toString()}`;
}

// Scoped metadata retains this document's definitions and descriptions during generation.
export const pricesSchemaMetadata = z.registry<z.core.JSONSchemaMeta>();
const pricesMillisSchema = z
  .number()
  .nonnegative()
  .refine(Number.isInteger)
  .register(pricesSchemaMetadata, { type: "integer" });

export const pricesPriceSchema = z
  .string()
  .regex(/^(0|[1-9][0-9]*)(\.[0-9]*[1-9])?$/)
  .register(pricesSchemaMetadata, {
    description: "USD per whole token, exact, trailing zeros trimmed.",
    id: "price",
  });

export const pricesHistorySchema = z
  .strictObject({
    presale_id: z
      .string()
      .regex(SUI_OBJECT_ID_PATTERN)
      .nullable(),
    coin_type: z
      .string()
      .refine((value) => [...value].length >= 1)
      .register(pricesSchemaMetadata, { minLength: 1 }),
    tier: z.enum(PRICE_TIERS),
    from_ms: pricesMillisSchema,
    points: z
      .array(z.tuple([pricesMillisSchema, pricesPriceSchema]).readonly())
      .max(292)
      .readonly()
      .register(pricesSchemaMetadata, {
        description:
          "Oldest first: [the price's own time in ms, its USD price]. Empty when the window has no line.",
      }),
    price_usd: z.union([pricesPriceSchema, z.null()]),
    price_24h_usd: z.union([pricesPriceSchema, z.null()]),
    change_24h_bps: z
      .number()
      .refine(Number.isInteger)
      .register(pricesSchemaMetadata, { type: "integer" })
      .nullable(),
    day_open_usd: z.union([pricesPriceSchema, z.null()]),
    day_open_ms: z.union([pricesMillisSchema, z.null()]),
    quote: z
      .strictObject({
        coin_type: z
          .string()
          .refine((value) => [...value].length >= 1)
          .register(pricesSchemaMetadata, { minLength: 1 }),
        symbol: z
          .string()
          .refine((value) => [...value].length >= 1)
          .register(pricesSchemaMetadata, { minLength: 1 }),
        price: z.string().regex(/^(0|[1-9][0-9]*)(\.[0-9]*[1-9])?$/),
        as_of_ms: pricesMillisSchema,
        points: z
          .array(z.tuple([pricesMillisSchema, pricesPriceSchema]).readonly())
          .max(292)
          .readonly()
          .register(pricesSchemaMetadata, {
            description:
              "Real indexed pool observations: timestamp and quote coins per whole sale token. No USD conversion or synthetic endpoint.",
          }),
        change_24h_bps: z
          .number()
          .refine(Number.isInteger)
          .register(pricesSchemaMetadata, { type: "integer" })
          .nullable(),
      })
      .register(pricesSchemaMetadata, {
        description:
          "Available pool price/history in the sale quote when a genuine USD conversion is unavailable. USD fields retain their own units; unavailable values remain null.",
      })
      .optional(),
  })
  .register(pricesSchemaMetadata, { id: "history" });

export const socialPublishedPricesResponseSchema = z
  .strictObject({
    window: z.enum(PRICE_WINDOWS),
    clock_ms: pricesMillisSchema.clone().register(pricesSchemaMetadata, {
      description:
        "The chain clock every window ends at: the earlier of the watermark and the server's clock.",
    }),
    prices: z.array(pricesHistorySchema).max(54).readonly(),
    as_of: socialAsOfSchema,
  })
  .register(pricesSchemaMetadata, {
    title: "Coins' prices over time",
    description:
      "GET /api/social/prices 200 (Cache-Control: public, s-maxage=10, stale-while-revalidate=20): for each sale or coin asked that has a price, its USD prices over the window from chain_read_v1.price_history, the price now from chain_read_v1.prices, the price 24 hours ago, the move between them and the price at the day's open (00:00 UTC), bounded by the watermark (contracts/prices.ts). The same for every caller; no viewer field.",
  });

export const pricesSchemaReferences = new Map<z.core.$ZodType, string>([
  [socialAsOfSchema, "https://blast-v2.invalid/social/contracts/as-of.schema.json"],
  [
    pricesMillisSchema,
    "https://blast-v2.invalid/social/contracts/feed-item.schema.json#/$defs/millis",
  ],
]);

// Observation time is first-party data; the published partner response deliberately omits it.
export const socialPriceHistorySchema = pricesHistorySchema.extend({
  price_as_of_ms: pricesMillisSchema.optional(),
});

export const socialPricesResponseSchema = socialPublishedPricesResponseSchema.extend({
  prices: z
    .array(socialPriceHistorySchema)
    .max(PRICE_MAX_PRESALES + PRICE_MAX_COINS)
    .readonly(),
});
