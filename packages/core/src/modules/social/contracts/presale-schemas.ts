import { z } from "zod";

import { socialAsOfSchema, socialFeedItemSchema } from "./items.ts";
import { socialSaleMetadataSchema } from "./sales.ts";

import {
  PRESALE_LIST_STATUSES,
  PRESALE_LIST_MAX_LIMIT,
  PRESALE_VIEWER_MAX_IDS,
  PRESALE_BACKER_SAMPLE,
  PRESALE_RAISE_POINTS,
  PRESALE_TOP_BACKERS,
} from "./presales.ts";
import { SUI_OBJECT_ID_PATTERN } from "@blast/core/lib/sui/ids.ts";

export type PresaleReadonly<Value> = Value extends object
  ? { readonly [Key in keyof Value]: PresaleReadonly<Value[Key]> }
  : Value;

// Wire integers intentionally have no safe-integer ceiling: the published contracts
// specify only an integer and their explicit bounds. Atom strings are unbounded.

export const presaleIntegerSchema = z
  .number()
  .min(0)
  .refine(Number.isInteger)
  .meta({ type: "integer" });

export const presaleAtomsSchema = z.string().regex(/^(0|[1-9][0-9]*)$/);

export const presaleUsdSchema = z
  .string()
  .regex(/^-?(0|[1-9][0-9]*)\.[0-9]{2}$/);

export const presalePriceSchema = z
  .string()
  .regex(/^(0|[1-9][0-9]*)(\.[0-9]+)?$/);

export const socialPresalePersonSchema = z.strictObject({
  callsign: z.string().regex(/^[a-z0-9][a-z0-9_]{1,18}[a-z0-9]$/),
  display_name: z.union([z.null(), z.string()]),
  avatar_url: z.union([z.null(), z.string()]),
  verified: z.boolean(),
});

export const socialPresaleMomentumSchema = z.strictObject({
  commits: presaleIntegerSchema,
  total_usd: presaleUsdSchema,
  total_atoms: presaleAtomsSchema,
  backers: presaleIntegerSchema,
  average_usd: z.union([z.null(), presaleUsdSchema]),
  median_usd: z.union([z.null(), presaleUsdSchema]),
  average_atoms: z.union([z.null(), presaleAtomsSchema]),
  median_atoms: z.union([z.null(), presaleAtomsSchema]),
  big_bps: presaleIntegerSchema,
});

export const socialPresaleVestingSchema = z.strictObject({
  start_ms: presaleIntegerSchema,
  cliff_end_ms: presaleIntegerSchema,
  end_ms: presaleIntegerSchema,
});

export const socialPresaleShareSchema = z.strictObject({
  bps: presaleIntegerSchema,
  amount: presaleAtomsSchema,
});

export const socialPresaleRecipientSchema = z.strictObject({
  address: z.string().regex(SUI_OBJECT_ID_PATTERN),
  bps: presaleIntegerSchema,
  amount: presaleAtomsSchema,
  vesting: z.union([z.null(), socialPresaleVestingSchema]),
});

export const buyerVestingTotalsSchema = z.strictObject({
  schedules: presaleIntegerSchema,
  total: presaleAtomsSchema,
  claimed: presaleAtomsSchema,
  remaining: presaleAtomsSchema,
});

export const buyerVestingPositionSchema = z.strictObject({
  schedule_id: z.string().regex(SUI_OBJECT_ID_PATTERN),
  beneficiary: z.string().regex(SUI_OBJECT_ID_PATTERN),
  total: presaleAtomsSchema,
  claimed: presaleAtomsSchema,
  remaining: presaleAtomsSchema,
});

export const socialQuotePriceSchema = z.strictObject({
  usd_price: presalePriceSchema,
  as_of_ms: presaleIntegerSchema,
});

