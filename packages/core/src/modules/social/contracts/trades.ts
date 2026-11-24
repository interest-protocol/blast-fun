import {
  socialCoinTypeSchema,
  socialPositiveAtomsSchema,
} from "./primitives.ts";
import {
  financialAddressSchema,
  financialUuidSchema,
  financialRequestIdSchema,
  financialAtomsSchema,
  financialPositiveAtomsSchema,
  financialDigestSchema,
  financialBase64Schema,
  financialCoinTypeSchema,
  financialDecimalSchema,
  financialIconUrlSchema,
  financialUsdSchema,
  financialIntegerSchema,
  financialTextSchema,
  type FinancialReadonly,
} from "./financial-wire.ts";
import { z } from "zod";
/**
 * Trading (social feed R3-30; FEATURE-MAP-R3 §14.1 the coins sheet's swap and
 * transaction detail, §15.7.5 Blast mode's trade composer).
 *
 * Swaps are routed by the **Cetus aggregator** (`@cetusprotocol/aggregator-sdk`,
 * OA-25 Q1/Q11), which routes across every Cetus and Bluefin pool, the venues
 * Blast sales migrate to; a sale in an Aftermath DAO-fee pool is swapped in
 * that pool directly (`SOCIAL_TRADE_VENUES`). Every quote figure — route,
 * amounts, minimum, fees, price impact — is the aggregator's, or for a
 * DAO-fee leg the pool's own state on the fullnode (OA-27; a sale coin's
 * impact is its route dry-run twice, OA-29); blast-infra publishes no pool
 * data, and only the displayed USD prices are R3-20's. A quote shown is the aggregator's route; a quote
 * **offered** (one with a `quote_id`, which R3-31's swap path executes) has
 * also been dry-run on Sui mainnet from the caller's own Blast wallet first.
 *
 * Amounts are atoms, exact integers as decimal strings, end to end.
 */

import { isValidStructTag, normalizeStructTag } from "@mysten/sui/utils";
import { SUI_COIN_TYPE, USDC_COIN_TYPE } from "@blast/core/lib/sui/coin-types.ts";

/** `POST /api/social/trades/quote`: what a trade would get, and, signed in, an executable quote. */
export const SOCIAL_TRADE_QUOTE_ROUTE = "POST /api/social/trades/quote";
export const SOCIAL_TRADE_QUOTE_PATH = "/api/social/trades/quote";
/** Minimum wait before retrying overloaded quote work. */
export const SOCIAL_TRADE_QUOTE_BUSY_RETRY_SECONDS = 5;
/** Quotes one API process runs at once (the private quote lane's running slots); as many more may wait. */
export const SOCIAL_TRADE_QUOTE_WORKERS = 2;

/** `buy` spends USDC or SUI on a coin; `sell` turns a coin into USDC or SUI. Logged as `trade_buy` / `trade_sell`. */
export const SOCIAL_TRADE_SIDES = ["buy", "sell"] as const;
export type SocialTradeSide = (typeof SOCIAL_TRADE_SIDES)[number];

/** How long a `quote_id` can be executed after it is issued. */
export const SOCIAL_TRADE_QUOTE_TTL_MS = 20_000;
/** The default slippage, the gate's `Auto · 0.5%`. */
export const SOCIAL_TRADE_DEFAULT_SLIPPAGE_BPS = 50;
/** The slippage a caller may ask for: 0.01% to 5%. */
export const SOCIAL_TRADE_MIN_SLIPPAGE_BPS = 1;
export const SOCIAL_TRADE_MAX_SLIPPAGE_BPS = 500;
/** The largest u64, the most atoms any amount can be. */
export const SOCIAL_TRADE_ATOMS_MAX = 18_446_744_073_709_551_615n;

/**
 * The venues the in-app trade reaches: a Blast sale migrated to Cetus or
 * Bluefin, routed by the Cetus aggregator, or through the Aftermath DAO-pool
 * vendor (contracts ADR 0104), whose coin trades only in its Aftermath
 * DAO-fee pool. The aggregator does not route that pool, so the trade path
 * calls the pool's wrapper directly (`trades/aftermath.ts`), with USDC or SUI
 * that is not the pool's own quote coin converted through the aggregator; the
 * quote, dry run, Blast's fee, slippage, sponsorship and receipt are the same
 * as on Cetus and Bluefin.
 */
export const SOCIAL_TRADE_VENUES = ["cetus", "bluefin", "aftermath"] as const;

