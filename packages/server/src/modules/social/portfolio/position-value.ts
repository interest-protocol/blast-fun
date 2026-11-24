import { match, P } from "ts-pattern";
import { SUI_COIN_TYPE } from "@blast/core/lib/sui/coin-types.ts";
import { PORTFOLIO_PRICE_MAX_AGE_MS, type PortfolioBalanceCoin, type PortfolioCommitments, type PortfolioPositionStatus } from "@blast/core/modules/social/contracts/portfolio.ts";
import type { PortfolioPrice } from "@blast/core/modules/social/portfolio/read.ts";
import { PRESALE_PAR_QUOTE_TYPES, TEST_SUI_COIN_TYPES } from "@blast/core/modules/social/contracts/create.ts";

/** Commitments at their quote price; remaining claim tokens and refunds at their own prices. */

/** A non-negative decimal as an integer over a power of ten: `n / 10^scale`. */
type Exact = Readonly<{ n: bigint; scale: number }>;

const ZERO: Exact = { n: 0n, scale: 0 };
const ATOMS = /^(0|[1-9][0-9]*)$/;
const DECIMAL = /^(0|[1-9][0-9]*)(?:\.([0-9]+))?$/;

function decimal(text: string): Exact | null {
  const match = DECIMAL.exec(text);
  if (!match) return null;
  const fraction = match[2] ?? "";
  return { n: BigInt(match[1] + fraction), scale: fraction.length };
}

function add(a: Exact, b: Exact): Exact {
  const scale = a.scale > b.scale ? a.scale : b.scale;
  return { n: a.n * 10n ** BigInt(scale - a.scale) + b.n * 10n ** BigInt(scale - b.scale), scale };
}

/** Rounded half up to cents, as `0.00` text (the snapshot's `exactCents`). */
export function exactCents(value: Exact): string {
  let whole: bigint;
  if (value.scale <= 2) {
    whole = value.n * 10n ** BigInt(2 - value.scale);
  } else {
    const divisor = 10n ** BigInt(value.scale - 2);
    whole = value.n / divisor;
    if ((value.n % divisor) * 2n >= divisor) whole += 1n;
  }
  const digits = whole.toString().padStart(3, "0");
  return `${digits.slice(0, -2)}.${digits.slice(-2)}`;
}

/** A position as the valuation needs it: quote atoms committed, its status, and its quote. */
export type ValuedPosition = Readonly<{
  commitment: string;
  status: PortfolioPositionStatus;
  quote_symbol: string;
  quote_type?: string;
  quote_decimals: number;
  quote_price?: PortfolioPrice | null;
  claimable?: Readonly<{
    tokens: string | null;
    quote_refund: string | null;
    sale_decimals: number;
    price: PortfolioPrice | null;
  }>;
}>;

function positionQuote(position: ValuedPosition, prices: Partial<Record<PortfolioBalanceCoin, PortfolioPrice>>) {
  return match({ coinType: position.quote_type, symbol: position.quote_symbol.toUpperCase() })
    .with(
      { coinType: P.when((coinType) => typeof coinType === "string" && TEST_SUI_COIN_TYPES.includes(coinType)) },
      () => ({ usd_price: "0", as_of_ms: null }),
    )
    .with(
      { coinType: P.when((coinType) => typeof coinType === "string" && PRESALE_PAR_QUOTE_TYPES.includes(coinType)) },
      { coinType: undefined, symbol: "USDC" },
      () => ({ usd_price: "1", as_of_ms: null }),
    )
    .with(
      { coinType: SUI_COIN_TYPE },
      { coinType: undefined, symbol: "SUI" },
      () => position.quote_price ?? prices.sui,
    )
    .otherwise(() => position.quote_price ?? undefined);
}

/**
 * Committed and Claimable in dollars, with the oldest price used (null when
 * none was needed). Fixed-value quotes do not use a price timestamp.
 */