export const socialPresaleBackerSchema = z.strictObject({
  wallet: z.string().regex(SUI_OBJECT_ID_PATTERN),
  account: z.union([z.null(), socialPresalePersonSchema]),
  commitment_usd: z.union([z.null(), presaleUsdSchema]),
  commitment_atoms: presaleAtomsSchema,
  share_bps: presaleIntegerSchema,
  last_commit_ms: z.union([z.null(), presaleIntegerSchema]).meta({
    description: "Null for a wallet blast-infra knows only from its claim.",
  }),
  why: z.union([z.null(), z.string()]),
});

export const socialPresaleThesisSchema = z.strictObject({
  why_id: z.string(),
  entry_id: z.string(),
  account: socialPresalePersonSchema,
  text: z.string(),
  commit_usd: z.union([z.null(), presaleUsdSchema]),
  commit_atoms: presaleAtomsSchema,
  rockets: presaleIntegerSchema,
  occurred_at_ms: presaleIntegerSchema,
});

export const socialPresaleRaiseMarkerSchema = z.strictObject({
  t: presaleIntegerSchema,
  raised_usd: presaleUsdSchema,
  commit_usd: z.union([z.null(), presaleUsdSchema]),
  raised_atoms: presaleAtomsSchema,
  commit_atoms: presaleAtomsSchema,
  wallet: z.string().regex(SUI_OBJECT_ID_PATTERN),
  account: z.union([z.null(), socialPresalePersonSchema]),
  why: z.union([z.null(), z.string()]),
});

export const socialPresaleRaiseSchema = z.strictObject({
  points: z
    .array(
      z.tuple([presaleIntegerSchema, presaleUsdSchema, presaleAtomsSchema]),
    )
    .max(PRESALE_RAISE_POINTS),
  markers: z.array(socialPresaleRaiseMarkerSchema).max(60),
});

export const socialPresaleTermsSchema = z.strictObject({
  eligible_uncapped_from_ms: presaleIntegerSchema.optional(),
  public_buy: z.strictObject({
    from_ms: presaleIntegerSchema,
    min_atoms: presaleAtomsSchema,
    hard_cap_from_ms: presaleIntegerSchema.nullable(),
  }).optional(),
  supply: z.strictObject({
    total: presaleAtomsSchema,
    participants: socialPresaleShareSchema,
    liquidity: socialPresaleShareSchema,
    recipients: z.array(socialPresaleRecipientSchema),
    protocol: socialPresaleShareSchema,
  }),
  raise: z.strictObject({
    pool_bps: presaleIntegerSchema,
    recipients: z.array(socialPresaleRecipientSchema),
    protocol: socialPresaleShareSchema,
  }),
  eligibility: z.xor([
    z.strictObject({
      kind: z.literal("open"),
    }),
    z.strictObject({
      kind: z.literal("allowlisted"),
      wallets: presaleIntegerSchema,
    }),
  ]),
  presale_price_usd: z.union([z.null(), presalePriceSchema]),
  launch_price_usd: z.union([z.null(), presalePriceSchema]),
  presale_price_quote: z.union([z.null(), presalePriceSchema]),
  launch_price_quote: z.union([z.null(), presalePriceSchema]),
  launch_fdv_quote: z
    .union([z.null(), presalePriceSchema])
    .meta({
      description:
        "The coin's value at the pool's opening price when the sale raises its target, in whole quote coins: launch_price_quote times supply.total, from the atoms (twelve significant digits).",
    })
    .optional(),
  trading_fee_ppm: z
    .union([
      z.null(),
      z
        .number()
        .min(0)
        .max(1000000)
        .refine(Number.isInteger)
        .meta({ type: "integer" }),
    ])
    .meta({
      description:
        "The migration pool's swap fee in millionths of each trade (2500 is 0.25%); null for an Aftermath sale or a tier not indexed yet. The server always sends it; partner v1 does not publish it, so it is not required.",
    })
    .optional(),
  burnable: z.boolean().nullable().meta({
    description:
      "R3-90: whether holders can burn the coin (blast-infra supply.burnable); null when the terms read does not carry it.",
  }),
  hard_cap: z.boolean().nullable().meta({
    description:
      "R3-90: whether the sale stops at its target (the uncapped phase's hard_cap; the hard cap is then the target); false when it can go over the target; null when the terms read does not carry it.",
  }),
  buyer_vesting: z
    .union([
      z.null(),
      z.strictObject({
        cliff_ms: presaleAtomsSchema,
        duration_ms: presaleAtomsSchema,
      }),
    ])
    .optional(),
});

