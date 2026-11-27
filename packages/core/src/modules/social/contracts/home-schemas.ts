import { z } from "zod";

import {
  feedItemDefinitions,
  socialAsOfSchema,
  socialFeedItemSchema,
} from "./items.ts";
import {
  portfolioBasisUsdSchema,
  portfolioBasisCompleteSchema,
  portfolioPnlUsdSchema,
  portfolioPnlMultipleSchema,
} from "./portfolio.ts";
import { socialSaleMetadataSchema } from "./sales.ts";
import { EVENT_CURSOR } from "../../launchpad-contract/cursor.ts";
import { COIN_TYPE, SUI_OBJECT_ID_PATTERN } from "@blast/core/lib/sui/ids.ts";

const homeIntegerSchema = z
  .number()
  .refine(Number.isInteger)
  .meta({ type: "integer" });

/** Preserve readonly read models without freezing parsed JSON or changing wire output. */
export type HomeWire<T> = T extends object
  ? { readonly [K in keyof T]: HomeWire<T[K]> }
  : T;

export const homeAmountSchema = z.strictObject({
  quote_type: z.string().min(1),
  quote_symbol: z.xor([z.null(), z.string().min(1)]),
  quote_decimals: z.xor([z.null(), homeIntegerSchema.min(0).max(18)]),
  atoms: z
    .string()
    .regex(/^(0|[1-9][0-9]*)$/)
    .describe("Atoms as a decimal string, exact."),
  usd: z.xor([z.null(), z.string().regex(/^-?(0|[1-9][0-9]*)\.[0-9]{2}$/)]),
  usd_complete: z.boolean(),
});

export const homeSideSchema = z.xor([
  z.null(),
  z.strictObject({
    count: homeIntegerSchema.min(1),
    amounts: z.array(homeAmountSchema),
    tokens: z.xor([
      z.null(),
      z
        .string()
        .regex(/^(0|[1-9][0-9]*)$/)
        .describe("Atoms as a decimal string, exact."),
    ]),
    latest_ms: feedItemDefinitions.millis,
  }),
]);

export const homeEventSchema = z.strictObject({
  activity_id: z.string().regex(/^[0-9]+:[0-9]+:[0-9]+:[0-9]+$/),
  entry_id: z.string().regex(/^a:[0-9]+:[0-9]+:[0-9]+:[0-9]+$/),
  kind: z.enum(["trade_buy", "trade_sell", "presale_commit", "presale_claim"]),
  occurred_at_ms: feedItemDefinitions.millis,
  digest: z.xor([z.null(), z.string().min(1)]),
  quote: z.xor([z.null(), homeAmountSchema]),
  tokens: z.xor([
    z.null(),
    z
      .string()
      .regex(/^(0|[1-9][0-9]*)$/)
      .describe("Atoms as a decimal string, exact."),
  ]),
  refund: z.xor([
    z.null(),
    z
      .string()
      .regex(/^(0|[1-9][0-9]*)$/)
      .describe("Atoms as a decimal string, exact."),
  ]),
  has_why: z.boolean(),
});

export const homeParticipantSchema = z.strictObject({
  key: z.string().regex(/^(c:[a-z0-9_]{3,20}|w:0x[0-9a-f]{64})$/),
  actor: z.xor([
    feedItemDefinitions.accountActor,
    feedItemDefinitions.addressActor,
  ]),
  followers: z.xor([z.null(), homeIntegerSchema.min(0)]),
  buys: homeSideSchema,
  sells: homeSideSchema,
  commits: homeSideSchema,
  claims: homeSideSchema,
  latest_ms: feedItemDefinitions.millis,
  latest_kind: z.enum([
    "trade_buy",
    "trade_sell",
    "presale_commit",
    "presale_claim",
  ]),
  events_total: homeIntegerSchema.min(1),
  events: z.array(homeEventSchema).max(10).optional(),
  events_more: z.boolean().optional(),
  relation: z.enum(["followed"]).optional(),
});

export const homeActivitySchema = z.strictObject({
  scope: z.enum(["pool", "followed"]),
  window: z.enum(["1h", "24h"]),
  from_ms: feedItemDefinitions.millis,
  to_ms: feedItemDefinitions.millis,
  participants: homeIntegerSchema.min(0),
  events: homeIntegerSchema.min(0),
  buyers: homeIntegerSchema.min(0),
  sellers: homeIntegerSchema.min(0),
  backers: homeIntegerSchema.min(0),
  claimers: homeIntegerSchema.min(0),
  bought: z.array(homeAmountSchema),
  sold: z.array(homeAmountSchema),
  committed: z.array(homeAmountSchema),
  latest_ms: z.xor([z.null(), feedItemDefinitions.millis]),
  preview: z.array(homeParticipantSchema).max(3),
});

export const homeTotalsSchema = homeActivitySchema.omit({ preview: true });

export const homeHolderSchema = z.strictObject({
  actor: z.xor([
    feedItemDefinitions.accountActor,
    feedItemDefinitions.addressActor,
  ]),
  balance: z.string().regex(/^[0-9]+$/),
  share_bps: homeIntegerSchema.min(0).max(10000).nullable(),
});

const homeDexVolumeAmountSchema = z.strictObject({
  usd: z.string().regex(/^(0|[1-9][0-9]*)(\.[0-9]+)?$/).nullable(),
  usd_complete: z.boolean(),
});

