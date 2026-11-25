import { z } from "zod";
import { SUI_OBJECT_ID_PATTERN } from "@blast/core/lib/sui/ids.ts";

export type FeedReadonly<Value> = Value extends object
  ? { readonly [Key in keyof Value]: FeedReadonly<Value[Key]> }
  : Value;

export const feedItemMillisSchema = z
  .number()
  .min(0)
  .refine(Number.isInteger)
  .meta({ type: "integer" });

export const feedItemAtomsSchema = z.string().regex(/^(0|[1-9][0-9]*)$/);

export const feedItemUsdSchema = z.string().regex(/^(0|[1-9][0-9]*)\.[0-9]{2}$/);

export const feedItemKindSchema = z
  .string()
  .min(1)
  .refine((value) => Array.from(value).length <= 64)
  .meta({ maxLength: 64 })
  .meta({
    description:
      "Open string. Known values: presale_commit, presale_claim, trade_buy, trade_sell, presale_created, presale_opened, presale_funded, presale_migrated, presale_cancelled, milestone_participants, milestone_raise, milestone_holders, launch_buy, launch_sell, boost_mint, boost_redeem.",
    examples: [
      "presale_commit",
      "presale_claim",
      "trade_buy",
      "trade_sell",
      "presale_created",
      "presale_opened",
      "presale_funded",
      "presale_migrated",
      "presale_cancelled",
      "milestone_participants",
      "milestone_raise",
      "milestone_holders",
      "launch_buy",
      "launch_sell",
      "boost_mint",
      "boost_redeem",
    ],
  });

export const feedItemDecimalSchema = z
  .string()
  .regex(/^(0|[1-9][0-9]*)(\.[0-9]{1,12})?$/)
  .meta({
    description: "A non-negative decimal with at most 12 fraction digits.",
  });

export const feedItemMarketSchema = z
  .strictObject({
    presale_price_usd: z.xor([z.null(), feedItemDecimalSchema]).meta({
      description: "raise_target ÷ token_allocation in whole units, times the Quote's USD price.",
    }),
    price_usd: z.xor([z.null(), feedItemDecimalSchema]),
    price_as_of_ms: z.xor([z.null(), feedItemMillisSchema]),
    multiple: z
      .xor([z.null(), z.string().regex(/^(0|[1-9][0-9]*)\.[0-9]{4}$/)])
      .meta({ description: "price_usd ÷ presale_price_usd with four places." }),
  })
  .meta({
    description:
      "A migrated presale's coin on the market. Prices are USD per whole sale token; a price older than 120 s at the read is null, and so is anything derived from it.",
  });

export const feedItemPresaleSchema = z.strictObject({
  presale_id: z.string().regex(SUI_OBJECT_ID_PATTERN),
  symbol: z.string(),
  name: z.string(),
  icon_url: z.string(),
  lifecycle: z
    .string()
    .min(1)
    .meta({
      description: "Open string. Known values: pending, open, funded, cancelled, migrated.",
      examples: ["pending", "open", "funded", "cancelled", "migrated"],
    }),
  decimals: z.number().min(0).max(255).refine(Number.isInteger).meta({ type: "integer" }).meta({
    description:
      "The sale token's decimals: amounts.tokens divided by 10^decimals is whole tokens.",
  }),
  venue: z
    .string()
    .min(1)
    .meta({
      description: "Open string. Known values: cetus, bluefin.",
      examples: ["cetus", "bluefin"],
    }),
  start_ms: feedItemMillisSchema,
  end_ms: feedItemMillisSchema,
  raise_target: feedItemAtomsSchema.meta({ description: "Quote atoms." }),
  raised: feedItemAtomsSchema.meta({
    description: "Quote atoms committed so far (total_commitments); final once the sale ended.",
  }),
  participants: z.number().min(0).refine(Number.isInteger).meta({ type: "integer" }),
  quote_symbol: z.string().min(1),
  quote_decimals: z.number().min(0).max(255).refine(Number.isInteger).meta({ type: "integer" }),
  quote_usd: z.xor([z.null(), feedItemDecimalSchema]).meta({
    description: "The Quote's latest USD price; null when missing or older than 120 s at the read.",
  }),
  market: z
    .xor([z.null(), feedItemMarketSchema])
    .meta({ description: "Set once the presale migrated; null before." }),
  coin_type: z
    .string()
    .min(1)
    .meta({
      description: "Canonical sale coin type; optional for older cached responses.",
    })
    .optional(),
  verified_team: z
    .boolean()
    .meta({
      description: "R3-23: Blast checked who is behind the sale (social_sale_trust); sent only when true.",
    })
    .optional(),
});

export const feedItemAccountActorSchema = z
  .strictObject({
    type: z.literal("account"),
    callsign: z.string().regex(/^[a-z0-9][a-z0-9_]{1,18}[a-z0-9]$/),
    display_name: z.xor([z.null(), z.string().min(1)]),
    avatar_url: z.xor([z.null(), z.string().min(1)]),
    x_handle: z.xor([z.null(), z.string().min(1)]),
    path: z
      .string()
      .regex(/^\/@[a-z0-9][a-z0-9_]{1,18}[a-z0-9]$/)
      .meta({ description: "/@<callsign> (OA-4)." }),
    verified: z.boolean().meta({ description: "OA-8: the account has a linked X account." }),
  })
  .meta({
    required: ["type", "callsign", "display_name", "avatar_url", "x_handle", "verified", "path"],
  });

