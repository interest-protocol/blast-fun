import { z } from "zod";
import { SUI_OBJECT_ID_PATTERN } from "@blast/core/lib/sui/ids.ts";

/**
 * The owner-only portfolio: `GET /api/social/me/portfolio` (schema
 * `schemas/portfolio-response.schema.json`).
 *
 * - Authentication required; a caller without a Blast Account is `409
 *   account_required`. There is no parameter
 *   naming an account, callsign or wallet: the wallets are the verified
 *   token's account's (`social_wallet_owners`), and query parameters are
 *   ignored except `wallet`, an optional verified wallet address, and `view=summary`,
 *   which omits coin rows and returns `coin_summary`.
 * - Every answer is `Cache-Control: private, no-store`. Without a valid token
 *   it is `401 unauthorized` with no portfolio field.
 * - Every database read (social tables and `chain_read_v1` views) runs on the
 *   primary. A database outage is `503 service_unavailable`.
 * - A part that cannot be read (its index is unavailable) is `null` and named in
 *   `unavailable`; a part is null exactly when it is listed. A value is never
 *   zero in place of an unknown one: a USD value without a price fresher
 *   than 120 s is `null` while its atoms are still shown.
 * - `coins`: every positive non-cash coin across verified linked wallets, including
 *   coins without a Blast listing, metadata or price. SUI/USDC are in `balances`.
 *   Unknown decimals stay null; amounts are exact base units. Missing/stale prices
 *   give null USD. `wallet_sync` distinguishes initial sync and stale holdings.
 * - `vesting`: presale allocations across linked wallets plus covered utility
 *   schedules receiving or created by the authenticated active wallet (the same
 *   scope as `/me/vesting`). The owner's `href` opens `/portfolio/vestings`.
 *   Public portfolios retain the paying sale's website for presale allocations.
 *   An unavailable required schedule read stays null and listed in `unavailable`.
 * - The public read (OA-10, below) answers the same body, `coins` and
 *   `vesting` included: its owner opted in, and both are chain data.
 * - Cost basis (R3-32): every position and every coin carries
 *   `CostBasisFigures` — what the account paid for the sale coin it holds,
 *   by average cost over the chain's activity log, and the P&L that answers
 *   (`portfolio/cost-basis.ts` has the rule). A position carries its sale
 *   coin's figures, so a position whose tokens were all sold reads a zero
 *   basis and no P&L.
 * - `trend` (OA-25 Q16, R3-08): the gold card's 30-day line, from the
 *   account's daily portfolio-value snapshots (`portfolio/snapshots.ts`,
 *   0097; the rule in `portfolio/trend.ts`). `points` is empty until the
 *   account has a month of them — its newest valued day today or yesterday
 *   (UTC) and the day 30 days before it valued too — and the slot is then
 *   empty, never filled with an estimate. Null (and listed) when the
 *   snapshots cannot be read. On the public read the window starts at the
 *   UTC day the portfolio became public (`portfolio_public_since`, 0097), so
 *   a newly public portfolio has no line until it has a month of public
 *   history; the owner's own read shows the whole history.
 */
export const SOCIAL_PORTFOLIO_ROUTE = "GET /api/social/me/portfolio";
export const SOCIAL_PORTFOLIO_PATH = "/api/social/me/portfolio";

/** The parts a portfolio answer may be missing, in the order `unavailable` lists them. */
export const PORTFOLIO_PARTS = [
  "balances",
  "positions",
  "coins",
  "vesting",
  "totals",
  "trend",
] as const;
export type PortfolioPart = (typeof PORTFOLIO_PARTS)[number];

/** A price older than this (by its `as_of_ms`) gives no USD value. */
export const PORTFOLIO_PRICE_MAX_AGE_MS = 120_000;

/** The cash partition of indexed wallet holdings, with fixed decimals. */
export const PORTFOLIO_BALANCE_DECIMALS = { sui: 9, usdc: 6 } as const;
export type PortfolioBalanceCoin = keyof typeof PORTFOLIO_BALANCE_DECIMALS;