const homeDexVolumeSchema = homeDexVolumeAmountSchema.extend({
  venues: z.strictObject({ cetus: homeDexVolumeAmountSchema, bluefin: homeDexVolumeAmountSchema }),
});

export const homeCoinSchema = z.strictObject({
  presale_id: z
    .string()
    .regex(SUI_OBJECT_ID_PATTERN)
    .nullable(),
  coin_type: z.string().min(1),
  symbol: z.string().min(1),
  name: z.string().min(1),
  icon_url: z.xor([z.null(), z.string().min(1)]),
  verified_team: z
      .boolean()
      .describe(
        "R3-23: Blast checked who is behind the coin (social_sale_trust for a sale, social_coin_trust for a bonding-curve coin); sent only when true.",
      )
      .optional(),
  decimals: homeIntegerSchema.min(0).max(18),
  lifecycle: z.string().min(1),
  venue: z.string(),
  tradable: z.boolean(),
  opened_ms: z.xor([z.null(), feedItemDefinitions.millis]),
  launched_ms: z.xor([z.null(), feedItemDefinitions.millis]),
  launch_id: z
    .string()
    .regex(SUI_OBJECT_ID_PATTERN)
    .nullable()
    .describe("A curve coin's launch, the key of its coin page; null for a sale's coin."),
  curve: z
    .strictObject({
      lifecycle: z.enum(["opening_round", "live", "migration_ready", "migrated"]),
      progress_bps: homeIntegerSchema.min(0).max(10000).nullable(),
      quote_remaining: z.string().regex(/^(0|[1-9][0-9]*)$/).nullable(),
    })
    .nullable()
    .optional()
    .describe("A Blast bonding curve coin's curve: its lifecycle, its progress toward graduation in basis points (10000 once ready to migrate or migrated), and the quote atoms left to its target; progress and remaining are null while the target is unknown. Null for any other coin. Present only when the read asks for it (`curve=1`)."),
  graduated_ms: z
    .xor([z.null(), feedItemDefinitions.millis])
    .optional()
    .describe("When a curve coin graduated: its first DEX pool's creation. Null for a curve still filling and for any other coin. Present only with `curve=1`."),
  quote: z.strictObject({
    type: z.string().min(1),
    symbol: z.string().min(1),
    decimals: homeIntegerSchema.min(0).max(18),
  }),
  price_usd: z.xor([
    z.null(),
    z.string().regex(/^(0|[1-9][0-9]*)(\.[0-9]+)?$/),
  ]),
  price_as_of_ms: z.xor([z.null(), feedItemDefinitions.millis]),
  change_24h_bps: z.xor([z.null(), homeIntegerSchema]),
  change_24h_from_ms: feedItemDefinitions.millis.describe("First priced observation when the comparison covers less than 24 hours.").optional(),
  live_inputs: z.strictObject({
    price_checkpoint: homeIntegerSchema.min(0).optional(),
    total_supply: z.string().regex(/^\d+$/).nullable(),
    circulating_supply: z.string().regex(/^\d+$/).nullable(),
    open_1h_usd: z.string().regex(/^\d+(?:\.\d+)?$/).nullable(),
    open_24h_usd: z.string().regex(/^\d+(?:\.\d+)?$/).nullable(),
    baselines_until_ms: feedItemDefinitions.millis,
    open_24h_until_ms: feedItemDefinitions.millis.optional(),
  }).optional(),
  mobile_market: z.strictObject({
    market_cap_usd: z.string().regex(/^(0|[1-9][0-9]*)\.[0-9]{2}$/).nullable(),
    change_1h_bps: homeIntegerSchema.nullable(),
  }).optional(),
  spark: z
    .array(
      z.tuple([
        feedItemDefinitions.millis,
        z.string().regex(/^(0|[1-9][0-9]*)(\.[0-9]+)?$/),
      ]),
    )
    .max(292)
    .describe(
      "The 24 h USD price line a sparkline draws, oldest first: [the price's own time in ms, its USD price]. Empty without two points; a presale has none.",
    ),
  holders: z.xor([z.null(), homeIntegerSchema.min(0)]),
  holders_as_of_ms: z.xor([z.null(), feedItemDefinitions.millis]),
  fdv_usd: z.xor([z.null(), z.string().regex(/^-?(0|[1-9][0-9]*)\.[0-9]{2}$/)]),
  activity: homeActivitySchema,
  dex_volume: homeDexVolumeSchema
    .describe("Gross Cetus and Bluefin swap volume in the activity window. For each total, usd_complete requires full coverage and prices for all swaps. Otherwise a USD sum is a lower bound and null means unknown.")
    .optional(),
  discussion: z.strictObject({
    posts: homeIntegerSchema.min(0),
  }),
  rank: z.strictObject({
    score: homeIntegerSchema.min(0),
    why: z.string().min(1),
  }),
  qualified: z.enum(["activity", "discussion"]).optional(),
  sale: z
    .strictObject({
      start_ms: homeIntegerSchema.min(0),
      end_ms: homeIntegerSchema.min(0),
      raise_target: z.string().regex(/^(0|[1-9][0-9]*)$/),
      raised: z.string().regex(/^(0|[1-9][0-9]*)$/),
      participants: homeIntegerSchema.min(0),
      savers: homeIntegerSchema
        .min(0)
        .optional()
        .describe("Accounts with a verified X link that have the sale saved now. Present only on a Discover read that asks for presales (`presales=1`)."),
    })
    .nullable(),
  top_holders: z.strictObject({
    holders: z.array(homeHolderSchema).max(100),
    share_bps: homeIntegerSchema.min(0).max(10000).nullable(),
  }),
});

