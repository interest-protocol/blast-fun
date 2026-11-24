import { DISPLAY_PRICES } from "@blast/core/modules/social/prices/test-sui.ts";

import type { ReadableDatabase } from "@blast/core/modules/database/transaction.ts";
import {
  PORTFOLIO_BALANCE_DECIMALS,
  PORTFOLIO_PRICE_MAX_AGE_MS,
  type CostBasisFigures,
  type PortfolioAmount,
  type PortfolioBalanceCoin,
  type PortfolioPosition,
  type PortfolioPositionStatus,
  type PortfolioTotals,
} from "../contracts/portfolio.ts";
import { toUsd } from "../items/decimal.ts";
import { SHOWN_PRESALES, saleIsLive } from "../read-model/chain-presales.ts";
import { SUI_COIN_TYPE, USDC_COIN_TYPE } from "@blast/core/lib/sui/coin-types.ts";

/** The mainnet coin types of the balances, normalized as `chain_read_v1.prices` keys them. */
export const PORTFOLIO_COIN_TYPES: Readonly<Record<PortfolioBalanceCoin, string>> = Object.freeze({
  sui: SUI_COIN_TYPE,
  usdc: USDC_COIN_TYPE,
});

export type PortfolioPrice = Readonly<{ usd_price: string; as_of_ms: number }>;

type PriceRow = { coin_type: string; usd_price: string; as_of_ms: string };

/** The latest `chain_read_v1.prices` row of each balance coin that has one. */
export async function readPortfolioPrices(db: ReadableDatabase): Promise<Partial<Record<PortfolioBalanceCoin, PortfolioPrice>>> {
  const types = Object.values(PORTFOLIO_COIN_TYPES);
  const { rows } = await db.read<PriceRow>(
    `SELECT coin_type, usd_price::text AS usd_price, as_of_ms::text AS as_of_ms FROM ${DISPLAY_PRICES} WHERE coin_type = ANY($1::text[])`,
    [types],
  );
  const prices: Partial<Record<PortfolioBalanceCoin, PortfolioPrice>> = {};
  for (const coin of Object.keys(PORTFOLIO_COIN_TYPES) as PortfolioBalanceCoin[]) {
    const row = rows.find((candidate) => candidate.coin_type === PORTFOLIO_COIN_TYPES[coin]);
    if (row) prices[coin] = { usd_price: row.usd_price, as_of_ms: Number(row.as_of_ms) };
  }
  return prices;
}

const DECIMAL = /^(0|[1-9][0-9]*)(?:\.([0-9]+))?$/;
const ATOMS = /^(0|[1-9][0-9]*)$/;

/** Exact whole-dollar decimal, preserving priced dust without floating-point conversion. */
export function atomsToUsdExact(atoms: string, decimals: number, usdPrice: string): string | null {
  const price = DECIMAL.exec(usdPrice);
  if (!ATOMS.test(atoms) || !price || !Number.isInteger(decimals) || decimals < 0 || decimals > 255) return null;
  const fraction = price[2] ?? "";
  const product = BigInt(atoms) * BigInt(price[1] + fraction);
  const scale = decimals + fraction.length;
  if (scale === 0) return product.toString();
  const digits = product.toString().padStart(scale + 1, "0");
  const remainder = digits.slice(-scale).replace(/0+$/, "");
  return digits.slice(0, -scale) + (remainder ? `.${remainder}` : "");
}

/**
 * `atoms` (with `decimals`) at `usdPrice`, in USD to two places, rounded half
 * away from zero; null when either is not a plain non-negative decimal.
 */
export function atomsToUsd(atoms: string, decimals: number, usdPrice: string): string | null {
  const price = DECIMAL.exec(usdPrice);
  if (!ATOMS.test(atoms) || !price) return null;
  const fraction = price[2] ?? "";
  const scaled = BigInt(atoms) * BigInt(price[1] + fraction) * 1_000n;
  const divisor = 10n ** BigInt(decimals + fraction.length);
  // Thousandths of a dollar, then `toUsd` rounds them to cents.
  const mills = scaled / divisor;
  const text = mills.toString().padStart(4, "0");
  return toUsd(`${text.slice(0, -3)}.${text.slice(-3)}`);
}