/** Whether a sale migrated to `venue` (as `chain_read_v1.presales.venue` names it) trades in the app. */
export function tradesInApp(venue: string | null | undefined): boolean {
  return z
    .string()
    .toLowerCase()
    .pipe(z.enum(SOCIAL_TRADE_VENUES))
    .safeParse(venue).success;
}

/**
 * Why no quote exists, as a published code. A quote with a reason carries no
 * numbers at all (`amount_out`, `min_out`, impact and fee are null and the
 * route is empty):
 *
 * - `not_tradable`: a coin is not USDC, SUI or the coin of a Blast sale that
 *   has migrated (trading); blast-infra does not track it.
 * - `no_pool`: the aggregator finds no pool path between the two coins, or
 *   not enough liquidity for the amount.
 * - `pool_unavailable`: the aggregator could not be asked (unreachable,
 *   refusing, or an answer this service cannot use).
 * - `dry_run_failed`: the route did not execute in its dry run on Sui.
 */
export const SOCIAL_TRADE_UNAVAILABLE_REASONS = [
  "not_tradable",
  "no_pool",
  "pool_unavailable",
  "dry_run_failed",
] as const;
export type SocialTradeUnavailableReason =
  (typeof SOCIAL_TRADE_UNAVAILABLE_REASONS)[number];

/**
 * Why a priced quote is not offered (no `quote_id`), as a published code. The
 * numbers are the aggregator's route and are shown; they are not executable:
 *
 * - `sign_in`: the caller is signed out (the gate's `KSTL is $0.002100` state).
 * - `account_required`: signed in without a Blast Account.
 * - `blast_wallet_missing`: the account's Blast wallet does not exist yet.
 * - `insufficient_balance`: the Blast wallet holds less of `in_coin` than
 *   `amount_in`, or lacks native SUI for a wallet-paid gas budget. `balance_failure` identifies the check.
 */
export const SOCIAL_TRADE_OFFER_REFUSALS = [
  "sign_in",
  "account_required",
  "blast_wallet_missing",
  "insufficient_balance",
] as const;
export type SocialTradeOfferRefusal =
  (typeof SOCIAL_TRADE_OFFER_REFUSALS)[number];

/**
 * Why a priced quote shows no price impact, as a published code (OA-29). The
 * aggregator has no market price for a new Blast sale coin, so its impact is
 * measured by a second dry run of the same route at a reference size; when
 * that cannot happen the impact is null and says why, and nothing is guessed:
 *
 * - `no_dry_run`: the quote was not dry-run (signed out, no account or Blast
 *   wallet, or the wallet is short of the input), so there is no reference.
 * - `too_small`: the trade is too small to measure: a reference above
 *   rounding (100,000 atoms in and expected out) would be more than a tenth of
 *   it, or would leave a leg of its route empty.
 * - `reference_failed`: the reference dry run did not execute (an abort, the
 *   fullnode), or either dry run's output could not be read.
 */
export const SOCIAL_TRADE_IMPACT_UNAVAILABLE = [
  "no_dry_run",
  "too_small",
  "reference_failed",
] as const;
export type SocialTradeImpactUnavailable =
  (typeof SOCIAL_TRADE_IMPACT_UNAVAILABLE)[number];

/**
 * The closed request body. Exactly one of `amount_in` (sell exactly this
 * much) and `amount_out` (get at least about this much; quoted as the exact
 * input that buys it) is present; `slippage_bps` defaults to 50.
 */
export const socialTradeQuoteRequestSchema = z
  .strictObject({
    in_coin: financialCoinTypeSchema,
    out_coin: financialCoinTypeSchema,
    side: z.enum(SOCIAL_TRADE_SIDES),
    amount_in: financialPositiveAtomsSchema.optional(),
    amount_out: financialPositiveAtomsSchema.optional(),
    slippage_bps: financialIntegerSchema
      .min(1)
      .max(500)
      .meta({ type: "integer" })
      .optional(),
  })
  .refine(hasOneQuoteAmount)
  .meta({
    title: "Quote a trade",
    description:
      "POST /api/social/trades/quote: the coins, the side and exactly one amount in atoms (amount_in: sell exactly this; amount_out: get about this, quoted as the exact input that buys it), and an optional slippage (default 50 bps).",
  });

export type SocialTradeQuoteRequest = FinancialReadonly<
  z.infer<typeof socialTradeQuoteRequestSchema>
>;