/** Older documents retain this unused definition; live coins include market spark and holders. */
export const homePublishedCoinSchema = homeCoinSchema
  .omit({ spark: true, top_holders: true, launch_id: true, live_inputs: true, dex_volume: true })
  .extend({
    presale_id: homeCoinSchema.shape.presale_id.unwrap(),
    sale: homeCoinSchema.shape.sale.unwrap(),
  });

/** The published Following contract names every listed coin (a presale's or one without, as Discover does) and caps its holder preview at ten. */
export const homeFollowingCoinSchema = homeCoinSchema.extend({
  top_holders: homeCoinSchema.shape.top_holders.extend({
    holders: z.array(homeHolderSchema).max(10),
  }),
});

export const homeFollowingTapeEventSchema = homeEventSchema.extend({
  actor: feedItemDefinitions.accountActor,
  coin: z.strictObject({
    presale_id: z
      .xor([z.null(), z.string().regex(SUI_OBJECT_ID_PATTERN)])
      .describe("The coin's presale, or null for a coin launched without one (a launch vault coin, a live curve or a tracked pool)."),
    coin_type: z.string().min(1),
    symbol: z.string().min(1),
    name: z.string(),
    icon_url: z.xor([z.null(), z.string()]),
    verified_team: z
        .boolean()
        .describe(
          "R3-23: Blast checked who is behind the coin (social_sale_trust for a sale, social_coin_trust for a coin without one); sent only when true.",
        )
        .optional(),
    lifecycle: z.string().min(1),
  }),
  market_cap_usd: z
    .xor([z.null(), z.string().regex(/^(0|[1-9][0-9]*)\.[0-9]{2}$/)])
    .describe("A trade's coin market cap in USD right after it, to the cent; null for a commit, a claim or an unknown cap."),
});

export const homeTraderCoinSchema = z.strictObject({
  presale_id: z.string().regex(SUI_OBJECT_ID_PATTERN),
  symbol: z.string().min(1),
  icon_url: z.string().nullable(),
  decimals: homeIntegerSchema.min(0).max(38),
  buys: homeSideSchema,
  sells: homeSideSchema,
  commits: homeSideSchema,
  claims: homeSideSchema,
  latest_ms: feedItemDefinitions.millis,
});

export const homeMarketWindowSchema = z.strictObject({
  from_ms: homeIntegerSchema.min(0),
  to_ms: homeIntegerSchema.min(0),
  open_usd: z.xor([z.null(), z.string().regex(/^(0|[1-9][0-9]*)(\.[0-9]+)?$/)]),
  open_as_of_ms: homeIntegerSchema.min(0).nullable(),
  change_bps: homeIntegerSchema.nullable(),
  change_usd: z.xor([
    z.null(),
    z.string().regex(/^-?(0|[1-9][0-9]*)(\.[0-9]*[1-9])?$/),
  ]),
  buys: homeIntegerSchema.min(0),
  sells: homeIntegerSchema.min(0),
  bought_atoms: z.string().regex(/^(0|[1-9][0-9]*)$/),
  sold_atoms: z.string().regex(/^(0|[1-9][0-9]*)$/),
  bought_usd: z.xor([
    z.null(),
    z.string().regex(/^(0|[1-9][0-9]*)\.[0-9]{2}$/),
  ]),
  sold_usd: z.xor([z.null(), z.string().regex(/^(0|[1-9][0-9]*)\.[0-9]{2}$/)]),
  unpriced_buys: homeIntegerSchema.min(0),
  unpriced_sells: homeIntegerSchema.min(0),
  buyers: homeIntegerSchema.min(0),
  sellers: homeIntegerSchema.min(0),
});

export const homePositionHolderSchema = z.strictObject({
  actor: z.xor([
    feedItemDefinitions.accountActor,
    feedItemDefinitions.addressActor,
  ]),
  balance: z.string().regex(/^(0|[1-9][0-9]*)$/),
  share_bps: homeIntegerSchema.min(0).max(10000).nullable(),
  value_usd: z.xor([z.null(), z.string().regex(/^(0|[1-9][0-9]*)\.[0-9]{2}$/)]),
  average_entry_usd: z.xor([
    z.null(),
    z.string().regex(/^(0|[1-9][0-9]*)(\.[0-9]+)?$/),
  ]),
  why: z
    .xor([z.null(), z.string().min(1).max(2000)])
    .describe(
      "A named holder's latest active why on its own post about the coin; null without one or for an unnamed wallet.",
    ),
  basis_usd: portfolioBasisUsdSchema,
  basis_complete: portfolioBasisCompleteSchema,
  pnl_usd: portfolioPnlUsdSchema,
  pnl_multiple: portfolioPnlMultipleSchema,
});

export const homeChartTradeSchema = z.strictObject({
  entry_id: z
    .string()
    .regex(/^a:[0-9]{1,18}:[0-9]{1,10}:[0-9]{1,10}:[0-9]{1,10}$/),
  digest: z.string().min(1),
  timestamp_ms: homeIntegerSchema.min(0),
  side: z.enum(["buy", "sell"]),
  coin_atoms: z.string().regex(/^(0|[1-9][0-9]*)$/),
  quote_atoms: z.string().regex(/^(0|[1-9][0-9]*)$/),
  usd: z.xor([z.null(), z.string().regex(/^(0|[1-9][0-9]*)\.[0-9]{2}$/)]),
  actor: z.xor([
    feedItemDefinitions.accountActor,
    feedItemDefinitions.addressActor,
  ]),
});