export const PORTFOLIO_POSITION_STATUSES = ["open", "closed", "claimable", "delivered"] as const;
/**
 * - `open`: the sale is open (lifecycle `open`, before its end);
 * - `closed`: the sale ended and is not claimable yet (an ended open sale,
 *   `funded`, or a lifecycle not known yet);
 * - `claimable`: `migrated` or `cancelled`, not claimed by every wallet;
 * - `delivered`: claimed.
 */
export type PortfolioPositionStatus = (typeof PORTFOLIO_POSITION_STATUSES)[number];

/**
 * R3-32: a sale coin's cost basis for the account, and the P&L it answers
 * (`portfolio/cost-basis.ts`). Average cost, in USD at each acquisition's
 * event time, over the account's wallets as one holding; exact decimals.
 */
export type CostBasisFigures = Readonly<
  Pick<
    z.infer<typeof portfolioPositionSchema>,
    "basis_usd" | "basis_complete" | "pnl_usd" | "pnl_multiple"
  >
>;

/** The figures of a sale coin the account never acquired and does not hold (a position still in its presale). */
export const NO_COST_BASIS: CostBasisFigures = Object.freeze({
  basis_usd: null,
  basis_complete: true,
  pnl_usd: null,
  pnl_multiple: null,
});

/** An amount in atoms (decimal string) and its USD value (two places), null without a fresh price. */
export type PortfolioAmount = Readonly<z.infer<typeof portfolioAmountSchema>>;

/** One presale position, summed over the account's wallets in that presale. */
export type PortfolioPosition = Readonly<z.infer<typeof portfolioPositionSchema>>;

export type PortfolioTotals = Readonly<
  NonNullable<z.infer<typeof socialPortfolioSchema>["totals"]>
>;

/** A presale sale coin held, summed over the account's wallets. */
export type PortfolioCoin = Readonly<z.infer<typeof portfolioCoinSchema>>;

/** `href`: the paying sale's website (`https://…`, OA-21), or null for no link. */
export type PortfolioVesting = Readonly<
  NonNullable<z.infer<typeof socialPortfolioSchema>["vesting"]>
>;

/**
 * Committed values the quote still in presales; Claimable values remaining
 * token allocations and quote refunds. USDC counts at face value; other
 * assets need prices at most 120 s old. Each part is summed exactly and
 * rounded once to cents. Missing amounts or prices leave that part null.
 */
export type PortfolioCommitments = Readonly<
  NonNullable<z.infer<typeof socialPortfolioSchema>["commitments"]>
>;

/** The gold card's window, in days (the caption's "30 days"). */
export const PORTFOLIO_TREND_DAYS = 30;

/** One valued day: the account's portfolio in USD (two places) as the daily snapshot took it. */
export type PortfolioTrendPoint = Readonly<
  NonNullable<z.infer<typeof socialPortfolioSchema>["trend"]>["points"][number]
>;

/**
 * The gold card's 30-day line (OA-25 Q16). `points` holds the valued days
 * from the newest one back 30 days, oldest first, a skipped day left out;
 * empty until the account has a month of snapshots. `change_bps` is the
 * newest value over the one 30 days before, minus one, in basis points
 * (signed integer text); null with no points, or when the earlier value is
 * zero.
 */
export type PortfolioTrend = Readonly<NonNullable<z.infer<typeof socialPortfolioSchema>["trend"]>>;

/** No line: fewer than a month of daily snapshots. */
export const NO_PORTFOLIO_TREND: PortfolioTrend = Object.freeze({
  days: PORTFOLIO_TREND_DAYS,
  points: [],
  change_bps: null,
});

/**
 * Redesign data gap 13: the portfolio chart's ranges over the daily
 * snapshots (0097). `1w` and `1m` follow the gold card's rule for 7 and 30
 * days: shown once the newest valued day is today or yesterday (UTC) and the
 * day 7 (or 30) before it is valued too, its points the valued days between.
 * `all` is every valued day kept (`PORTFOLIO_HISTORY_MAX_DAYS`), shown once
 * there are two and the newest is today or yesterday; its change runs from
 * the oldest. A skipped day is a gap, never filled. `1D` is not a range: one
 * snapshot is taken per day (the line is never today's holdings at old
 * prices), so a day's move is the live portfolio's `today`.
 *
 * - `GET /api/social/me/portfolio/history?range=`: the owner's whole history.
 *   Account required, `private, no-store`.
 * - `GET /api/social/profiles/{callsign}/portfolio/history?range=`: a public
 *   portfolio's, only the days since it became public, refused as
 *   `portfolio_private` otherwise, as `/portfolio` is.
 */