/** One pool along the route, in the order the swap crosses it. Split routes list each leg. */
export const socialTradeHopSchema = z.strictObject({
  pool_id: financialAddressSchema,
  venue: z.string().regex(/^[a-z0-9_]{1,32}$/),
  in_coin: financialCoinTypeSchema,
  out_coin: financialCoinTypeSchema,
  amount_in: financialAtomsSchema,
  amount_out: financialAtomsSchema,
});

export type SocialTradeHop = FinancialReadonly<
  z.infer<typeof socialTradeHopSchema>
>;

/** The wallet balance that actually prevented preparation, in coin atoms. */
export const socialTradeBalanceFailureSchema = z.strictObject({
  reason: z.enum(["input", "gas"]),
  coin_type: financialTextSchema({ minLength: 8, maxLength: 512 }),
  required_atoms: financialAtomsSchema,
  available_atoms: financialAtomsSchema,
});

export type SocialTradeBalanceFailure = FinancialReadonly<
  z.infer<typeof socialTradeBalanceFailureSchema>
>;

/** The fee estimate and the SUI budget required to prepare wallet-paid bytes. */
export type TradeFeeRequired = Readonly<{
  status: "fee_required";
  feeMist: string;
  requiredMist?: string;
  payable?: boolean;
  message?: string;
}>;

export const TRADE_MIN_GAS_BUDGET_MIST = 2_000_000n;

/** The wallet must fund the whole gas budget, even when the eventual fee is smaller. */
export function walletTradeGasBudget(gas: bigint): bigint {
  const padded = (gas * 6n + 4n) / 5n;
  return padded < TRADE_MIN_GAS_BUDGET_MIST
    ? TRADE_MIN_GAS_BUDGET_MIST
    : padded;
}

/** Who pays the network fee of the executed trade, and the gate's words for it. */
export const socialTradeNetworkFeeSchema = z.strictObject({
  payer: z.enum(["blast", "wallet"]),
  label: z.enum(["Paid by Blast", "Paid from your SUI"]),
  estimate_mist: financialAtomsSchema.nullable(),
});

export type SocialTradeNetworkFee = FinancialReadonly<
  z.infer<typeof socialTradeNetworkFeeSchema>
>;

export const socialTradeQuoteSchema = z
  .strictObject({
    balance_failure: socialTradeBalanceFailureSchema.nullable().optional(),
    quote_id: z
      .string()
      .regex(/^q1\.[A-Za-z0-9_-]{16,2997}$/)
      .nullable(),
    expires_at_ms: financialIntegerSchema
      .min(0)
      .meta({ type: "integer" })
      .nullable(),
    quoted_at_ms: financialIntegerSchema.min(0).meta({ type: "integer" }),
    side: z.enum(SOCIAL_TRADE_SIDES),
    in_coin: financialCoinTypeSchema,
    out_coin: financialCoinTypeSchema,
    amount_in: financialAtomsSchema.nullable(),
    amount_out: financialAtomsSchema.nullable(),
    min_out: financialAtomsSchema.nullable(),
    slippage_bps: financialIntegerSchema
      .min(1)
      .max(500)
      .meta({ type: "integer" }),
    price_impact_bps: financialIntegerSchema
      .min(0)
      .max(10000)
      .meta({ type: "integer" })
      .nullable()
      .describe(
        "The aggregator's deviation from its market price net of the route's fees; where it has none (a Blast sale coin), for a dry-run quote, 1 - (amount_out/amount_in) / (reference out/reference in) from a second dry run of the same route at a reference size (OA-29), rounded half up. Otherwise null: price_impact_unavailable says why, or the quote is unavailable.",
      ),
    price_impact_unavailable: z
      .enum(SOCIAL_TRADE_IMPACT_UNAVAILABLE)
      .nullable()
      .describe(
        "Why price_impact_bps is null (OA-29): no_dry_run (the quote was not dry-run, so there is no reference run), too_small (a reference above rounding would be more than a tenth of the trade), reference_failed (the reference dry run did not execute or an output could not be read). Null when the impact is set and when the quote is unavailable.",
      ),
    fee_bps: financialIntegerSchema
      .min(0)
      .max(10000)
      .meta({ type: "integer" })
      .nullable(),
    fee_amount: financialAtomsSchema.nullable(),
    blast_fee_bps: financialIntegerSchema
      .min(0)
      .max(1000)
      .meta({ type: "integer" })
      .nullable()
      .describe(
        "Blast's app fee in basis points of the swap's output (BLAST_TRADE_FEE_BPS), taken from the output coin inside the swap; amount_out and min_out are net of it. 0 when Blast charges none; null only with unavailable_reason.",
      ),
    blast_fee_amount: financialAtomsSchema
      .nullable()
      .describe(
        "Blast's fee in atoms of out_coin at the quoted fill; null only with unavailable_reason.",
      ),
    route: z.array(socialTradeHopSchema).max(8),
    route_label: financialTextSchema({
      minLength: 1,
      maxLength: 300,
    }).nullable(),
    price_per_out: financialDecimalSchema.nullable(),
    amount_in_usd: financialUsdSchema.nullable(),
    amount_out_usd: financialUsdSchema.nullable(),
    network_fee: z.xor([z.null(), socialTradeNetworkFeeSchema]),
    dry_run: z.enum(["passed", "not_run"]),
    offer_refused: z.enum(SOCIAL_TRADE_OFFER_REFUSALS).nullable(),
    unavailable_reason: z.enum(SOCIAL_TRADE_UNAVAILABLE_REASONS).nullable(),
  })
  .meta({
    title: "A trade quote",
    description:
      "POST /api/social/trades/quote 200 (private, no-store): the Cetus aggregator's route and its numbers in atoms (a sale coin's price impact from a second dry run of that route at a reference size, OA-29); quote_id only when the route was dry-run from the caller's own Blast wallet (R3-31 executes it within 20 s); unavailable_reason with no numbers when there is no quote.",
  });