export const socialPresaleFollowedBackerSchema = z.strictObject({
  account: socialPresalePersonSchema,
  commitment_usd: z.union([z.null(), presaleUsdSchema]),
  commitment_atoms: presaleAtomsSchema,
  last_commit_ms: presaleIntegerSchema,
  why: z.union([z.null(), z.string()]),
  commits: z
    .array(
      z.tuple([
        presaleIntegerSchema,
        z.union([z.null(), presaleUsdSchema]),
        presaleAtomsSchema,
      ]),
    )
    .max(20),
});

export const socialPresaleViewerEntrySchema = z.strictObject({
  following: z.array(socialPresaleFollowedBackerSchema).max(100),
  following_total_usd: presaleUsdSchema.nullable(),
  following_total_atoms: presaleAtomsSchema,
  mine: z.union([
    z.null(),
    z.strictObject({
      commitment_usd: z.union([z.null(), presaleUsdSchema]),
      commitment_atoms: presaleAtomsSchema,
      commits: z
        .array(
          z.tuple([
            presaleIntegerSchema,
            z.union([z.null(), presaleUsdSchema]),
            presaleAtomsSchema,
          ]),
        )
        .max(20),
      claimed: z.boolean(),
      refund_usd: z.union([z.null(), presaleUsdSchema]),
      refund_atoms: presaleAtomsSchema,
      claimable_tokens: presaleAtomsSchema.nullable().optional(),
      claimed_tokens: presaleAtomsSchema.optional(),
      claim_wallet_claimed: z.boolean().optional(),
      claim_wallet_commitment_atoms: presaleAtomsSchema.optional(),
      buyer_vesting: z.union([z.null(), buyerVestingPositionSchema]).optional(),
      claim_wallet_participated: z.boolean().optional(),
    }),
  ]),
});