export const happeningPresaleSchema = z.strictObject({
  presale: feedItemDefinitions.presale,
  interested: homeIntegerSchema
    .min(0)
    .describe("Accounts following the presale."),
  window_raised: feedItemDefinitions.atoms.describe(
    "Quote atoms committed in the velocity window before clock_ms.",
  ),
  launched_ms: z
    .xor([z.null(), feedItemDefinitions.millis])
    .describe("When the presale migrated, or null."),
  cover: socialSaleMetadataSchema.shape.cover
    .describe(
      "Public creator cover for admin pins; optional for older responses.",
    )
    .optional(),
});

export const happeningTapeEventSchema = z.strictObject({
  activity_id: z.string().regex(/^[0-9]+:[0-9]+:[0-9]+:[0-9]+$/),
  kind: z.enum(["presale_commit", "presale_claim", "trade_buy", "trade_sell"]),
  occurred_at_ms: feedItemDefinitions.millis,
  actor: z
    .xor([feedItemDefinitions.accountActor, feedItemDefinitions.addressActor])
    .describe("Named by the naming rule at the event, else the wallet only."),
  presale_id: z.xor([z.null(), z.string().regex(SUI_OBJECT_ID_PATTERN)]),
  symbol: z.string(),
  usd: z.xor([z.null(), feedItemDefinitions.usd]),
  tokens: z
    .xor([
      z.null(),
      z
        .string()
        .regex(/^(0|[1-9][0-9]*)(\.[0-9]{1,18})?$/)
        .describe("A non-negative plain decimal."),
    ])
    .describe("A claim's sale tokens in whole tokens."),
  refund: z
    .xor([
      z.null(),
      z
        .string()
        .regex(/^(0|[1-9][0-9]*)(\.[0-9]{1,18})?$/)
        .describe("A non-negative plain decimal."),
    ])
    .describe("A claim's refund in whole Quote units."),
  quote_symbol: z
    .xor([z.null(), z.string().min(1)])
    .describe(
      "R3-40: the sale's quote symbol, so a SUI sale's refund reads in SUI; null for a row of no sale.",
    ),
});

export const happeningTopCoinSchema = z.strictObject({
  coin_type: z.string(),
  presale_id: z.xor([z.null(), z.string().regex(SUI_OBJECT_ID_PATTERN)]),
  name: z.string(),
  symbol: z.string(),
  icon_url: z.xor([z.null(), z.string()]),
  verified_team: z
      .boolean()
      .describe(
        "R3-23: Blast checked who is behind the sale (social_sale_trust); sent only when true.",
      )
      .optional(),
  price_usd: z.string().regex(/^(0|[1-9][0-9]*)(\.[0-9]+)?$/),
  change_24h_bps: z.xor([z.null(), homeIntegerSchema]),
  buyers_24h: z.xor([z.null(), homeIntegerSchema.min(0)]),
  holders: z.xor([z.null(), homeIntegerSchema.min(0)]),
});

export const homeTraderSchema = homeParticipantSchema.extend({
  events_total: homeIntegerSchema.min(0),
  coins: z.array(homeTraderCoinSchema).max(12),
  coins_total: homeIntegerSchema.min(0),
  portfolio: z.strictObject({
    public: z.boolean(),
    value_usd: z
      .string()
      .regex(/^[0-9]+\.[0-9]{2}$/)
      .nullable(),
    pnl_usd: z
      .string()
      .regex(/^-?[0-9]+\.[0-9]{2}$/)
      .nullable(),
  }),
  holdings_public: z.boolean().optional(),
  performance_public: z.boolean().optional(),
  holdings_total: homeIntegerSchema.min(0).optional(),
  rank: homeIntegerSchema.min(1).nullable().optional(),
  holdings: z
    .array(
      z
        .strictObject({
          presale_id: z.string().nullable(),
          symbol: z.string(),
          icon_url: z.string().nullable(),
          decimals: homeIntegerSchema,
          balance: z.string(),
          value_usd: z.string().nullable(),
          share_bps: homeIntegerSchema.min(0).max(10000).nullable(),
          pnl_usd: z.string().nullable(),
          verified_team: z
              .boolean()
              .describe(
                "R3-23: Blast checked who is behind the coin (social_sale_trust for a sale, social_coin_trust for a bonding-curve coin); sent only when true.",
              )
              .optional(),
          launch_id: z
            .string()
            .regex(SUI_OBJECT_ID_PATTERN)
            .optional(),
          coin_type: z
            .string()
            .min(1)
            .describe(
              "Canonical launch coin type; optional for older cached responses.",
            )
            .optional(),
        })
        .refine(
          (holding) =>
            holding.presale_id !== null || holding.launch_id !== undefined,
        )
        .meta({
          anyOf: [
            { properties: { presale_id: { type: "string" } } },
            {
              required: ["launch_id"],
              properties: { launch_id: { type: "string" } },
            },
          ],
        }),
    )
    .max(10)
    .optional(),
});