export type SocialTradeQuote = FinancialReadonly<
  z.infer<typeof socialTradeQuoteSchema>
>;

/** The coin types every quote may use besides the coins of trading Blast sales. */
export const SOCIAL_TRADE_BASE_COINS = Object.freeze({
  sui: SUI_COIN_TYPE,
  usdc: USDC_COIN_TYPE,
});

/**
 * `POST /api/social/trades` (R3-31): builds the trade a quote offered, for the
 * caller's Blast wallet to sign. Account required, bucket `social_intent`,
 * `private, no-store`. The closed body is the quote's own numbers, which must
 * match it exactly (the client cannot widen its slippage), and the client's
 * key for this trade; `accept_fee: true` asks for a trade the wallet pays the
 * fee of when Blast will not sponsor it.
 *
 * - 201: built now (`status: "built"`, the bytes to sign) or refused now
 *   (`status: "failed"` with its code; nothing was built or sent);
 * - 200: this key was already answered: the first answer, never a second build;
 * - 409 `trade_conflict`: this key was used for another quote;
 * - 409 `sponsorship_unavailable` with `fee_mist`: Blast will not pay the fee
 *   today (the daily cap, or the sponsor is down); send again with
 *   `accept_fee: true` to pay it from the wallet's SUI. Nothing is recorded.
 *
 * Refusals that record a failed trade answer 201 with `status: "failed"` and
 * `failure_code` one of `quote_expired`, `price_moved`, `insufficient_balance`
 * and `pool_unavailable`; the trade is logged (R3-27) as failed with it.
 */
export const SOCIAL_TRADE_ROUTE = "POST /api/social/trades";
export const SOCIAL_TRADES_PATH = "/api/social/trades";

/**
 * `POST /api/social/trades/{trade_id}/settle` (R3-31): settles a built trade
 * from the chain by its digest. Account required (the trade's own), bucket
 * `social_transfer`, `private, no-store`. 200 with the trade: `confirmed`
 * with what filled, `failed` with `execution_failed` (it aborted on Sui) or
 * `expired` (it never landed before its bytes expired), or still `built`
 * while the chain does not show it (ask again shortly).
 */
export const SOCIAL_TRADE_SETTLE_ROUTE =
  "POST /api/social/trades/{trade_id}/settle";

export function socialTradeSettlePath(tradeId: string): string {
  return `/api/social/trades/${encodeURIComponent(tradeId)}/settle`;
}

export const socialTradeRequestSchema = z
  .strictObject({
    quote_id: z.string().regex(/^q1\.[A-Za-z0-9_-]{16,2997}$/),
    amount_in: financialPositiveAtomsSchema,
    min_out: financialAtomsSchema,
    idempotency_key: financialRequestIdSchema,
    accept_fee: z.boolean().optional(),
  })
  .meta({
    title: "Build a trade",
    description:
      "POST /api/social/trades: an offered quote's id with its own amount_in and min_out (which must match it), the client's key for this trade (a UUID v4, resent on every retry), and accept_fee to pay the network fee from the wallet when Blast will not sponsor it.",
  });