export const PORTFOLIO_HISTORY_RANGES = ["1w", "1m", "all"] as const;
export type PortfolioHistoryRange = (typeof PORTFOLIO_HISTORY_RANGES)[number];
export const PORTFOLIO_HISTORY_DAYS: Readonly<
  Record<Exclude<PortfolioHistoryRange, "all">, number>
> = Object.freeze({ "1w": 7, "1m": PORTFOLIO_TREND_DAYS });
/** The snapshots' retention (0097's worker step): `all` reads no further back. */
export const PORTFOLIO_HISTORY_MAX_DAYS = 400;
export const SOCIAL_PORTFOLIO_HISTORY_ROUTE = "GET /api/social/me/portfolio/history";
export const SOCIAL_PORTFOLIO_HISTORY_PATH = "/api/social/me/portfolio/history";
export const SOCIAL_PUBLIC_PORTFOLIO_HISTORY_ROUTE =
  "GET /api/social/profiles/{callsign}/portfolio/history";
export type PortfolioHistory = Readonly<z.infer<typeof socialPortfolioHistorySchema>>;

/** `GET …/portfolio/history` for a range: the owner's, or with `callsign` a public portfolio's. */
export function socialPortfolioHistoryPath(
  range: PortfolioHistoryRange,
  callsign?: string,
): string {
  const base =
    callsign === undefined
      ? SOCIAL_PORTFOLIO_HISTORY_PATH
      : `/api/social/profiles/${encodeURIComponent(callsign)}/portfolio/history`;
  return `${base}?range=${range}`;
}

export const PORTFOLIO_COINS_PAGE_SIZE = 20;
export const SOCIAL_PORTFOLIO_COINS_PATH = "/api/social/me/portfolio/coins";

/**
 * GET `/me/portfolio/coins?page=1&q=`: twenty positive holdings including cash.
 * Search is literal and case-insensitive across name, symbol and coin type, before pagination.
 * USD descending, unknown prices last, coin type breaks ties. USDC counts at face value.
 * Pages clamp to the last result page.
 * Verified account wallets only, private/no-store; unavailable reads return 503.
 */
export type PortfolioCoinPage = Readonly<z.infer<typeof portfolioCoinPageSchema>>;

/** Non-cash aggregate, independent of the displayed page; no chart series. */
export type PortfolioCoinSummary = Readonly<
  NonNullable<z.infer<typeof socialPortfolioSchema>["coin_summary"]>
>;

export type SocialPortfolio = Readonly<z.infer<typeof socialPortfolioSchema>>;

/**
 * Another account's portfolio, by its owner's choice (owner decision OA-10):
 * `GET /api/social/profiles/{callsign}/portfolio`, the same body as
 * `/me/portfolio` (`SocialPortfolio`, schema `portfolio-response`).
 *
 * - No authentication (the Authorization header is never read), bucket
 *   `social_read_portfolio` (IP), read on the replica. A 200 is shared at the edge for
 *   10 s and never served stale (`public, s-maxage=10`, OA-30, amending
 *   R3-32-AC-7, cost basis included), so a portfolio its owner makes private
 *   may be served from a shared cache for up to 10 s. Errors are `no-store`.
 * - Answered only while the owner's "Public portfolio" setting is on and the
 *   account is public; otherwise `403 portfolio_private`.
 * - `trend` shows only the days since the portfolio last became public (the
 *   owner's answer of 2026-10-06): turning it off, or the account going
 *   private, and opting in again starts a new public history. A callsign no Blast
 *   Account holds is `404 not_found`; a malformed one is `400
 *   invalid_parameter`. The answer names no wallet address.
 */
export const SOCIAL_PUBLIC_PORTFOLIO_ROUTE = "GET /api/social/profiles/{callsign}/portfolio";

/** `GET` path of another account's public portfolio. */
export function socialPublicPortfolioPath(callsign: string): string {
  return `/api/social/profiles/${encodeURIComponent(callsign)}/portfolio`;
}