export const homeCoinsPageContractSchema = z
  .strictObject({
    coins: z.array(homeCoinSchema).max(50),
    missing: z.array(z.union([z.string().regex(SUI_OBJECT_ID_PATTERN), z.string().regex(COIN_TYPE)])).optional(),
    next_cursor: z.xor([z.null(), z.string().min(1).max(600)]).optional(),
    window: z.enum(["1h", "24h"]),
    clock_ms: feedItemDefinitions.millis,
    as_of: socialAsOfSchema,
    page: homeIntegerSchema.min(1).optional(),
    pages: homeIntegerSchema.min(1).optional(),
    total: homeIntegerSchema.min(0).optional(),
    ranked: homeIntegerSchema
      .min(0)
      .optional()
      .describe("Discover, only when the request has `ranked=1`: how many of `total` have data on the sort's keys (Trending: window volume, breadth, activity or recency). They lead the order, so the rest start at this position."),
    pool_volumes: z
      .record(z.string(), z.xor([z.null(), z.array(homeAmountSchema)]))
      .optional(),
  })
  .describe(
    "GET /api/social/home and GET /api/social/home/coins 200 (public, s-maxage=10): one page of coin items with their window's participation grouped by identity, bounded by the watermark. The same for every caller; no viewer field.",
  )
  .meta({
    $id: "https://blast-v2.invalid/social/contracts/home-coins-page.schema.json",
    title: "Home coins",
  });

export const homeThreadPageSchema = z
  .strictObject({
    presale_id: z.string().regex(SUI_OBJECT_ID_PATTERN).nullable(),
    coin_type: z
      .string()
      .min(1)
      .nullable()
      .describe("The curve coin the thread is under when it was asked by `coin`; null when asked by `presale`."),
    participants: z.array(homeParticipantSchema).max(20),
    totals: homeTotalsSchema,
    next_cursor: z.xor([z.null(), z.string().min(1).max(600)]),
    window: z.enum(["1h", "24h"]),
    clock_ms: feedItemDefinitions.millis,
    as_of: socialAsOfSchema,
  })
  .describe(
    "GET /api/social/home/activity 200 (public, s-maxage=10): one page of a coin's participants in the window, newest first, each with its totals per direction and its newest events; the whole window's totals beside them.",
  )
  .meta({
    $id: "https://blast-v2.invalid/social/contracts/home-thread-page.schema.json",
    title: "Home activity thread",
  });

export const homeFollowingRequestContractSchema = z
  .strictObject({
    mode: z.enum(["coins", "preview", "thread", "tape"]),
    window: z.enum(["1h", "24h"]),
    cursor: z.xor([z.null(), z.string().min(1).max(600)]).optional(),
    limit: homeIntegerSchema.min(1).max(30).optional(),
    presale_ids: z
      .array(z.union([z.string().regex(SUI_OBJECT_ID_PATTERN), z.string().regex(COIN_TYPE)]))
      .describe("Preview mode: each coin's key, its presale id or, for a coin without a presale, its coin type.")
      .min(1)
      .max(50)
      .optional(),
    presale_id: z
      .string()
      .regex(SUI_OBJECT_ID_PATTERN)
      .optional(),
  })
  .describe(
    "POST /api/social/me/home/following body: the viewer's Following coins, the followed participation of sales on screen, one sale's followed-only thread, or the tape of the newest followed events.",
  )
  .meta({
    $id: "https://blast-v2.invalid/social/contracts/home-following-request.schema.json",
    title: "Home following request",
  });

export const homeFollowingResponseContractSchema = z
  .strictObject({
    mode: z.enum(["coins", "preview", "thread", "tape"]),
    following: homeIntegerSchema.min(0).optional(),
    coins: z.array(homeFollowingCoinSchema).max(30).optional(),
    previews: z.record(z.string(), homeActivitySchema).optional(),
    presale_id: z
      .string()
      .regex(SUI_OBJECT_ID_PATTERN)
      .optional(),
    participants: z.array(homeParticipantSchema).max(20).optional(),
    events: z
      .array(homeFollowingTapeEventSchema)
      .max(12)
      .describe(
        "Tape mode: the newest events by followed accounts across every coin, newest first.",
      )
      .optional(),
    totals: homeTotalsSchema.optional(),
    next_cursor: z.xor([z.null(), z.string().min(1).max(600)]).optional(),
    window: z.enum(["1h", "24h"]),
    clock_ms: feedItemDefinitions.millis,
    as_of: socialAsOfSchema,
    page: homeIntegerSchema.min(1).optional(),
    pages: homeIntegerSchema.min(1).optional(),
    total: homeIntegerSchema.min(0).optional(),
  })
  .describe(
    "POST /api/social/me/home/following 200 (private, no-store): by mode, a coins page with the number of accounts followed, the previews keyed by sale, or a thread page.",
  )
  .meta({
    $id: "https://blast-v2.invalid/social/contracts/home-following-response.schema.json",
    title: "Home following response",
  });

export const homeDiscussionPageSchema = z
  .strictObject({
    presale_id: z.string().regex(SUI_OBJECT_ID_PATTERN),
    items: z.array(socialFeedItemSchema).max(50),
    total: homeIntegerSchema.min(0),
    next_cursor: z.xor([z.null(), z.string().min(1).max(600)]),
    as_of: socialAsOfSchema,
  })
  .describe(
    "GET /api/social/home/discussion 200 (public, s-maxage=10): the sale's posts that carry an authored why, newest first, as feed items.",
  )
  .meta({
    $id: "https://blast-v2.invalid/social/contracts/home-discussion-page.schema.json",
    title: "Home discussion",
  });