export const feedItemAddressActorSchema = z.strictObject({
  type: z.literal("address"),
  address: z.string().regex(SUI_OBJECT_ID_PATTERN),
  short: z.string().regex(/^0x[0-9a-f]{4}…[0-9a-f]{4}$/),
});

export const feedItemAmountsSchema = z.strictObject({
  quote: feedItemAtomsSchema,
  quote_symbol: z.xor([z.null(), z.string().min(1)]),
  quote_decimals: z.xor([
    z.null(),
    z.number().min(0).max(255).refine(Number.isInteger).meta({ type: "integer" }),
  ]),
  usd: z.xor([z.null(), feedItemDecimalSchema]).meta({
    description:
      "The activity row's usd_value, priced by the indexer at the event's time, unrounded to at most 12 places; null when it stored none.",
  }),
  tokens: z.xor([z.null(), feedItemAtomsSchema]),
  quote_refund: z.xor([z.null(), feedItemAtomsSchema]),
});

export const feedItemWhySchema = z.strictObject({
  why_id: z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/),
  text: z
    .string()
    .min(1)
    .refine((value) => Array.from(value).length <= 2000)
    .meta({ maxLength: 2000 }),
});

export const feedItemReactionsSchema = z
  .record(
    z.string().regex(/^[a-z][a-z0-9_]{0,31}$/),
    z.number().min(0).refine(Number.isInteger).meta({ type: "integer" }),
  )
  .refine((value) => Object.keys(value).length <= 8)
  .meta({ maxProperties: 8 })
  .meta({
    description:
      "Stored reactions per currently configured key, in configured order, zeros included.",
  });

export const feedItemThroughSchema = z
  .strictObject({
    people: z.number().min(0).refine(Number.isInteger).meta({ type: "integer" }),
    volume_usd: feedItemUsdSchema,
  })
  .meta({
    description:
      "Distinct accounts with a non-voided attribution to the item, and their non-null USD.",
  });