// Scoped metadata retains this document's definitions and descriptions during generation.
export const portfolioSchemaMetadata = z.registry<z.core.JSONSchemaMeta>();

export const portfolioAtomsSchema = z
  .string()
  .regex(/^(0|[1-9][0-9]*)$/)
  .register(portfolioSchemaMetadata, { id: "atoms" });

export const portfolioUsdSchema = z
  .string()
  .regex(/^(0|[1-9][0-9]*)\.[0-9]{2}$/)
  .register(portfolioSchemaMetadata, { id: "usd" });

export const portfolioBasisUsdSchema = z
  .xor([z.null(), portfolioUsdSchema])
  .register(portfolioSchemaMetadata, {
    description:
      "R3-32: USD paid for the sale coin held now (average cost, at each acquisition's event time); the known part when basis_complete is false; null when nothing was acquired or nothing of it is known.",
    id: "basis_usd",
  });

export const portfolioBasisCompleteSchema = z.boolean().register(portfolioSchemaMetadata, {
  description:
    "R3-32: false when part of what is held came with no priced acquisition (a transfer in, an airdrop, a reward, a vesting claim, an unpriced commit or trade), or the basis could not be read.",
  id: "basis_complete",
});

export const portfolioPnlUsdSchema = z
  .xor([z.null(), z.string().regex(/^-?(0|[1-9][0-9]*)\.[0-9]{2}$/)])
  .register(portfolioSchemaMetadata, {
    description:
      "R3-32: value - basis at the coin's fresh price, signed; null when the basis is zero or unknown, or without a price.",
    id: "pnl_usd",
  });

export const portfolioPnlMultipleSchema = z
  .xor([z.null(), z.string().regex(/^(0|[1-9][0-9]*)\.[0-9]{4}$/)])
  .register(portfolioSchemaMetadata, {
    description: "R3-32: value / basis, four places; null with pnl_usd.",
    id: "pnl_multiple",
  });

export const portfolioAmountSchema = z
  .strictObject({
    atoms: portfolioAtomsSchema,
    usd_subcent: z.number().gt(0).optional(),
    usd: z.xor([z.null(), portfolioUsdSchema]),
  })
  .register(portfolioSchemaMetadata, { id: "amount" });

export const portfolioPositionSchema = z
  .strictObject({
    presale_id: z.string().regex(SUI_OBJECT_ID_PATTERN),
    symbol: z.string(),
    commitment: portfolioAtomsSchema,
    status: z.enum(PORTFOLIO_POSITION_STATUSES),
    claimed_tokens: z.xor([z.null(), portfolioAtomsSchema]),
    claimed_quote_refund: z.xor([z.null(), portfolioAtomsSchema]),
    quote_symbol: z.string(),
    quote_decimals: z
      .number()
      .min(0)
      .max(255)
      .refine(Number.isInteger)
      .register(portfolioSchemaMetadata, { type: "integer" }),
    sale_decimals: z
      .number()
      .min(0)
      .max(255)
      .refine(Number.isInteger)
      .register(portfolioSchemaMetadata, { type: "integer" }),
    basis_usd: portfolioBasisUsdSchema,
    basis_complete: portfolioBasisCompleteSchema,
    pnl_usd: portfolioPnlUsdSchema,
    pnl_multiple: portfolioPnlMultipleSchema,
  })
  .register(portfolioSchemaMetadata, { id: "position" });