export type SocialTradeRequest = FinancialReadonly<
  z.infer<typeof socialTradeRequestSchema>
>;

/** Why a trade ended without filling, as a published code. */
export const SOCIAL_TRADE_FAILURES = [
  "quote_expired",
  "price_moved",
  "insufficient_balance",
  "pool_unavailable",
  "execution_failed",
  "expired",
] as const;
export type SocialTradeFailure = (typeof SOCIAL_TRADE_FAILURES)[number];

export const SOCIAL_TRADE_STATUSES = ["built", "confirmed", "failed"] as const;
export type SocialTradeStatus = (typeof SOCIAL_TRADE_STATUSES)[number];

export const socialTradeSchema = z
  .strictObject({
    balance_failure: socialTradeBalanceFailureSchema.nullable().optional(),
    trade_id: financialUuidSchema,
    status: z.enum(SOCIAL_TRADE_STATUSES),
    side: z.enum(SOCIAL_TRADE_SIDES),
    in_coin: financialCoinTypeSchema,
    out_coin: financialCoinTypeSchema,
    amount_in: financialAtomsSchema,
    amount_out: financialAtomsSchema,
    min_out: financialAtomsSchema,
    amount_out_filled: financialAtomsSchema.nullable(),
    route_label: financialTextSchema({
      minLength: 1,
      maxLength: 300,
    }).nullable(),
    network_fee: z.xor([
      z.null(),
      socialTradeNetworkFeeSchema.omit({ estimate_mist: true }),
    ]),
    reservation_id: financialUuidSchema.nullable(),
    transaction_bytes: financialBase64Schema.nullable(),
    digest: financialDigestSchema.nullable(),
    expires_at_ms: financialIntegerSchema
      .min(0)
      .meta({ type: "integer" })
      .nullable(),
    failure_code: z.enum(SOCIAL_TRADE_FAILURES).nullable(),
    created_at_ms: financialIntegerSchema.min(0).meta({ type: "integer" }),
    settled_at_ms: financialIntegerSchema
      .min(0)
      .meta({ type: "integer" })
      .nullable(),
  })
  .meta({
    title: "A trade",
    description:
      "POST /api/social/trades (201 built or refused, 200 a replay) and POST /api/social/trades/{trade_id}/settle (200): the trade, the bytes its wallet signs while built, and how it ended (private, no-store).",
  });

export type SocialTrade = FinancialReadonly<z.infer<typeof socialTradeSchema>>;

/**
 * `GET /api/social/trades/coins` (R3-33): the coins a trade can name — the
 * coin of every sale that has migrated to its pool (the product's
 * "trading", `SHOWN_PRESALES` with `lifecycle = 'migrated'`), and on a
 * search's first page the curated ecosystem coins it names (`CORE_COINS`,
 * at most half the page); the quote route accepts both. The coins sheet's picker
 * lists them under "More coins" (the coins the viewer holds come from the
 * wallet read). Public and the same for every caller (CDN-cached, no
 * account), bucket `social_read_trade_coins`.
 *
 * Query: `q` (1 to 512 characters, a leading `$` ignored) keeps the coins
 * whose ticker or name contains it, case-insensitively; queries starting with
 * `0x` also match coin types. A complete canonical type resolves quote-eligible
 * base and indexed wallet coins as well. `limit` 1 to 50
 * (default 50); `cursor` continues a page. Ordered by ticker, then sale id
 * (keyset). With `include_launch=1`, the first page can include Blast curve
 * suggestions by name and ticker if there is room after reserving a sale slot.
 * The cursor continues sales. An exact type can resolve its launch or presale
 * page at any lifecycle. Refusals: `400 invalid_parameter` naming the bad parameter.
 */
export const SOCIAL_TRADE_COINS_ROUTE = "GET /api/social/trades/coins";
export const SOCIAL_TRADE_COINS_PATH = "/api/social/trades/coins";
export const SOCIAL_TRADE_COINS_MAX_LIMIT = 50;
export const SOCIAL_TRADE_COINS_MAX_QUERY = 512;

/** Canonical SDK tags when complete; case-insensitive text with compact addresses for partial searches. */
export function normalizeTradeCoinQuery(text: string): string {
  const query = text.trim().replace(/^\$/, "").trim();
  return isValidStructTag(query)
    ? normalizeStructTag(query)
    : query.toLowerCase().replace(/0x0+([0-9a-f])/g, "0x$1");
}

