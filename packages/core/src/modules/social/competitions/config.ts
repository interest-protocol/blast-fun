import { normalizeStructTag } from "@mysten/sui/utils";
import { z } from "zod";

export const competitionSlug = z.string().regex(/^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/);
const coinType = z
  .string()
  .min(8)
  .max(512)
  .transform((value, ctx) => {
    try {
      return normalizeStructTag(value);
    } catch {
      ctx.addIssue({ code: "custom", message: "Expected a Sui coin type" });
      return z.NEVER;
    }
  })
  .pipe(z.string().max(512));
const coinSymbol = z.string().trim().min(1).max(20);
/** Whole coins as a plain decimal: positive, below 10^20, at most nine places (migration 0141's bounds). */
const prizeAmount = z
  .string()
  .regex(/^(0|[1-9][0-9]{0,19})(\.[0-9]{1,9})?$/, "Expected whole coins as a plain decimal, at most nine places")
  .refine((value) => /[1-9]/.test(value), "Expected a positive amount");

export const competitionInput = z
  .strictObject({
    slug: competitionSlug,
    name: z.string().trim().min(1).max(100),
    coin_type: coinType,
    coin_symbol: coinSymbol,
    feature_on_swap: z.boolean().default(false),
    coin_icon_url: z
      .url()
      .max(2048)
      .refine((value) => {
        const url = new URL(value);
        return url.protocol === "https:" && !url.username && !url.password;
      }, "Expected an HTTPS coin icon URL")
      .nullable()
      .default(null),
    prize_description: z.string().trim().min(1).max(240).nullable().default(null),
    /** The "Prize pool" figure ("25,000 WAL"): whole coins of `prize_coin_type`, shown as `prize_coin_symbol`. */
    prize_amount: prizeAmount.nullable().default(null),
    prize_coin_type: coinType.nullable().default(null),
    prize_coin_symbol: coinSymbol.nullable().default(null),
    rules_url: z
      .url()
      .max(2048)
      .refine((value) => {
        const url = new URL(value);
        return (
          url.protocol === "https:" &&
          ["x.com", "www.x.com", "twitter.com", "www.twitter.com"].includes(url.hostname) &&
          !url.username &&
          !url.password
        );
      }, "Expected an HTTPS X or Twitter rules link")
      .nullable()
      .default(null),
    starts_at_ms: z.number().int().positive().max(8_640_000_000_000_000),
    ends_at_ms: z.number().int().positive().max(8_640_000_000_000_000),
  })
  .refine((value) => (!value.prize_description && value.prize_amount === null) || value.rules_url !== null, {
    message: "Prize details require an organizer rules link",
  })
  .refine((value) => [value.prize_amount, value.prize_coin_type, value.prize_coin_symbol].every((field) => (field === null) === (value.prize_amount === null)), {
    message: "A prize amount needs its coin type and symbol, and they need it",
  })
  .refine((value) => value.ends_at_ms > value.starts_at_ms, {
    message: "End must follow start",
  });

export type CompetitionInput = z.output<typeof competitionInput>;