export const portfolioCoinSchema = z
  .strictObject({
    coin_type: z.string().regex(/^0x[0-9a-f]+::[^:]+::[^:]+/),
    symbol: z.string(),
    name: z.string().nullable().optional(),
    decimals: z
      .number()
      .min(0)
      .max(255)
      .refine(Number.isInteger)
      .register(portfolioSchemaMetadata, { type: "integer" })
      .nullable()
      .optional(),
    icon_url: z.string().nullable().optional(),
    presale_id: z.string().nullable().optional(),
    verified_team: z
      .boolean()
      .register(portfolioSchemaMetadata, {
        description: "R3-23: Blast checked who is behind the coin (social_sale_trust for a sale, social_coin_trust for a bonding-curve coin); sent only when true.",
      })
      .optional(),
    balance: z.string().regex(/^[1-9][0-9]*$/),
    value_usd: z.xor([z.null(), portfolioUsdSchema]),
    value_usd_exact: z
      .string()
      .regex(/^(0|[1-9][0-9]*)(\.[0-9]+)?$/)
      .nullable()
      .optional(),
    basis_usd: portfolioBasisUsdSchema,
    basis_complete: portfolioBasisCompleteSchema,
    pnl_usd: portfolioPnlUsdSchema,
    pnl_multiple: portfolioPnlMultipleSchema,
  })
  .register(portfolioSchemaMetadata, { id: "coin" });