export const homeTradersPageSchema = z
  .strictObject({
    window: z.enum(["1h", "24h"]),
    clock_ms: feedItemDefinitions.millis,
    traders: z.array(homeTraderSchema).max(50),
    as_of: socialAsOfSchema,
    search: z.string().max(128),
    page: homeIntegerSchema.min(1),
    limit: homeIntegerSchema.min(1).max(50),
    total: homeIntegerSchema.min(0),
    global_total: homeIntegerSchema.min(0),
  })
  .describe(
    "All public accounts with complete all-time USD P&L, globally ranked before identity/wallet search and pagination. Activity only scopes row details.",
  )
  .meta({
    $id: "https://blast-v2.invalid/social/contracts/home-traders-page.schema.json",
    title: "Home traders page",
  });

export const homeActivityStreamEventSchema = homeEventSchema.extend({
  kind: z.enum(["trade_buy", "trade_sell", "presale_commit"]),
  actor: z.xor([
    feedItemDefinitions.accountActor,
    feedItemDefinitions.addressActor,
  ]),
  coin: z.strictObject({
    chain: z.literal("sui"),
    network: z.enum(["mainnet", "testnet", "devnet", "localnet"]),
    coin_type: z.string().min(1),
    presale_id: z.xor([z.null(), z.string().regex(SUI_OBJECT_ID_PATTERN)]),
    lifecycle: z.string().min(1),
    decimals: homeIntegerSchema.min(0).max(18),
    symbol: z.string().min(1),
    name: z.string().min(1),
    icon_url: z.xor([z.null(), z.string()]),
  }),
});

export const homeActivityStreamPageSchema = z
  .strictObject({
    window: z.enum(["1h", "24h"]),
    from_ms: homeIntegerSchema,
    to_ms: homeIntegerSchema.min(0),
    clock_ms: homeIntegerSchema.min(0),
    events: z.array(homeActivityStreamEventSchema).max(50),
    next_cursor: z.xor([z.null(), z.string().min(1).max(600)]),
    as_of: socialAsOfSchema,
  })
  .meta({
    $id: "https://blast-v2.invalid/social/contracts/home-activity-stream-page.schema.json",
    title: "Public indexed Activity",
  });

export const homeCoinMarketSchema = z
  .strictObject({
    coin_type: z.string().min(8).max(512),
    presale_id: z.xor([z.null(), z.string().regex(SUI_OBJECT_ID_PATTERN)]),
    decimals: homeIntegerSchema.min(0),
    quote: z.strictObject({
      type: z.string().min(8).max(512),
      symbol: z.string().min(1),
      decimals: homeIntegerSchema.min(0),
    }),
    clock_ms: homeIntegerSchema.min(0),
    price_usd: z.xor([
      z.null(),
      z.string().regex(/^(0|[1-9][0-9]*)(\.[0-9]+)?$/),
    ]),
    price_as_of_ms: homeIntegerSchema.min(0).nullable(),
    windows: z.strictObject({
      "5m": homeMarketWindowSchema,
      "1h": homeMarketWindowSchema,
      "4h": homeMarketWindowSchema,
      "24h": homeMarketWindowSchema,
    }),
    supply: z.xor([
      z.null(),
      z.strictObject({
        total: z.string().regex(/^(0|[1-9][0-9]*)$/),
        escrowed: z.string().regex(/^(0|[1-9][0-9]*)$/),
        circulating: z.string().regex(/^(0|[1-9][0-9]*)$/),
      }),
    ]),
    fdv_usd: z.xor([z.null(), z.string().regex(/^(0|[1-9][0-9]*)\.[0-9]{2}$/)]),
    market_cap_usd: z.xor([
      z.null(),
      z.string().regex(/^(0|[1-9][0-9]*)\.[0-9]{2}$/),
    ]),
    pool: z.xor([
      z.null(),
      z.strictObject({
        id: z.string().regex(SUI_OBJECT_ID_PATTERN),
        venue: z.enum(["cetus", "bluefin", "aftermath"]),
        coin_atoms: z.string().regex(/^(0|[1-9][0-9]*)$/),
        quote_atoms: z.string().regex(/^(0|[1-9][0-9]*)$/),
        as_of_ms: homeIntegerSchema.min(0),
      }),
    ]),
    liquidity_usd: z.xor([
      z.null(),
      z.string().regex(/^(0|[1-9][0-9]*)\.[0-9]{2}$/),
    ]),
    as_of: socialAsOfSchema,
  })
  .describe(
    "Redesign gaps 1, 2, 8 and 10 (contracts/coin-market.ts HomeCoinMarket): one coin's price, its move and buy/sell pressure over 5m, 1h, 4h and 24h in its Blast pool, and its FDV and market cap.",
  )
  .meta({
    $id: "https://blast-v2.invalid/social/contracts/home-coin-market.schema.json",
    title: "Home coin market",
  });

/** Indexed pool venues are open strings in the read model; the partner contract lists supported venues. */
export const homeCoinMarketReadModelSchema = homeCoinMarketSchema.extend({
  pool: z.xor([
    z.null(),
    homeCoinMarketSchema.shape.pool.options[1].extend({ venue: z.string() }),
  ]),
});

