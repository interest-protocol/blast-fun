import { SOCIAL_PAGE_PATHS } from "@blast/core/lib/social-page-routes.ts";
import type { PublicVesting } from "@blast/core/modules/vesting/model.ts";
import { displayPriceOf } from "@blast/core/modules/social/prices/test-sui.ts";
import type { ReadableDatabase } from "@blast/core/modules/database/transaction.ts";
import type { CostBasisFigures, PortfolioCoin, PortfolioVesting } from "@blast/core/modules/social/contracts/portfolio.ts";
import { vestingMsSql, vestingStepsSql } from "@blast/core/modules/social/contracts/vesting.ts";
import { atomsToUsd, isFreshPrice, type PortfolioPrice } from "@blast/core/modules/social/portfolio/read.ts";
import { SHOWN_PRESALES } from "@blast/core/modules/social/read-model/chain-presales.ts";

/**
 * The account's sale coins and vesting schedules, from blast-infra's
 * `chain_read_v1` views: the one source of both the owner's portfolio
 * (`/me/portfolio` `coins` and `vesting`, T-020) and the profile's holdings
 * card (`/me/presales` `coins` and `vestings`, UI-06), so the gold card's
 * Tokens and the holdings card's coin rows show the same amounts and values.
 */

/** A presale sale coin the wallets hold, summed over them. */
export type SaleCoinHolding = Readonly<{
  presale_id: string;
  coin_type: string;
  symbol: string;
  decimals: number;
  /** Atoms, summed over the wallets; always positive. */
  balance: string;
  /** The coin's latest `chain_read_v1.prices` row, if any (freshness is the reader's call). */
  price: PortfolioPrice | null;
}>;

type SaleCoinRow = {
  presale_id: string;
  coin_type: string;
  symbol: string;
  decimals: number;
  balance: string;
  usd_price: string | null;
  as_of_ms: string | null;
};

/**
 * Each presale's sale coin with a positive balance in `$1` (the wallets): the
 * balances' primary key `(coin_type, owner)` per presale, then the coin's
 * price row. A sale coin is one presale's (`Currency<T>` and its treasury cap
 * are unique per type).
 */
const SALE_COINS_SQL = `
  SELECT p.presale_id, p.sale_token AS coin_type, coalesce(p.sale_symbol,'') AS symbol, p.sale_decimals::int AS decimals,
    sum(cb.balance)::text AS balance, pr.usd_price::text AS usd_price, pr.as_of_ms::text AS as_of_ms
  FROM ${SHOWN_PRESALES} p
  JOIN chain_read_v1.coin_balances cb ON cb.coin_type = p.sale_token AND cb.owner = ANY($1::text[])
  LEFT JOIN ${displayPriceOf("p.sale_token")} pr ON TRUE
  WHERE cb.balance > 0
  GROUP BY p.presale_id, p.sale_token, p.sale_symbol, p.sale_decimals, pr.usd_price, pr.as_of_ms`;

export async function readSaleCoinHoldings(db: ReadableDatabase, wallets: readonly string[]): Promise<SaleCoinHolding[]> {
  if (wallets.length === 0) return [];
  const { rows } = await db.read<SaleCoinRow>(SALE_COINS_SQL, [[...wallets]]);
  return rows.map((row) => ({
    presale_id: row.presale_id,
    coin_type: row.coin_type,
    symbol: row.symbol,
    decimals: row.decimals,
    balance: row.balance,
    price: row.usd_price === null || row.as_of_ms === null ? null : { usd_price: row.usd_price, as_of_ms: Number(row.as_of_ms) },
  }));
}

/** The holding's USD value at its price, two places; null without a price at most 120 s old at `nowMs`. */
export function saleCoinValueUsd(holding: SaleCoinHolding, nowMs: number): string | null {
  const price = holding.price ?? undefined;
  return isFreshPrice(price, nowMs) ? atomsToUsd(holding.balance, holding.decimals, price.usd_price) : null;
}

/**
 * The portfolio's `coins`, each with its cost basis (`basisOf`, R3-32):
 * largest value first (unpriced last), then by symbol and coin type.
 */