export const socialPresaleSummarySchema = z
  .strictObject({
    presale_id: z.string().regex(SUI_OBJECT_ID_PATTERN),
    name: z.string(),
    symbol: z.string(),
    icon_url: z.string(),
    phase: z.enum([
      "pending",
      "open",
      "closed",
      "funded",
      "trading",
      "cancelled",
    ]),
    venue: z.string(),
    start_ms: presaleIntegerSchema,
    end_ms: presaleIntegerSchema,
    ended_ms: z.union([z.null(), presaleIntegerSchema]),
    launched_ms: z.union([z.null(), presaleIntegerSchema]),
    target_usd: z.union([z.null(), presaleUsdSchema]),
    raised_usd: z.union([z.null(), presaleUsdSchema]),
    quote_symbol: z.string().min(1).meta({
      description:
        "R3-40: the sale's quote coin (USDC or SUI). A USDC sale reads in dollars (the *_usd fields); any other quote reads in its own coin from the *_atoms figures and quote_decimals.",
    }),
    quote_decimals: presaleIntegerSchema,
    target_atoms: presaleAtomsSchema.meta({
      description: "R3-40: the target in quote atoms (raise_target).",
    }),
    raised_atoms: presaleAtomsSchema.meta({
      description:
        "R3-40: the amount raised in quote atoms (total_commitments).",
    }),
    fill_bps: presaleIntegerSchema,
    participants: presaleIntegerSchema,
    interested: presaleIntegerSchema.meta({
      description:
        "R3-29: the sale's current presale follows, one per account; an unfollow decrements it and a deleted account never counts. The same for every caller; names nobody.",
    }),
    backers_sample: z
      .array(socialPresalePersonSchema)
      .max(PRESALE_BACKER_SAMPLE)
      .meta({
        description:
          "Redesign gap 11: up to 3 named backers of the sale's latest 24 commits, the latest first, one per account, under the naming rule; empty when none is named. List and featured pages only.",
      })
      .optional(),
    presale_price_usd: z.union([z.null(), presalePriceSchema]),
    presale_price_quote: z.union([z.null(), presalePriceSchema]).meta({
      description:
        "R3-40: the presale price in the quote coin per whole token; null with no claim yet.",
    }),
    price_usd: z.union([z.null(), presalePriceSchema]),
    multiple: z.union([z.null(), presalePriceSchema]),
    verified_team: z.boolean().meta({
      description:
        "R3-23: Blast checked who is behind the project. Set only by an operator (social_sale_trust); false without a row. Never derived from creator input.",
    }),
    audited: z.boolean().meta({
      description:
        "R3-23: Blast read the audit report. Set only by an operator; an audit link in the sale's metadata never sets it. False without a row.",
    }),
    metadata: z.xor([z.null(), socialSaleMetadataSchema]).meta({
      description:
        "R3-24: the sale's public details (cover, tagline, links, published launch date); null when it has none. Never names who wrote them.",
    }),
    quote_type: z.string().min(1).meta({
      description: "The exact on-chain coin type accepted by this presale.",
    }),
    sale_decimals: z
      .number()
      .min(0)
      .max(255)
      .refine(Number.isInteger)
      .meta({ type: "integer" })
      .optional(),
    allowlisted: z.boolean().optional(),
    hard_cap: z.boolean().nullable().optional(),
    coin_type: z
      .string()
      .min(1)
      .meta({
        description:
          "Canonical sale coin type; optional for older cached responses.",
      })
      .optional(),
  })
  .meta({
    title: "Presale summary",
    description:
      "One sale as a list row shows it (contracts/presales.ts SocialPresaleSummary).",
  });

// Detail rows omit the list facepile and require indexed sale/eligibility fields.
export const socialPresaleDetailRowSchema = socialPresaleSummarySchema
  .omit({ backers_sample: true })
  .extend({
    sale_token: z.string(),
    sale_decimals: presaleIntegerSchema,
    allowlisted: z.boolean().meta({
      description:
        "An allowlisted sale: any positive commitment up to each wallet's own allowlist cap (min_commitment_usd and wallet_cap_usd are then null).",
    }),
    min_commitment_usd: z.union([z.null(), presaleUsdSchema]),
    wallet_cap_usd: z.union([z.null(), presaleUsdSchema]),
    min_commitment_atoms: z.union([z.null(), presaleAtomsSchema]).meta({
      description: "R3-40: min_commitment_usd's limit in quote atoms.",
    }),
    wallet_cap_atoms: z
      .union([z.null(), presaleAtomsSchema])
      .meta({ description: "R3-40: wallet_cap_usd's limit in quote atoms." }),
    opened_ms: z.union([z.null(), presaleIntegerSchema]),
  });

export const presaleStatusCountsSchema = z
  .strictObject({
    live: presaleIntegerSchema,
    upcoming: presaleIntegerSchema,
    ended: presaleIntegerSchema,
  })
  .meta({
    description:
      "How many presales each tab holds now under the page's filters, whatever its status, sort or cursor. The server always sends it; partner v1 does not publish it, so it is not required.",
  });

export const socialPresaleListPageSchema = z
  .strictObject({
    presales: z.array(socialPresaleSummarySchema).max(PRESALE_LIST_MAX_LIMIT),
    next_cursor: z.union([z.null(), z.string().min(1).max(512)]),
    status_counts: presaleStatusCountsSchema
      .meta({
        description:
          "How many presales each tab holds now under the page's filters, whatever its status, sort or cursor. The server always sends it; partner v1 does not publish it, so it is not required.",
      })
      .optional(),
    as_of: socialAsOfSchema,
  })
  .meta({
    title: "Presale list page",
    description:
      "GET /api/social/presales 200: one keyset page of a tab, the same for every caller.",
  });

