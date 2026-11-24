import { exactAtoms, exactDecimal, fixedExact, type Exact } from "@blast/core/lib/exact-amount.ts";
import {
  PORTFOLIO_BALANCE_DECIMALS,
  type PortfolioBalanceCoin,
  type PortfolioPositionStatus,
} from "@blast/core/modules/social/contracts/portfolio.ts";
import { TEST_SUI_COIN_TYPES } from "@blast/core/modules/social/contracts/create.ts";
import { USDC_COIN_TYPE } from "@blast/core/lib/sui/coin-types.ts";
import { PORTFOLIO_COIN_TYPES } from "@blast/core/modules/social/portfolio/read.ts";

/**
 * OA-25 Q16: what one account's portfolio was worth at one moment, for the
 * daily snapshot (`snapshots.ts`, 0097). The gold card's five parts:
 *
 * - Committed: positions whose sale is open or closed (not claimable yet),
 *   their commitments at the quote coin's price;
 * - Claimable: positions in a sale that migrated or was cancelled and not
 *   claimed by every wallet, the remaining tokens and quote refunds at their prices;
 * - Tokens: the sale coins held, each at its price;
 * - USDC and SUI: the wallets' balances, USDC at face value and SUI at its
 *   price.
 *
 * USDC counts at face value wherever it appears (cash, and a USDC sale's
 * commitments). Test SUI has zero value. Every other coin needs a
 * `chain_read_v1.prices` row at most `PORTFOLIO_SNAPSHOT_PRICE_MAX_AGE_MS`
 * older than the moment valued. An
 * amount of zero needs none. A held amount without such a price, or wallets
 * the fullnode did not answer for, give no value at all — the day is
 * skipped with its reason — never a partial or estimated one.
 *
 * **Exact.** Atoms are integers and a price is its decimal digits as an
 * integer over a power of ten, so an amount is `atoms × digits` over
 * `10^(decimals + price places)`. Each part is summed exactly and rounded
 * once to cents, half up; the value is the parts' sum. Nothing in this file
 * converts an amount to a JavaScript number.
 */

/** A price older than this, against the moment valued, is no price for the day. */
export const PORTFOLIO_SNAPSHOT_PRICE_MAX_AGE_MS = 15 * 60_000;

export type PortfolioSnapshotSkip = "price_missing" | "balances_unavailable";

/** A presale position, summed over the account's wallets in that sale. */
export type SnapshotPosition = Readonly<{
  /** Quote atoms committed. */
  commitment: string;
  status: PortfolioPositionStatus;
  quote_type: string;
  quote_decimals: number;
  claimable?: Readonly<{
    tokens: string | null;
    quote_refund: string | null;
    sale_type: string;
    sale_decimals: number;
  }>;
}>;

/** A sale coin the account's wallets hold, summed. */
export type SnapshotCoin = Readonly<{ coin_type: string; decimals: number | null; balance: string }>;

/** A `chain_read_v1.prices` row: USD a whole coin, exact text, and when the product took it. */
export type SnapshotPrice = Readonly<{ usd_price: string; as_of_ms: number }>;

export type SnapshotValue =
  | Readonly<{
      kind: "valued";
      value_usd: string;
      committed_usd: string;
      claimable_usd: string;
      tokens_usd: string;
      usdc_usd: string;
      sui_usd: string;
      /** The oldest price used; null when nothing needed one (nothing held, or USDC only). */
      prices_as_of_ms: number | null;
    }>
  | Readonly<{ kind: "skipped"; reason: PortfolioSnapshotSkip }>;

const ZERO: Exact = { n: 0n, scale: 0 };
const ONE: Exact = { n: 1n, scale: 0 };

function add(a: Exact, b: Exact): Exact {
  const scale = a.scale > b.scale ? a.scale : b.scale;
  return { n: a.n * 10n ** BigInt(scale - a.scale) + b.n * 10n ** BigInt(scale - b.scale), scale };
}

/**
 * One account's value at `takenAtMs`: the five parts and their sum, or the
 * reason it cannot be valued. Pure.
 */
export function valuePortfolio(
  input: Readonly<{
    positions: readonly SnapshotPosition[];
    coins: readonly SnapshotCoin[];
    /** SUI and USDC atoms summed over the wallets; null when the fullnode did not answer. */
    cash: Readonly<Record<PortfolioBalanceCoin, string>> | null;
    prices: ReadonlyMap<string, SnapshotPrice>;
    takenAtMs: number;
  }>,
): SnapshotValue {
  if (!input.cash) return { kind: "skipped", reason: "balances_unavailable" };
  const oldestAllowed = input.takenAtMs - PORTFOLIO_SNAPSHOT_PRICE_MAX_AGE_MS;
  let oldest: number | null = null;
  let missing = false;
  const priceOf = (coinType: string): Exact | null => {
    if (coinType === USDC_COIN_TYPE) return ONE;
    const row = input.prices.get(coinType);
    const price = row ? exactDecimal(row.usd_price) : null;
    if (!row || !price || !(row.as_of_ms >= oldestAllowed)) return null;
    oldest = oldest === null || row.as_of_ms < oldest ? row.as_of_ms : oldest;
    return price;
  };
  /** `atoms` (with `decimals`) at the coin's price; zero needs no price. */
  const usd = (atoms: string, decimals: number | null, coinType: string): Exact => {
    if (TEST_SUI_COIN_TYPES.includes(coinType)) return ZERO;
    const amount = decimals === null ? null : exactAtoms(atoms, decimals);
    if (!amount) {
      missing = true;
      return ZERO;
    }
    if (amount.n === 0n) return ZERO;
    const price = priceOf(coinType);
    if (!price) {
      missing = true;
      return ZERO;
    }
    return { n: amount.n * price.n, scale: amount.scale + price.scale };
  };
  let committed = ZERO;
  let claimable = ZERO;
  for (const position of input.positions) {
    if (position.status === "delivered") continue;
    if (position.status === "claimable") {
      const amounts = position.claimable;
      if (!amounts || amounts.tokens === null || amounts.quote_refund === null) return { kind: "skipped", reason: "balances_unavailable" };
      claimable = add(claimable, usd(amounts.tokens, amounts.sale_decimals, amounts.sale_type));
      claimable = add(claimable, usd(amounts.quote_refund, position.quote_decimals, position.quote_type));
    } else {
      committed = add(committed, usd(position.commitment, position.quote_decimals, position.quote_type));
    }
  }
  let tokens = ZERO;
  for (const coin of input.coins) tokens = add(tokens, usd(coin.balance, coin.decimals, coin.coin_type));
  const usdc = usd(input.cash.usdc, PORTFOLIO_BALANCE_DECIMALS.usdc, PORTFOLIO_COIN_TYPES.usdc);
  const sui = usd(input.cash.sui, PORTFOLIO_BALANCE_DECIMALS.sui, PORTFOLIO_COIN_TYPES.sui);
  if (missing) return { kind: "skipped", reason: "price_missing" };
  const parts = {
    committed_usd: fixedExact(committed, 2),
    claimable_usd: fixedExact(claimable, 2),
    tokens_usd: fixedExact(tokens, 2),
    usdc_usd: fixedExact(usdc, 2),
    sui_usd: fixedExact(sui, 2),
  };
  const value = Object.values(parts).reduce<Exact>((total, part) => add(total, exactDecimal(part) ?? ZERO), ZERO);
  return { kind: "valued", value_usd: fixedExact(value, 2), ...parts, prices_as_of_ms: oldest };
}