/** A price fresh enough at `nowMs` to show USD: at most 120 s old. */
export function isFreshPrice(price: PortfolioPrice | undefined, nowMs: number): price is PortfolioPrice {
  return price !== undefined && Number.isFinite(price.as_of_ms) && nowMs - price.as_of_ms <= PORTFOLIO_PRICE_MAX_AGE_MS;
}

/**
 * The balances with USD, and the oldest `as_of_ms` of the prices used (null
 * when no USD is shown). A missing or stale price leaves that USD null.
 */
export function pricedBalances(
  atoms: Readonly<Record<PortfolioBalanceCoin, string>>,
  prices: Partial<Record<PortfolioBalanceCoin, PortfolioPrice>>,
  nowMs: number,
): Readonly<{ balances: Readonly<Record<PortfolioBalanceCoin, PortfolioAmount>>; pricesAsOfMs: number | null }> {
  let pricesAsOfMs: number | null = null;
  const amount = (coin: PortfolioBalanceCoin): PortfolioAmount => {
    const price = prices[coin];
    const usd = isFreshPrice(price, nowMs) ? atomsToUsd(atoms[coin], PORTFOLIO_BALANCE_DECIMALS[coin], price.usd_price) : null;
    if (usd !== null && price) pricesAsOfMs = pricesAsOfMs === null ? price.as_of_ms : Math.min(pricesAsOfMs, price.as_of_ms);
    const subcent = usd === "0.00" && price
      ? Number(atomsToUsdExact(atoms[coin], PORTFOLIO_BALANCE_DECIMALS[coin], price.usd_price))
      : 0;
    return { atoms: atoms[coin], usd, ...(subcent > 0 && Number.isFinite(subcent) ? { usd_subcent: subcent } : {}) };
  };
  const balances = { sui: amount("sui"), usdc: amount("usdc") };
  return { balances, pricesAsOfMs };
}

type PositionRow = {
  presale_id: string;
  symbol: string;
  commitment: string;
  claimed_tokens: string | null;
  claimed_quote_refund: string | null;
  all_claimed: boolean;
  lifecycle: string;
  start_ms: string;
  end_ms: string;
  quote_symbol: string;
  quote_type: string;
  quote_decimals: number;
  quote_usd_price: string | null;
  quote_price_as_of_ms: string | null;
  sale_decimals: number;
  claimable_tokens: string | null;
  claimable_quote_refund: string | null;
  sale_usd_price: string | null;
  sale_price_as_of_ms: string | null;
};

/**
 * The positions of `wallets` in presales `chain_read_v1.presales` knows,
 * one per presale (summed over the wallets), newest commit first. A claimed
 * amount is null until some wallet claimed.
 */
// JSON field reads keep older infra deployments usable, with unknown claim amounts instead of estimates.
// Keep presale lookups per wallet position; the InitPlan lets prepared reads reuse the indexed plan.
// OFFSET 0 on claim serializes each position once instead of inlining the expression four times.
const POSITIONS_SQL = `
  SELECT
    pp.presale_id,
    p.sale_symbol AS symbol,
    sum(pp.commitment)::text AS commitment,
    sum(pp.claimed_tokens)::text AS claimed_tokens,
    sum(pp.claimed_quote_refund)::text AS claimed_quote_refund,
    bool_and(pp.claim_digest IS NOT NULL) AS all_claimed,
    p.lifecycle,
    p.start_ms::text AS start_ms,
    p.end_ms::text AS end_ms,
    p.quote_symbol,
    p.quote_type,
    p.quote_decimals::int AS quote_decimals,
    qr.usd_price::text AS quote_usd_price, qr.as_of_ms::text AS quote_price_as_of_ms,
    p.sale_decimals::int AS sale_decimals,
    CASE WHEN bool_and(claim.value->>'claimable_tokens' IS NOT NULL)
      THEN sum((claim.value->>'claimable_tokens')::numeric)::text END AS claimable_tokens,
    CASE WHEN bool_and(claim.value->>'claimable_quote_refund' IS NOT NULL)
      THEN sum((claim.value->>'claimable_quote_refund')::numeric)::text END AS claimable_quote_refund,
    pr.usd_price::text AS sale_usd_price, pr.as_of_ms::text AS sale_price_as_of_ms
  FROM chain_read_v1.presale_positions pp
  CROSS JOIN LATERAL (SELECT to_jsonb(pp) AS value OFFSET 0) claim
  JOIN LATERAL (SELECT * FROM ${SHOWN_PRESALES} WHERE presale_id = pp.presale_id OFFSET 0) p ON TRUE
  LEFT JOIN ${DISPLAY_PRICES} pr ON pr.coin_type = p.sale_token
  LEFT JOIN chain_read_v1.prices qr ON qr.coin_type = p.quote_type
  WHERE pp.wallet = ANY((SELECT $1::text[])::text[])
  GROUP BY pp.presale_id, p.sale_symbol, p.lifecycle, p.start_ms, p.end_ms, p.quote_symbol, p.quote_type, p.quote_decimals, p.sale_decimals,
    pr.usd_price, pr.as_of_ms, qr.usd_price, qr.as_of_ms
  ORDER BY max(pp.last_commit_ms) DESC NULLS LAST, pp.presale_id DESC`;