export function valueCommitments(
  positions: readonly ValuedPosition[],
  prices: Partial<Record<PortfolioBalanceCoin, PortfolioPrice>>,
  nowMs: number,
): Readonly<{ commitments: PortfolioCommitments; pricesAsOfMs: number | null }> {
  let pricesAsOfMs: number | null = null;
  let hasPricedHoldings = false;
  const sums = { committed: ZERO, claimable: ZERO };
  const complete = { committed: true, claimable: true };
  for (const position of positions) {
    if (position.status === "delivered") continue;
    const part = position.status === "claimable" ? "claimable" : "committed";
    const value = valueOf(position, prices, nowMs);
    complete[part] &&= value.complete;
    hasPricedHoldings ||= value.hasPricedHoldings;
    if (value.asOfMs !== null) pricesAsOfMs = Math.min(pricesAsOfMs ?? value.asOfMs, value.asOfMs);
    sums[part] = add(sums[part], value.usd);
  }
  const committed = exactCents(sums.committed);
  const claimable = exactCents(sums.claimable);
  const subcent = (value: Exact, cents: string) => cents === "0.00" && value.n > 0n ? Number(`${value.n}e-${value.scale}`) : 0;
  const committedSubcent = subcent(sums.committed, committed);
  const claimableSubcent = subcent(sums.claimable, claimable);
  return {
    commitments: {
      ...(hasPricedHoldings && committed === "0.00" && claimable === "0.00" ? { has_priced_holdings: true } : {}),
      committed_usd: complete.committed ? committed : null,
      claimable_usd: complete.claimable ? claimable : null,
      ...(!complete.committed ? { known_committed_usd: committed } : {}),
      ...(!complete.claimable ? { known_claimable_usd: claimable } : {}),
      ...(committedSubcent > 0 ? { committed_usd_subcent: committedSubcent } : {}),
      ...(claimableSubcent > 0 ? { claimable_usd_subcent: claimableSubcent } : {}),
    },
    pricesAsOfMs,
  };
}

/** Known components in dollars, exactly, independently of whether the entire position is priced. */
function valueOf(
  position: ValuedPosition,
  prices: Partial<Record<PortfolioBalanceCoin, PortfolioPrice>>,
  nowMs: number,
): Readonly<{ usd: Exact; asOfMs: number | null; complete: boolean; hasPricedHoldings: boolean }> {
  const quotePrice = positionQuote(position, prices);
  const quoteAtoms = position.status === "claimable" ? position.claimable?.quote_refund : position.commitment;
  const assets = [{ atoms: quoteAtoms, decimals: position.quote_decimals, price: quotePrice }];
  if (position.status === "claimable") {
    if (!position.claimable) return { usd: ZERO, asOfMs: null, complete: false, hasPricedHoldings: false };
    assets.push({ atoms: position.claimable.tokens, decimals: position.claimable.sale_decimals, price: position.claimable.price ?? undefined });
  }
  let usd = ZERO;
  let asOfMs: number | null = null;
  let complete = true;
  let hasPricedHoldings = false;
  for (const { atoms, decimals, price } of assets) {
    const value = valueOfAsset(atoms, decimals, price, nowMs);
    if (value === null) {
      complete = false;
      continue;
    }
    hasPricedHoldings ||= atoms !== "0";
    usd = add(usd, value.usd);
    if (value.asOfMs !== null) asOfMs = Math.min(asOfMs ?? value.asOfMs, value.asOfMs);
  }
  return { usd, asOfMs, complete, hasPricedHoldings };
}

function valueOfAsset(
  atoms: string | null | undefined,
  decimals: number,
  price: Readonly<{ usd_price: string; as_of_ms: number | null }> | undefined,
  nowMs: number,
): Readonly<{ usd: Exact; asOfMs: number | null }> | null {
  if (atoms == null || !ATOMS.test(atoms) || !Number.isInteger(decimals) || decimals < 0 || decimals > 255) return null;
  const amount = BigInt(atoms);
  if (amount === 0n) return { usd: ZERO, asOfMs: null };
  if (!price || (price.as_of_ms !== null && !(nowMs - price.as_of_ms <= PORTFOLIO_PRICE_MAX_AGE_MS))) return null;
  const rate = decimal(price.usd_price);
  if (rate === null) return null;
  return { usd: { n: amount * rate.n, scale: decimals + rate.scale }, asOfMs: price.as_of_ms };
}