export const homeHoldersPageSchema = z
  .strictObject({
    coin_type: z.string().min(8).max(512),
    presale_id: z.xor([z.null(), z.string().regex(SUI_OBJECT_ID_PATTERN)]),
    decimals: homeIntegerSchema.min(0),
    price_usd: z.xor([
      z.null(),
      z.string().regex(/^(0|[1-9][0-9]*)(\.[0-9]+)?$/),
    ]),
    price_as_of_ms: homeIntegerSchema.min(0).nullable(),
    holders: z.array(homePositionHolderSchema).max(100),
    as_of: socialAsOfSchema,
  })
  .describe(
    "Redesign gap 3 (contracts/coin-market.ts HomeHoldersPage): the coin's largest holders with each one's cost basis by the portfolio's rule (R3-32); a named account's figures only when it shares its portfolio.",
  )
  .meta({
    $id: "https://blast-v2.invalid/social/contracts/home-holders-page.schema.json",
    title: "Home holders page",
  });

export const homeChartTradesPageSchema = z
  .strictObject({
    coin_type: z.string().min(8).max(512),
    from_ms: homeIntegerSchema.min(0),
    to_ms: homeIntegerSchema.min(0),
    min_usd: homeIntegerSchema.min(1000).nullable(),
    trades: z.array(homeChartTradeSchema).max(200),
    truncated: z.boolean(),
    as_of: socialAsOfSchema,
  })
  .describe(
    "Redesign gap 7 (contracts/coin-market.ts HomeChartTradesPage): the chart's big trades (GET /api/social/home/trades) or the viewer's own (GET /api/social/me/home/trades), newest first.",
  )
  .meta({
    $id: "https://blast-v2.invalid/social/contracts/home-chart-trades-page.schema.json",
    title: "Home chart trades page",
  });

export const socialHappeningResponseSchema = z
  .strictObject({
    clock_ms: feedItemDefinitions.millis.describe(
      "The chain clock the windows end at: the earlier of the presale pipeline's committed time and the server's clock.",
    ),
    last_hour: z.strictObject({
      wallets: homeIntegerSchema.min(0),
      usd: feedItemDefinitions.usd,
      usd_complete: z
        .boolean()
        .describe(
          "False when any commitment in the window lacks a USD value; usd is then only the priced portion.",
        )
        .optional(),
    }),
    tape: z.array(happeningTapeEventSchema).max(8),
    fastest: z.array(happeningPresaleSchema).max(5),
    opening_soon: z.array(happeningPresaleSchema).max(5),
    recent_presales: z
      .array(z.strictObject({
        presale: feedItemDefinitions.presale,
        last_commit_ms: feedItemDefinitions.millis,
        backers_1h: homeIntegerSchema.min(1).optional(),
        committed_1h: z.string().regex(/^[0-9]+$/).optional(),
      }))
      .max(10)
      .describe("Open presales with a confirmed commit in the last hour, newest commit first.")
      .optional(),
    active_curves: z.array(z.strictObject({
      coin_type: z.string().min(1),
      name: z.string().min(1),
      symbol: z.string().min(1),
      icon_url: z.string().nullable(),
      verified_team: z.boolean(),
      created_ms: feedItemDefinitions.millis,
      last_action_ms: feedItemDefinitions.millis,
      participants: homeIntegerSchema.min(1),
      volume_usd: z.string().regex(/^[0-9]+(?:\.[0-9]+)?$/),
    })).max(20).describe("Live curves with confirmed economic activity in the last hour, shared Home Discover candidates.").optional(),
    today: z
      .array(happeningPresaleSchema)
      .max(8)
      .describe(
        "Admin-pinned shown presales, newest pin first; empty without pins.",
      ),
    as_of: socialAsOfSchema,
    top_coins: z
      .xor([
        z.null(),
        z.strictObject({
          trending: z.array(happeningTopCoinSchema).max(50),
          gainers: z.array(happeningTopCoinSchema).max(50),
        }),
      ])
      .optional(),
  })
  .describe(
    "GET /api/social/happening 200 (Cache-Control: public, s-maxage=10, stale-while-revalidate=20): the last hour's commit totals, the live activity tape, the fastest filling and opening-soon presales and the Today on Blast recap, bounded by the watermark. The same for every caller; no viewer field.",
  )
  .meta({
    $id: "https://blast-v2.invalid/social/contracts/happening-response.schema.json",
    title: "Home's live public reads",
  });