/** A position's status from its presale's lifecycle at `nowMs` and whether every wallet claimed. */
export function positionStatus(
  input: Readonly<{ lifecycle: string; start_ms: number; end_ms: number; claimed: boolean }>,
  nowMs: number,
): PortfolioPositionStatus {
  if (input.claimed) return "delivered";
  if (input.lifecycle === "migrated" || input.lifecycle === "cancelled") return "claimable";
  if (saleIsLive(input, nowMs)) return "open";
  return "closed";
}

/** A position as `chain_read_v1` gives it, before its cost basis (R3-32) is added. */
export type PortfolioPositionRow = Omit<PortfolioPosition, keyof CostBasisFigures> & Readonly<{
  quote_type: string;
  quote_price: PortfolioPrice | null;
  claimable: Readonly<{
    tokens: string | null;
    quote_refund: string | null;
    sale_decimals: number;
    price: PortfolioPrice | null;
  }>;
}>;

export async function readPortfolioPositions(
  db: ReadableDatabase,
  wallets: readonly string[],
  nowMs: number,
): Promise<PortfolioPositionRow[]> {
  if (wallets.length === 0) return [];
  const { rows } = await db.read<PositionRow>(POSITIONS_SQL, [wallets]);
  return rows.map((row) => ({
    presale_id: row.presale_id,
    symbol: row.symbol,
    commitment: row.commitment,
    status: positionStatus(
      { lifecycle: row.lifecycle, start_ms: Number(row.start_ms), end_ms: Number(row.end_ms), claimed: row.all_claimed },
      nowMs,
    ),
    claimed_tokens: row.claimed_tokens,
    claimed_quote_refund: row.claimed_quote_refund,
    quote_symbol: row.quote_symbol,
    quote_type: row.quote_type,
    quote_decimals: row.quote_decimals,
    quote_price: row.quote_usd_price == null || row.quote_price_as_of_ms == null ? null : { usd_price: row.quote_usd_price, as_of_ms: Number(row.quote_price_as_of_ms) },
    sale_decimals: row.sale_decimals,
    claimable: {
      tokens: row.claimable_tokens,
      quote_refund: row.claimable_quote_refund,
      sale_decimals: row.sale_decimals,
      price: row.sale_usd_price === null || row.sale_price_as_of_ms === null ? null : { usd_price: row.sale_usd_price, as_of_ms: Number(row.sale_price_as_of_ms) },
    },
  }));
}

type TotalsRow = { people: number; volume: string };

/**
 * Across all of the owner's items: the distinct accounts with a non-voided
 * attribution to them, and the sum of those attributions' known USD values.
 */
export async function readPortfolioTotals(db: ReadableDatabase, accountId: string): Promise<PortfolioTotals> {
  const { rows } = await db.read<TotalsRow>(
    `SELECT count(DISTINCT actor_account_id)::int AS people, COALESCE(sum(usd_value), 0)::text AS volume
     FROM social_attributions
     WHERE author_account_id = $1 AND voided_at IS NULL`,
    [accountId],
  );
  const row = rows[0];
  return { people: row?.people ?? 0, volume_usd: toUsd(row?.volume ?? "0") };
}
