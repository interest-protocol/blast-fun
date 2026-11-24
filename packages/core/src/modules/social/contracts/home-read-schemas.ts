import { z } from "zod";
import {
  homeAmountSchema,
  homeSideSchema,
  homeEventSchema,
  homeParticipantSchema,
  homeActivitySchema,
  homeCoinSchema,
  homeCoinsPageSchema,
  homeCoinsByIdsSchema,
  homeThreadPageSchema,
  homeTraderCoinSchema,
  homeTraderSchema,
  homeTradersPageSchema,
  homeFollowingResponseSchema,
  homeTapeEventSchema,
  homeActivityStreamEventSchema,
  homeActivityStreamPageSchema,
  homeCoinMarketReadModelSchema,
  homeMarketWindowSchema,
  socialHappeningResponseSchema,
  happeningTapeEventSchema,
} from "./home-schemas.ts";

// Indexed coin metadata uses a u8 decimal count. Published Home documents retain
// their older 18/38 bounds; the first-party reader must accept all indexed coins.
const decimals = z.number().int().min(0).max(255);
const amount = homeAmountSchema.extend({ quote_decimals: decimals.nullable() });
const side = z.xor([
  z.null(),
  homeSideSchema.options[1].extend({ amounts: z.array(amount) }),
]);
const event = homeEventSchema.extend({ quote: z.xor([z.null(), amount]) });
const participant = homeParticipantSchema.extend({
  buys: side,
  sells: side,
  commits: side,
  claims: side,
  events: z.array(event).max(10).optional(),
});
// homeSpan subtracts a window from the chain clock, including near genesis.
const activity = homeActivitySchema.extend({
  from_ms: z.number().int(),
  bought: z.array(amount),
  sold: z.array(amount),
  committed: z.array(amount),
  preview: z.array(participant).max(3),
});
const coin = homeCoinSchema.extend({
  decimals,
  quote: homeCoinSchema.shape.quote.extend({ decimals }),
  activity,
});
export const homeCoinsPageReadSchema = homeCoinsPageSchema.extend({
  coins: z.array(coin).max(50),
});
export const homeCoinsByIdsReadSchema = homeCoinsByIdsSchema.extend({
  coins: z.array(coin).max(50),
  pool_volumes: z
    .record(z.string(), z.xor([z.null(), z.array(amount)]))
    .optional(),
});
export const homeThreadPageReadSchema = homeThreadPageSchema.extend({
  participants: z.array(participant).max(20),
  totals: activity.omit({ preview: true }),
});
export const homeTradersPageReadSchema = homeTradersPageSchema.extend({
  traders: z
    .array(
      homeTraderSchema.extend({
        buys: side,
        sells: side,
        commits: side,
        claims: side,
        events: z.array(event).max(10).optional(),
        coins: z
          .array(
            homeTraderCoinSchema.extend({
              decimals,
              buys: side,
              sells: side,
              commits: side,
              claims: side,
            }),
          )
          .max(12),
      }),
    )
    .max(50),
});
export const homeFollowingReadSchema = z.discriminatedUnion("mode", [
  homeFollowingResponseSchema.options[0].extend({
    coins: z.array(coin).max(50),
  }),
  homeFollowingResponseSchema.options[1].extend({
    previews: z.record(z.string(), activity),
  }),
  homeFollowingResponseSchema.options[2].extend({
    participants: homeThreadPageReadSchema.shape.participants,
    totals: homeThreadPageReadSchema.shape.totals,
  }),
  homeFollowingResponseSchema.options[3].extend({
    events: z
      .array(homeTapeEventSchema.extend({ quote: z.xor([z.null(), amount]) }))
      .max(12),
  }),
]);
export const homeActivityStreamReadSchema = homeActivityStreamPageSchema.extend(
  {
    events: z
      .array(
        homeActivityStreamEventSchema.extend({
          quote: z.xor([z.null(), amount]),
          coin: homeActivityStreamEventSchema.shape.coin.extend({ decimals }),
        }),
      )
      .max(50),
  },
);
const marketWindow = homeMarketWindowSchema.extend({
  from_ms: z.number().int(),
});
export const homeMarketReadSchema = homeCoinMarketReadModelSchema.extend({
  windows: z.strictObject({
    "5m": marketWindow,
    "1h": marketWindow,
    "4h": marketWindow,
    "24h": marketWindow,
  }),
});

// wholeUnits preserves every fractional atom of an indexed u8-decimal asset.
const wholeUnits = z
  .string()
  .regex(/^(0|[1-9][0-9]*)(\.[0-9]{1,255})?$/)
  .nullable();
export const happeningReadSchema = socialHappeningResponseSchema.extend({
  tape: z
    .array(
      happeningTapeEventSchema.extend({
        tokens: wholeUnits,
        refund: wholeUnits,
      }),
    )
    .max(8),
});