/** Named definitions retain published local references, including older unused definitions. */
export const homePublishedContracts = {
  "home-coins-page": {
    schema: homeCoinsPageContractSchema,
    definitions: {
      amount: homeAmountSchema,
      side: homeSideSchema,
      event: homeEventSchema,
      participant: homeParticipantSchema,
      activity: homeActivitySchema,
      coin: homeCoinSchema,
      totals: homeTotalsSchema,
      holder: homeHolderSchema,
    },
  },
  "home-thread-page": {
    schema: homeThreadPageSchema,
    definitions: {
      amount: homeAmountSchema,
      side: homeSideSchema,
      event: homeEventSchema,
      participant: homeParticipantSchema,
      activity: homeActivitySchema,
      coin: homePublishedCoinSchema,
      totals: homeTotalsSchema,
    },
  },
  "home-following-request": {
    schema: homeFollowingRequestContractSchema,
    definitions: {
      amount: homeAmountSchema,
      side: homeSideSchema,
      event: homeEventSchema,
      participant: homeParticipantSchema,
      activity: homeActivitySchema,
      coin: homePublishedCoinSchema,
      totals: homeTotalsSchema,
    },
  },
  "home-following-response": {
    schema: homeFollowingResponseContractSchema,
    definitions: {
      amount: homeAmountSchema,
      side: homeSideSchema,
      event: homeEventSchema,
      tapeEvent: homeFollowingTapeEventSchema,
      participant: homeParticipantSchema,
      activity: homeActivitySchema,
      coin: homeFollowingCoinSchema,
      totals: homeTotalsSchema,
      holder: homeHolderSchema,
    },
  },
  "home-discussion-page": {
    schema: homeDiscussionPageSchema,
    definitions: {
      amount: homeAmountSchema,
      side: homeSideSchema,
      event: homeEventSchema,
      participant: homeParticipantSchema,
      activity: homeActivitySchema,
      coin: homePublishedCoinSchema,
      totals: homeTotalsSchema,
    },
  },
  "home-traders-page": {
    schema: homeTradersPageSchema,
    definitions: {
      amount: homeAmountSchema,
      side: homeSideSchema,
      event: homeEventSchema,
      participant: homeParticipantSchema,
      trader: homeTraderSchema,
      traderCoin: homeTraderCoinSchema,
    },
  },
  "home-activity-stream-page": {
    schema: homeActivityStreamPageSchema,
    definitions: {},
  },
  "home-coin-market": {
    schema: homeCoinMarketSchema,
    definitions: { window: homeMarketWindowSchema },
  },
  "home-holders-page": {
    schema: homeHoldersPageSchema,
    definitions: { holder: homePositionHolderSchema },
  },
  "home-chart-trades-page": {
    schema: homeChartTradesPageSchema,
    definitions: { trade: homeChartTradeSchema },
  },
  "happening-response": {
    schema: socialHappeningResponseSchema,
    definitions: {
      presale: happeningPresaleSchema,
      tapeEvent: happeningTapeEventSchema,
      topCoin: happeningTopCoinSchema,
    },
  },
} as const;

/** Discover and by-ID reads share the published envelope but guarantee different fields. */
export const homeCoinsPageSchema = homeCoinsPageContractSchema.required({
  page: true,
  pages: true,
  total: true,
  next_cursor: true,
}).extend({
  recent_buys: z.array(z.strictObject({
    coin_key: z.string().min(1),
    activity_id: z.string().regex(EVENT_CURSOR),
    occurred_at_ms: feedItemDefinitions.millis,
    quote_atoms: z.string().regex(/^[1-9][0-9]{0,19}$/),
    quote_symbol: z.string().min(1),
    quote_decimals: z.number().int().min(0).max(255),
    /** The buy's dollar value when the indexer priced it. */
    usd: z.string().regex(/^(0|[1-9][0-9]*)(\.[0-9]+)?$/).optional(),
  })).max(50).optional(),
});
export const homeCoinsByIdsSchema = homeCoinsPageContractSchema.required({
  missing: true,
});
export const homeTapeEventSchema = homeFollowingTapeEventSchema.extend({
  actor: homeParticipantSchema.shape.actor,
});

export const homeFollowingResponseSchema = z.discriminatedUnion("mode", [
  homeCoinsPageSchema.extend({
    mode: z.literal("coins"),
    following: homeIntegerSchema.min(0),
  }),
  z.strictObject({
    mode: z.literal("preview"),
    window: homeCoinsPageSchema.shape.window,
    clock_ms: feedItemDefinitions.millis,
    previews: z.record(z.string(), homeActivitySchema),
    as_of: socialAsOfSchema,
  }),
  // Following threads stay a presale's only (the other modes cover every listed coin), so the published body keeps its shape.
  homeThreadPageSchema.omit({ coin_type: true }).extend({ mode: z.literal("thread"), presale_id: homeThreadPageSchema.shape.presale_id.unwrap() }),
  z.strictObject({
    mode: z.literal("tape"),
    window: homeCoinsPageSchema.shape.window,
    clock_ms: feedItemDefinitions.millis,
    events: z.array(homeTapeEventSchema).max(12),
    as_of: socialAsOfSchema,
  }),
]);

/** The first-party paged request predates the published body; do not change that partner contract. */
export const homeFollowingRequestSchema = z.discriminatedUnion("mode", [
  z.strictObject({
    mode: z.literal("coins"),
    window: homeCoinsPageSchema.shape.window,
    cursor: homeFollowingRequestContractSchema.shape.cursor,
    limit: homeIntegerSchema.min(1).max(50).optional(),
    page: homeIntegerSchema.min(1).max(9999).optional(),
  }),
  z.strictObject({
    mode: z.literal("preview"),
    window: homeCoinsPageSchema.shape.window,
    presale_ids: homeFollowingRequestContractSchema.shape.presale_ids.unwrap(),
  }),
  z.strictObject({
    mode: z.literal("thread"),
    window: homeCoinsPageSchema.shape.window,
    presale_id: homeFollowingRequestContractSchema.shape.presale_id.unwrap(),
    cursor: homeFollowingRequestContractSchema.shape.cursor,
  }),
  z.strictObject({
    mode: z.literal("tape"),
    window: homeCoinsPageSchema.shape.window,
  }),
]);

/** Existing in-memory UI fixtures may omit the thesis; the published response requires it. */
export const homeHolderPositionSchema = homePositionHolderSchema.partial({
  why: true,
});
export const homeHoldersReadModelSchema = homeHoldersPageSchema.extend({
  holders: z.array(homeHolderPositionSchema).max(100),
});