export function portfolioCoins(
  holdings: readonly SaleCoinHolding[],
  nowMs: number,
  basisOf: (presaleId: string) => CostBasisFigures,
): PortfolioCoin[] {
  return holdings
    .map((holding) => ({
      coin_type: holding.coin_type,
      symbol: holding.symbol,
      balance: holding.balance,
      value_usd: saleCoinValueUsd(holding, nowMs),
      ...basisOf(holding.presale_id),
    }))
    .sort((a, b) =>
      (b.value_usd === null ? -1 : Number(b.value_usd)) - (a.value_usd === null ? -1 : Number(a.value_usd)) ||
      a.symbol.localeCompare(b.symbol) || (a.coin_type < b.coin_type ? -1 : a.coin_type > b.coin_type ? 1 : 0));
}

/**
 * A vesting schedule paying one of the wallets (`chain_read_v1.vesting_schedules`),
 * amounts in atoms, times in ms as decimal strings: the cliff's end
 * (`start_ms + cliff_ms`) and the end clamped to `VESTING_MAX_MS`
 * (`contracts/vesting.ts`).
 */
export type VestingScheduleRow = Readonly<{
  schedule_id: string;
  presale_id: string;
  total: string;
  claimed: string;
  start_ms: string;
  cliff_end_ms: string;
  end_ms: string;
  period_ms: string | null;
  periods: string | null;
}>;

/** Vesting schedules paying the wallets (blast-infra's beneficiary index), soonest end first. */
const VESTINGS_SQL = `
  SELECT schedule_id, presale_id, total::text AS total, claimed::text AS claimed, start_ms::text AS start_ms,
    ${vestingMsSql("start_ms + cliff_ms")} AS cliff_end_ms, ${vestingMsSql("end_ms")} AS end_ms, ${vestingStepsSql("v")}
  FROM chain_read_v1.vesting_schedules v
  WHERE beneficiary = ANY($1::text[])
  ORDER BY end_ms, schedule_id
  LIMIT 100`;

export async function readVestingSchedules(db: ReadableDatabase, wallets: readonly string[]): Promise<VestingScheduleRow[]> {
  if (wallets.length === 0) return [];
  return (await db.read<VestingScheduleRow>(VESTINGS_SQL, [[...wallets]])).rows;
}

/**
 * Whether any of the wallets is the beneficiary of a schedule (one index
 * probe), and the website of the sale paying the soonest-ending schedule
 * among those whose sale has one (R3-24 closes OA-21: the entry links out to
 * the project's own site; the beneficiary index, then one primary-key probe
 * of `social_sale_metadata` per schedule, at most 100 schedules).
 */
const VESTING_LINK_SQL = `SELECT
    EXISTS (SELECT 1 FROM chain_read_v1.vesting_schedules WHERE beneficiary = ANY($1::text[])) AS has_schedule,
    (SELECT m.site FROM (
       SELECT v.presale_id, v.end_ms, v.schedule_id FROM chain_read_v1.vesting_schedules v
       WHERE v.beneficiary = ANY($1::text[]) ORDER BY v.end_ms, v.schedule_id LIMIT 100
     ) s
     CROSS JOIN LATERAL (
       SELECT sm.site FROM social_sale_metadata sm WHERE sm.presale_id = s.presale_id AND sm.site IS NOT NULL LIMIT 1
     ) m
     ORDER BY s.end_ms, s.schedule_id LIMIT 1) AS href`;

/** Owner discovery combines presale allocations with the active wallet's utility
 * list. Without that owner read, public portfolios retain the project website. */
export async function readPortfolioVesting(
  db: ReadableDatabase,
  wallets: readonly string[],
  utilityVestings?: () => Promise<readonly PublicVesting[]>,
): Promise<PortfolioVesting> {
  const [row, schedules] = await Promise.all([
    wallets.length ? db.read<{ has_schedule: boolean; href: string | null }>(VESTING_LINK_SQL, [[...wallets]]).then(result => result.rows[0]) : undefined,
    utilityVestings?.(),
  ]);
  const hasSchedule = row?.has_schedule === true || !!schedules?.length;
  // The owner enters the same list that supplied the utility schedules, including
  // Created-only entries. Public portfolios retain the paying project's website.
  const href = utilityVestings ? (hasSchedule ? SOCIAL_PAGE_PATHS.portfolioVestings : null) : row?.href ?? null;
  return { has_schedule: hasSchedule, href };
}