export const socialPortfolioSchema = z
  .strictObject({
    coin_summary: z
      .strictObject({
        value_usd: z.xor([z.null(), portfolioUsdSchema]),
        has_priced_holdings: z.boolean().optional(),
        known_value_usd: portfolioUsdSchema,
        known_value_usd_exact: z.number().gt(0).optional(),
        today: z.xor([
          z.null(),
          z.strictObject({
            usd: z.number(),
            pct: z.number(),
          }),
        ]),
      })
      .optional(),
    wallet_sync: z
      .strictObject({
        status: z.enum(["ready", "syncing", "stale"]),
        checkpoint: z
          .string()
          .regex(/^(0|[1-9][0-9]*)$/)
          .nullable(),
        as_of_ms: z
          .number()
          .min(0)
          .refine(Number.isInteger)
          .register(portfolioSchemaMetadata, { type: "integer" })
          .nullable(),
      })
      .optional(),
    balances: z.xor([
      z.null(),
      z.strictObject({
        sui: portfolioAmountSchema,
        usdc: portfolioAmountSchema,
      }),
    ]),
    positions: z.xor([z.null(), z.array(portfolioPositionSchema).readonly()]),
    commitments: z
      .xor([
        z.null(),
        z.strictObject({
          has_priced_holdings: z.boolean().optional(),
          committed_usd_subcent: z.number().gt(0).optional(),
          claimable_usd_subcent: z.number().gt(0).optional(),
          committed_usd: z.xor([z.null(), portfolioUsdSchema]),
          claimable_usd: z.xor([z.null(), portfolioUsdSchema]),
          known_committed_usd: portfolioUsdSchema
            .clone()
            .register(portfolioSchemaMetadata, {
              description:
                "Priced components when the committed category is incomplete; never a complete total.",
            })
            .optional(),
          known_claimable_usd: portfolioUsdSchema
            .clone()
            .register(portfolioSchemaMetadata, {
              description:
                "Priced components when the claimable category is incomplete, including independently priced refunds or tokens.",
            })
            .optional(),
        }),
      ])
      .register(portfolioSchemaMetadata, {
        description:
          "R3-40: the gold card's Committed and Claimable in dollars over every quote's positions (USDC at face value, SUI at its price at most 120 s old), summed exactly and rounded once to cents; a part null when a position in it cannot be valued. Null with positions.",
      }),
    coins: z
      .xor([z.null(), z.array(portfolioCoinSchema).readonly()])
      .register(portfolioSchemaMetadata, {
        description:
          "Presale sale coins with a positive balance in any of the account's wallets, summed, largest value first; value_usd null without a price at most 120 s old. Null (and listed) when it cannot be read.",
      }),
    vesting: z
      .xor([
        z.null(),
        z.strictObject({
          has_schedule: z.boolean(),
          href: z.xor([
            z.null(),
            z
              .string()
              .regex(/^(\/portfolio\/vestings|https:\/\/[^\s\/?#@:]+(\/[^\s#]*)?)$/)
              .max(512),
          ]),
        }),
      ])
      .register(portfolioSchemaMetadata, {
        description:
          "The vesting entry includes presale allocations across linked wallets and utility schedules receiving or created by the authenticated active wallet. Owner href is /portfolio/vestings; public portfolios retain the paying sale website or null. Null (and listed) when the schedules cannot be read.",
      }),
    totals: z.xor([
      z.null(),
      z.strictObject({
        people: z
          .number()
          .min(0)
          .refine(Number.isInteger)
          .register(portfolioSchemaMetadata, { type: "integer" }),
        volume_usd: portfolioUsdSchema,
      }),
    ]),
    trend: z
      .xor([
        z.null(),
        z.strictObject({
          days: z.literal(30),
          points: z
            .array(
              z.strictObject({
                day: z.string().regex(/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/),
                value_usd: portfolioUsdSchema,
              }),
            )
            .max(31)
            .readonly(),
          change_bps: z.xor([z.null(), z.string().regex(/^(0|-?[1-9][0-9]*)$/)]),
        }),
      ])
      .register(portfolioSchemaMetadata, {
        description:
          "OA-25 Q16: the gold card's 30-day line from the account's daily portfolio-value snapshots. points: the valued days from the newest back 30 days, oldest first (a skipped day left out); empty until the newest valued day is today or yesterday (UTC) and the day 30 days before it is valued too. change_bps: newest / 30 days before - 1, in basis points, signed; null without points or when the earlier value is zero. On the public read (OA-10) the window starts at the UTC day the portfolio last became public. Null (and listed) when the snapshots cannot be read.",
      }),
    prices_as_of_ms: z.xor([
      z.null(),
      z
        .number()
        .min(0)
        .refine(Number.isInteger)
        .register(portfolioSchemaMetadata, { type: "integer" }),
    ]),
    unavailable: z
      .array(z.enum(["balances", "positions", "coins", "vesting", "totals", "trend"]))
      .refine((values) => new Set(values).size === values.length)
      .readonly()
      .register(portfolioSchemaMetadata, { uniqueItems: true }),
  })
  .register(portfolioSchemaMetadata, {
    title: "Owner-only portfolio",
    description:
      "GET /api/social/me/portfolio 200 (private, no-store): the caller's own balances, presale positions, sale coins held, vesting link and attribution totals, each position and coin with its cost basis and P&L (R3-32), and the gold card's 30-day trend (OA-25 Q16). A part is null exactly when it is listed in unavailable.",
  });

// Scoped metadata retains this document's definitions and descriptions during generation.
export const portfolioHistorySchemaMetadata = z.registry<z.core.JSONSchemaMeta>();

export const socialPortfolioHistorySchema = z
  .strictObject({
    range: z.enum(PORTFOLIO_HISTORY_RANGES),
    points: z
      .array(
        z.strictObject({
          day: z.string().regex(/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/),
          value_usd: z.string().regex(/^(0|[1-9][0-9]*)\.[0-9]{2}$/),
        }),
      )
      .max(400)
      .readonly(),
    change_bps: z.xor([z.null(), z.string().regex(/^(0|-?[1-9][0-9]*)$/)]),
  })
  .register(portfolioHistorySchemaMetadata, {
    title: "Portfolio history response",
    description:
      "Redesign gap 13 (contracts/portfolio.ts PortfolioHistory): one range of the portfolio chart from the daily snapshots (0097); empty points while the range is not covered.",
  });

/**
 * Paged holdings omit cost basis and can include a preferred coin with a zero balance.
 * `launch_id`: a Blast bonding-curve launch's id (its `/coin/<launch_id>` page, any lifecycle);
 * null for a presale token (it has `presale_id`) and for any coin Blast did not launch.
 */
export const portfolioCoinPageRowSchema = portfolioCoinSchema.omit({
  basis_usd: true,
  basis_complete: true,
  pnl_usd: true,
  pnl_multiple: true,
}).extend({ balance: portfolioAtomsSchema, launch_id: z.string().nullable().optional() });

export const portfolioCoinPageSchema = z.strictObject({
  coins: z.array(portfolioCoinPageRowSchema).readonly(),
  total: z.number().int().nonnegative(),
  page: z.number().int().positive(),
  page_size: z.literal(PORTFOLIO_COINS_PAGE_SIZE),
  /** Whether linked wallets hold positive balances before search or visibility filters. */
  wallet_has_coins: z.boolean().optional(),
}).refine(({ coins, total, page, page_size }) =>
  page <= Math.max(1, Math.ceil(total / page_size))
  && coins.length === Math.min(page_size, Math.max(0, total - (page - 1) * page_size)));
