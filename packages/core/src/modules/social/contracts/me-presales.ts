import { z } from "zod";

import { profilePresaleSchema } from "./profile-page.ts";
import {
  presaleIntegerSchema,
  presaleAtomsSchema,
  presalePriceSchema,
  presaleUsdSchema,
} from "./presale-schemas.ts";

export const mePresalePositionSchema = z.strictObject({
  presale: profilePresaleSchema.meta({
    description: "A presale as profile rows show it.",
  }),
  committed_usd: z
    .union([z.null(), z.string().regex(/^(0|[1-9][0-9]*)\.[0-9]{2}$/)])
    .meta({
      description:
        "USDC at face value; another quote at its price when at most 120 s old, else null (R3-40).",
    }),
  committed_atoms: presaleAtomsSchema.meta({
    description: "R3-40: the same commitment in quote atoms.",
  }),
  status: z.enum(["open", "closed", "claimable", "delivered"]),
  claimed_tokens: z.union([z.null(), presalePriceSchema]),
  refunded_usd: z.union([
    z.null(),
    z.string().regex(/^(0|[1-9][0-9]*)\.[0-9]{2}$/),
  ]),
  refunded_atoms: z.union([z.null(), presaleAtomsSchema]).meta({
    description: "R3-40: quote atoms refunded by claiming; null until claimed.",
  }),
  value_usd: z.union([
    z.null(),
    z.string().regex(/^(0|[1-9][0-9]*)\.[0-9]{2}$/),
  ]),
  multiple: z.union([
    z.null(),
    z.string().regex(/^(0|[1-9][0-9]*)\.[0-9]{4}$/),
  ]),
  basis_usd: z
    .union([z.null(), z.string().regex(/^(0|[1-9][0-9]*)\.[0-9]{2}$/)])
    .meta({
      description:
        "R3-32: USD paid for the sale coin held now (average cost, at each acquisition's event time); the known part when basis_complete is false; null when nothing was acquired or nothing of it is known.",
    }),
  basis_complete: z.boolean().meta({
    description:
      "R3-32: false when part of what is held came with no priced acquisition (a transfer in, an airdrop, a reward, a vesting claim, an unpriced commit or trade), or the basis could not be read.",
  }),
  pnl_usd: z.union([z.null(), presaleUsdSchema]).meta({
    description:
      "R3-32: value - basis at the coin's fresh price, signed; null when the basis is zero or unknown, or without a price.",
  }),
  pnl_multiple: z
    .union([z.null(), z.string().regex(/^(0|[1-9][0-9]*)\.[0-9]{4}$/)])
    .meta({
      description: "R3-32: value / basis, four places; null with pnl_usd.",
    }),
});

export const meHoldingCoinSchema = z.strictObject({
  presale: profilePresaleSchema.meta({
    description: "A presale as profile rows show it.",
  }),
  quantity: presalePriceSchema,
  value_usd: z.union([
    z.null(),
    z.string().regex(/^(0|[1-9][0-9]*)\.[0-9]{2}$/),
  ]),
  multiple: z.union([
    z.null(),
    z.string().regex(/^(0|[1-9][0-9]*)\.[0-9]{4}$/),
  ]),
  basis_usd: z
    .union([z.null(), z.string().regex(/^(0|[1-9][0-9]*)\.[0-9]{2}$/)])
    .meta({
      description:
        "R3-32: USD paid for the sale coin held now (average cost, at each acquisition's event time); the known part when basis_complete is false; null when nothing was acquired or nothing of it is known.",
    }),
  basis_complete: z.boolean().meta({
    description:
      "R3-32: false when part of what is held came with no priced acquisition (a transfer in, an airdrop, a reward, a vesting claim, an unpriced commit or trade), or the basis could not be read.",
  }),
  pnl_usd: z.union([z.null(), presaleUsdSchema]).meta({
    description:
      "R3-32: value - basis at the coin's fresh price, signed; null when the basis is zero or unknown, or without a price.",
  }),
  pnl_multiple: z
    .union([z.null(), z.string().regex(/^(0|[1-9][0-9]*)\.[0-9]{4}$/)])
    .meta({
      description: "R3-32: value / basis, four places; null with pnl_usd.",
    }),
});

export const meVestingSchema = z.strictObject({
  schedule_id: z.string().min(1),
  presale: profilePresaleSchema.meta({
    description: "A presale as profile rows show it.",
  }),
  total: presalePriceSchema,
  claimed: presalePriceSchema,
  claimable: presalePriceSchema,
  start_ms: presaleIntegerSchema,
  cliff_end_ms: presaleIntegerSchema.meta({
    description:
      "When the cliff ends: nothing unlocks before it (start_ms + cliff_ms; start_ms without a cliff).",
  }),
  end_ms: presaleIntegerSchema,
  vested_pct: z
    .number()
    .min(0)
    .max(100)
    .refine(Number.isInteger)
    .meta({ type: "integer" }),
  claimable_usd: z.union([
    z.null(),
    z.string().regex(/^(0|[1-9][0-9]*)\.[0-9]{2}$/),
  ]),
});

export const socialMePresalesSchema = z
  .strictObject({
    positions: z.array(mePresalePositionSchema),
    watchlist: z
      .array(
        profilePresaleSchema.meta({
          description: "A presale as profile rows show it.",
        }),
      )
      .max(50),
    coins: z.array(meHoldingCoinSchema),
    vestings: z.array(meVestingSchema).max(100),
    created: z.array(profilePresaleSchema).max(200),
  })
  .meta({
    title: "Social viewer presales",
    description:
      "GET /api/social/me/presales 200 (private, no-store): the caller's own presale positions, followed presales, sale coins held and vesting schedules, each with its presale's summary, each position and coin with its sale coin's cost basis and P&L (R3-32). Created presales match the caller’s uncontested linked wallets or verified app publications.",
  });