export const feedItemDoTheSameSchema = z.strictObject({
  kind: z
    .string()
    .min(1)
    .refine((value) => Array.from(value).length <= 64)
    .meta({ maxLength: 64 })
    .meta({
      description: "Open string. Known values: commit, buy, long (later).",
      examples: ["commit", "buy", "long"],
    }),
  enabled: z.boolean(),
  label: z.string().min(1),
  href: z.xor([z.null(), z.string().regex(/^\//)]).meta({
    description: "Null while enabled; the presale page (/presale/{id}) when disabled.",
  }),
});

export const feedItemBackerSchema = z.strictObject({
  callsign: z.string().regex(/^[a-z0-9][a-z0-9_]{1,18}[a-z0-9]$/),
  display_name: z.xor([z.null(), z.string().min(1)]),
  avatar_url: z.xor([z.null(), z.string().min(1)]),
  verified: z.boolean(),
  path: z.string().regex(/^\/@[a-z0-9][a-z0-9_]{1,18}[a-z0-9]$/),
  usd: z.xor([z.null(), feedItemUsdSchema]).meta({
    description: "The USD of the backer's named commits to the presale; null when none was priced.",
  }),
});

export const socialFeedItemSchema = z
  .strictObject({
    pinned: z
      .boolean()
      .meta({
        description: "Pinned by Blast in the home feed. Omitted on ordinary posts.",
      })
      .optional(),
    entry_id: z
      .string()
      .refine((value) => Array.from(value).length <= 512)
      .meta({ maxLength: 512 })
      .regex(/^[alm]:/)
      .meta({
        description:
          "a:<checkpoint>:<tx_slot>:<event_slot>:<part>, l:<presale_id>:<state> or m:<presale_id>:<kind>:<value>.",
      }),
    kind: feedItemKindSchema,
    occurred_at_ms: feedItemMillisSchema,
    presale: z.xor([z.null(), feedItemPresaleSchema]),
    actor: z.xor([z.null(), feedItemAccountActorSchema, feedItemAddressActorSchema]).meta({
      description:
        "The account for a named entry, the wallet address only for an unnamed presale post, null for lifecycle and milestone posts.",
    }),
    amounts: z.xor([z.null(), feedItemAmountsSchema]),
    digest: z.xor([z.null(), z.string().min(1)]),
    milestone_value: z.xor([z.null(), z.string().regex(/^(0|[1-9][0-9]*)(\.[0-9]+)?$/)]).meta({
      description: "A milestone post's threshold; null for every other item.",
    }),
    presale_post: z.boolean().meta({ description: "True for lifecycle, milestone and big items." }),
    big: z.boolean().meta({
      description:
        "A commit at or above big_commit_usd, or a trade at or above big_trade_usd, evaluated on each read.",
    }),
    why: z.xor([z.null(), feedItemWhySchema]),
    reactions: feedItemReactionsSchema,
    through: feedItemThroughSchema,
    do_the_same: z.xor([z.null(), feedItemDoTheSameSchema]),
    call: z.boolean().meta({
      description:
        "OA-9: a named presale_commit of a presale whose coin now trades (lifecycle migrated). Its result is presale.market.",
    }),
    backers: z.xor([z.null(), z.array(feedItemBackerSchema).max(12)]).meta({
      description:
        "A lifecycle or milestone post's named backers of its presale (the naming rule applies), the largest first, at most 12; null on every other item.",
    }),
  })
  .meta({
    title: "Social feed item",
    description:
      "One public feed item, as every feed, profile and item route answers it. No viewer-specific field. On-chain amounts are decimal strings in atoms, times are integer milliseconds, USD is a decimal string with two places. `kind` and `do_the_same.kind` are open strings: a client renders an unknown value generically.",
  });

export const feedItemDefinitions = {
  millis: feedItemMillisSchema,
  atoms: feedItemAtomsSchema,
  usd: feedItemUsdSchema,
  kind: feedItemKindSchema,
  presale: feedItemPresaleSchema,
  accountActor: feedItemAccountActorSchema,
  addressActor: feedItemAddressActorSchema,
  amounts: feedItemAmountsSchema,
  why: feedItemWhySchema,
  reactions: feedItemReactionsSchema,
  through: feedItemThroughSchema,
  doTheSame: feedItemDoTheSameSchema,
  decimal: feedItemDecimalSchema,
  market: feedItemMarketSchema,
  backer: feedItemBackerSchema,
} as const;

export const feedItemActorSchema = z.xor([feedItemAccountActorSchema, feedItemAddressActorSchema]);

/**
 * The public feed item: one entry of `social_feed_entries` as every feed,
 * profile and item route answers it. JSON Schema:
 * `schemas/feed-item.schema.json`; the freshness block is
 * `schemas/as-of.schema.json`. A public item carries no viewer-specific
 * field.
 *
 * Numbers: on-chain amounts are decimal strings in atoms, times are integer
 * milliseconds, USD is a decimal string with two places.
 */

/**
 * A migrated presale's coin on the market (OA-9 calls, FEATURE-MAP §3.4).
 * Prices are USD per whole sale token as decimal strings (at most 12
 * fraction digits). A price older than `ITEM_PRICE_MAX_AGE_MS` at the read is
 * null (spec AC-112), and so is anything derived from it.
 */
export type FeedItemMarket = FeedReadonly<z.infer<typeof feedItemMarketSchema>>;

export type FeedItemPresale = FeedReadonly<z.infer<typeof feedItemPresaleSchema>>;

/** A named backer of a presale, shown on its posts' facepile (FEATURE-MAP §3.5). */
export type FeedItemBacker = FeedReadonly<z.infer<typeof feedItemBackerSchema>>;

/** A named entry's account. Only a named entry carries one. */
export type FeedItemAccountActor = FeedReadonly<z.infer<typeof feedItemAccountActorSchema>>;

/** An unnamed presale post's actor: the wallet only, never an identity. */
export type FeedItemAddressActor = FeedReadonly<z.infer<typeof feedItemAddressActorSchema>>;

export type FeedItemActor = FeedReadonly<z.infer<typeof feedItemActorSchema>>;

export type FeedItemAmounts = FeedReadonly<z.infer<typeof feedItemAmountsSchema>>;

export type FeedItemWhy = FeedReadonly<z.infer<typeof feedItemWhySchema>>;

export type FeedItemThrough = FeedReadonly<z.infer<typeof feedItemThroughSchema>>;

export type DoTheSame = FeedReadonly<z.infer<typeof feedItemDoTheSameSchema>>;

export type FeedItem = FeedReadonly<z.infer<typeof socialFeedItemSchema>>;

const watermarkInteger = z
  .number()
  .nonnegative()
  .refine(Number.isInteger)
  .meta({ type: "integer" });

export const socialAsOfSchema = z
  .strictObject({
    checkpoint: watermarkInteger,
    timestamp_ms: watermarkInteger,
    lag_ms: watermarkInteger,
  })
  .meta({
    title: "Chain freshness of a social read",
    description:
      "From chain_read_v1.watermark: the slowest pipeline's checkpoint and timestamp, and their age when read.",
  });

export type AsOf = Readonly<z.infer<typeof socialAsOfSchema>>;

/** A price older than this at the read is not used (spec AC-112). */
export const ITEM_PRICE_MAX_AGE_MS = 120_000;

/** The most named backers a post carries for its facepile (six faces show; the rest let a viewer's follows come first). */
export const ITEM_BACKERS_MAX = 12;

/** Page size of item routes: default 20, at most 50. */
export const ITEM_PAGE_DEFAULT_LIMIT = 20;
export const ITEM_PAGE_MAX_LIMIT = 50;

/** The canonical UI's words (OA-7, FEATURE-MAP §3.6): "Blast" and "View presale". */
export const DO_THE_SAME_LABELS = Object.freeze({
  commit: "Blast",
  view: "View presale",
});