export const socialPresaleDetailSchema = z
  .strictObject({
    presale: socialPresaleDetailRowSchema,
    quote_price: z.union([z.null(), socialQuotePriceSchema]).meta({
      description:
        "Indexed USD price for a whole coin of the presale's exact quote type, with its observation time. Null when the quote is valued at one dollar or there is no indexed price.",
    }),
    momentum: z.strictObject({
      "5m": socialPresaleMomentumSchema,
      "1h": socialPresaleMomentumSchema,
      "4h": socialPresaleMomentumSchema,
      "1d": socialPresaleMomentumSchema,
    }),
    backers: z.strictObject({
      top: z.array(socialPresaleBackerSchema).max(PRESALE_TOP_BACKERS),
      top10_bps: presaleIntegerSchema,
    }),
    theses: z.array(socialPresaleThesisSchema).max(50),
    activity: z.array(socialFeedItemSchema).max(30),
    raise: socialPresaleRaiseSchema,
    vesting: z.union([z.null(), socialPresaleVestingSchema]).meta({
      description:
        "The span of every schedule of the sale (token and raise recipients', and any other the view holds): the earliest start and cliff end, the latest end. Not the team's; a team unlock reads team_vesting.",
    }),
    team_vesting: z.union([z.null(), socialPresaleVestingSchema]).meta({
      description:
        "The team's vesting: the span of the sale's token recipients' schedules, or null when the sale has none or the read cannot tell which schedules are the team's (no terms, a token recipient that is also a raise recipient, or token recipients that unlock differently). Null never means nothing vests.",
    }),
    terms: z.union([z.null(), socialPresaleTermsSchema]),
    as_of: socialAsOfSchema,
    creator: z
      .strictObject({
        wallet: z.string().regex(SUI_OBJECT_ID_PATTERN),
        account: z.union([z.null(), socialPresalePersonSchema]),
      })
      .nullable()
      .meta({
        description:
          "Original creating wallet; account respects privacy and sharing at creation.",
      }),
    buyer_vesting: buyerVestingTotalsSchema.optional(),
  })
  .meta({
    title: "Presale detail",
    description:
      "GET /api/social/presales/{presale_id} 200: one sale, the same for every caller.",
  });

export const socialPresaleViewerRequestSchema = z
  .xor([
    z.strictObject({
      presale_ids: z
        .array(z.string().regex(SUI_OBJECT_ID_PATTERN))
        .min(1)
        .max(PRESALE_VIEWER_MAX_IDS),
    }),
    z.strictObject({
      status: z.enum(PRESALE_LIST_STATUSES),
    }),
    z.strictObject({
      mine: z.literal(true),
    }),
  ])
  .meta({
    title: "Presale viewer request",
    description:
      "POST /api/social/presales/viewer: the presale ids on screen, a tab for the 'Backed by people you follow' filter, or mine for 'Your presales'.",
  });

export const socialPresaleViewerResponseSchema = z
  .strictObject({
    presales: z.record(
      z.string().regex(SUI_OBJECT_ID_PATTERN),
      socialPresaleViewerEntrySchema,
    ),
    rows: z.union([
      z.null(),
      z.array(socialPresaleSummarySchema).max(PRESALE_VIEWER_MAX_IDS),
    ]),
  })
  .meta({
    title: "Presale viewer response",
    description:
      "POST /api/social/presales/viewer 200 (private, no-store): per presale, the caller's followed backers and own position; with a status, those presales' rows.",
  });

/** Validate a private viewer response before placing it in the browser query cache. */
export function isPresaleViewerResponse(
  value: unknown,
): value is PresaleReadonly<z.infer<typeof socialPresaleViewerResponseSchema>> {
  return socialPresaleViewerResponseSchema.safeParse(value).success;
}

/** Featured and creator lists share the same complete summary rows, without paging. */
export const socialPresaleRowsSchema = z.strictObject({
  presales: z.array(socialPresaleSummarySchema),
});