/** Coin metadata accepted by trading; the quote determines liquidity. */
export const socialTradeCoinSchema = z.strictObject({
  coin_type: financialCoinTypeSchema,
  symbol: financialTextSchema({ minLength: 1, maxLength: 64 }),
  name: financialTextSchema({ minLength: 1, maxLength: 128 }),
  decimals: financialIntegerSchema.min(0).max(255).meta({ type: "integer" }),
  icon_url: financialIconUrlSchema.nullable(),
  usd_price: financialDecimalSchema.nullable(),
  presale_id: financialAddressSchema.nullable(),
  launch_id: financialAddressSchema
    .describe("Original Blast launch ID, when requested.")
    .optional(),
  in_presale: z
    .boolean()
    .describe("An open presale, purchased through the commit flow.")
    .optional(),
  quote_symbol: financialTextSchema({ minLength: 1, maxLength: 64 }).optional(),
  quote_type: financialCoinTypeSchema.optional(),
  verified_team: z
    .boolean()
    .describe("R3-23: Blast checked who is behind the coin (social_sale_trust for a sale, social_coin_trust for a curve coin); sent only when true.")
    .optional(),
});

export type SocialTradeCoin = FinancialReadonly<
  z.infer<typeof socialTradeCoinSchema>
>;

export const socialTradeCoinPageSchema = z
  .strictObject({
    coins: z.array(socialTradeCoinSchema).max(50),
    next_cursor: financialTextSchema({ maxLength: 600 }).nullable(),
  })
  .meta({
    title: "Trading coin metadata",
    description:
      "GET /api/social/trades/coins 200 (public, CDN-cached): one keyset page of Blast sale coins, with optional curve matches, or an exact canonical coin lookup including base and indexed wallet coins. A price is optional; liquidity is resolved by quoting.",
  });

export type SocialTradeCoinPage = FinancialReadonly<
  z.infer<typeof socialTradeCoinPageSchema>
>;

/** `GET /api/social/trades/coins` with its query, for a client. */
export function socialTradeCoinsPath(
  query: Readonly<{
    q?: string | null;
    cursor?: string | null;
    limit?: number;
    includeLaunch?: boolean;
  }> = {},
): string {
  const params = new URLSearchParams();
  if (query.q) params.set("q", query.q);
  if (query.cursor) params.set("cursor", query.cursor);
  if (query.limit !== undefined) params.set("limit", String(query.limit));
  if (query.includeLaunch) params.set("include_launch", "1");
  const text = params.toString();
  return text ? `${SOCIAL_TRADE_COINS_PATH}?${text}` : SOCIAL_TRADE_COINS_PATH;
}

function hasOneQuoteAmount(body: {
  amount_in?: string;
  amount_out?: string;
}): boolean {
  return (body.amount_in === undefined) !== (body.amount_out === undefined);
}

function tradeSideMatchesCoins(body: {
  in_coin: string;
  out_coin: string;
  side: SocialTradeSide;
}): boolean {
  const isBase = (coin: string) =>
    coin === SOCIAL_TRADE_BASE_COINS.sui ||
    coin === SOCIAL_TRADE_BASE_COINS.usdc;
  return (
    body.in_coin !== body.out_coin &&
    !(isBase(body.in_coin) && !isBase(body.out_coin) && body.side !== "buy") &&
    !(!isBase(body.in_coin) && isBase(body.out_coin) && body.side !== "sell")
  );
}

/** Execution preserves the route's SDK/u64 checks and null-as-default slippage. */
export const socialTradeQuoteInputSchema = z
  .object({
    ...socialTradeQuoteRequestSchema.shape,
    in_coin: socialCoinTypeSchema,
    out_coin: socialCoinTypeSchema,
    amount_in: socialPositiveAtomsSchema.optional(),
    amount_out: socialPositiveAtomsSchema.optional(),
    slippage_bps: z
      .number()
      .int()
      .min(SOCIAL_TRADE_MIN_SLIPPAGE_BPS)
      .max(SOCIAL_TRADE_MAX_SLIPPAGE_BPS)
      .nullish(),
  })
  .refine(hasOneQuoteAmount)
  .refine(tradeSideMatchesCoins);

/** Quote-token authenticity and amount matching still run after this structural parse. */
export const socialTradeInputSchema = socialTradeRequestSchema.extend({
  quote_id: z.string().max(3000),
  amount_in: financialAtomsSchema,
});

/** The signing verifier owns byte decoding and its specific no-sign refusal. */
export const socialTradeResponseSchema = socialTradeSchema.extend({
  transaction_bytes: z.string().nullable(),
});
