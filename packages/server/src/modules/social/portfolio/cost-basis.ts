import { recordMetric } from "@blast/core/lib/metrics.ts";
import type { ReadableDatabase } from "@blast/core/modules/database/transaction.ts";
import { NO_COST_BASIS, type CostBasisFigures } from "@blast/core/modules/social/contracts/portfolio.ts";
import { SHOWN_ACTIVITY } from "@blast/core/modules/social/read-model/chain-presales.ts";
import type { SaleCoinHolding } from "@blast/server/modules/social/portfolio/holdings.ts";
import { atomsToUsd, isFreshPrice, type PortfolioPrice } from "@blast/core/modules/social/portfolio/read.ts";

/**
 * What an account paid for each sale coin it holds, and the P&L that
 * answers. One rule for every surface — the panel's P&L, the dock's chips,
 * the wallet's Positions table, the gold card and the profile's calls.
 * Contract and AC-1–AC-6: docs/product/social-feed/tickets/R3-32.md.
 *
 * **The source is the chain's activity log**, `chain_read_v1.activity`
 * from blast-infra, read for the account's wallets: its
 * `presale_commit` and `presale_claim` rows and its `trade_buy` and
 * `trade_sell` rows, the last two for every trade of a sale coin on any venue
 * or route, in Blast or not. The web's own trade log (`social_transactions`,
 * `social_swap_intents`) is not a source: it holds only trades sent through
 * Blast, at quoted amounts and USD at submission, while the balance the basis
 * is measured against (`chain_read_v1.coin_balances`) is the indexer's, so a
 * basis taken from the same indexer agrees with what is held at the same
 * checkpoint. A Blast trade the indexer has not reached yet is shown pending
 * by the transaction log and API response, and joins the basis when its row lands
 * (the `activity` hint names it).
 *
 * **Average cost.** Acquisitions add their USD at event time: a presale claim
 * adds the share of the wallet's commitments that bought the tokens it
 * claimed (`commitments' USD × (committed − refunded) / committed`, the
 * commitments priced as blast-infra prices them), a `trade_buy` its
 * `usd_value` (what was paid). A `trade_sell` takes away
 * `sold / held × basis`, leaving the per-token average unchanged; the
 * realised part (`proceeds − that cost`) is kept apart. Tokens that arrived
 * with no priced acquisition — a transfer in, an airdrop, a reward, a vesting
 * claim, an unpriced commitment or trade — have no cost, so the basis is
 * then **incomplete** (`basis_complete: false`) and no P&L or multiple is
 * given. Tokens that left without a trade (a transfer out, a liquidity
 * deposit) leave at the average cost.
 *
 * **Exact.** Atoms are integers, USD is an integer of 10⁻¹⁸ dollars
 * (blast-infra's own `usd_value` precision), and every step is integer
 * arithmetic. The only roundings are a claim's or a sell's pro-rata share
 * (half up at 10⁻¹⁸), and the answer's: cents half up, the multiple half up
 * at four places. No intermediate price is rounded.
 */

/** The activity kinds the basis reads, in the order the log can hold them. */
export const COST_BASIS_KINDS = ["presale_commit", "presale_claim", "trade_buy", "trade_sell", "trade_unresolved"] as const;
export type CostBasisKind = (typeof COST_BASIS_KINDS)[number] | "pnl_opening_balance" | "pnl_opening_commitment";

/**
 * The most activity rows read per wallet (the oldest first). A wallet with
 * more makes every basis of its account unknown rather than wrong: the read
 * stays bounded for a bot, and launch scale's heaviest account (2,000 rows)
 * is far below it.
 */
export const COST_BASIS_ROWS_PER_WALLET = 10_000;

/** One activity row as the basis reads it: amounts are atoms and USD as `numeric` text. */
export type CostBasisRow = Readonly<{
  /** False when indexed transaction flows cannot be ordered exactly. */
  accounting_complete?: boolean;
  kind: CostBasisKind;
  presale_id: string;
  actor: string;
  quote_amount: string;
  coin_amount: string | null;
  quote_refund: string | null;
  usd_value: string | null;
}>;

/** The account's rows in chain order, and whether some wallet had more than the read takes. */
export type CostBasisLedger = Readonly<{ rows: readonly CostBasisRow[]; truncated: boolean }>;

/**
 * Each wallet's oldest rows of the four kinds, in chain order: a backward
 * scan of blast-infra's `(actor, timestamp_ms DESC)` index per wallet,
 * stopped at the cap, so an account's read is bounded by its wallets.
 * Hidden sales retain activity rows (T-043); filter them before the cap so they
 * cannot crowd visible positions out of the bounded scan.
 */
// A stable wallet-array estimate lets prepared reads reuse the bounded per-wallet plan.
const LEDGER_SQL = `
  SELECT r.kind, r.presale_id, r.actor, r.quote_amount, r.coin_amount, r.quote_refund, r.usd_value,
    r.digest, r.timestamp_ms, r.checkpoint, r.tx_slot, r.event_slot, r.part
  FROM unnest((SELECT $1::text[])) AS w(address)
  CROSS JOIN LATERAL (
    SELECT a.kind, a.presale_id, a.actor, a.quote_amount::text AS quote_amount, a.coin_amount::text AS coin_amount,
      a.quote_refund::text AS quote_refund, a.usd_value::text AS usd_value,
      a.digest, a.timestamp_ms, a.checkpoint, a.tx_slot, a.event_slot, a.part
    FROM ${SHOWN_ACTIVITY} a
    WHERE a.actor = w.address AND a.kind = ANY($2::text[]) AND a.presale_id IS NOT NULL
    ORDER BY a.timestamp_ms, a.checkpoint, a.tx_slot, a.event_slot, a.part
    LIMIT $3
  ) r
  ORDER BY r.timestamp_ms, r.checkpoint, r.tx_slot, r.event_slot, r.part`;

export const COST_BASIS_STATEMENTS = Object.freeze({ ledger: LEDGER_SQL });

export async function readCostBasisLedger(
  db: ReadableDatabase,
  wallets: readonly string[],
  rowsPerWallet = COST_BASIS_ROWS_PER_WALLET,
  presaleIds?: readonly string[],
): Promise<CostBasisLedger> {
  const addresses = [...new Set(wallets)];
  if (addresses.length === 0 || presaleIds?.length === 0) return { rows: [], truncated: false };
  // Apply the original history cap before selecting positions. Filtering inside
  // the scan could walk all unrelated history and hide account-wide truncation.
  const { rows } = await db.read<CostBasisRow>(LEDGER_SQL, [addresses, [...COST_BASIS_KINDS], rowsPerWallet + 1]);
  const perWallet = new Map<string, number>();
  for (const row of rows) perWallet.set(row.actor, (perWallet.get(row.actor) ?? 0) + 1);
  const truncated = [...perWallet.values()].some((count) => count > rowsPerWallet);
  if (truncated) recordMetric("social.cost_basis", { outcome: "truncated" });
  const selected = presaleIds === undefined ? null : new Set(presaleIds);
  return { rows: selected ? rows.filter((row) => selected.has(row.presale_id)) : rows, truncated };
}

/**
 * The ledger, or null when it cannot be read (the activity view absent or
 * failing): every basis is then unknown, and the read it joins still
 * answers, as the portfolio's optional parts do.
 */
export async function readCostBasisLedgerOrNull(db: ReadableDatabase, wallets: readonly string[], presaleIds?: readonly string[]): Promise<CostBasisLedger | null> {
  try {
    return await readCostBasisLedger(db, wallets, COST_BASIS_ROWS_PER_WALLET, presaleIds);
  } catch {
    recordMetric("social.cost_basis", { outcome: "unavailable" });
    return null;
  }
}

// ---- exact arithmetic --------------------------------------------------

const USD_PLACES = 18;
const USD_UNIT = 10n ** BigInt(USD_PLACES);
const CENT = USD_UNIT / 100n;
const ATOMS = /^(0|[1-9][0-9]*)$/;
const DECIMAL = /^(0|[1-9][0-9]*)(?:\.([0-9]+))?$/;

function atomsOf(text: string | null): bigint | null {
  return text !== null && ATOMS.test(text) ? BigInt(text) : null;
}

/** A non-negative decimal as an integer of 10⁻¹⁸ dollars (half up past 18 places, which blast-infra never writes). */
function usdOf(text: string | null): bigint | null {
  const match = text === null ? null : DECIMAL.exec(text);
  if (!match) return null;
  const fraction = match[2] ?? "";
  const kept = BigInt(match[1] + fraction.slice(0, USD_PLACES).padEnd(USD_PLACES, "0"));
  return (fraction[USD_PLACES] ?? "0") >= "5" ? kept + 1n : kept;
}

/** `a × b / c`, half up; all non-negative and `c` positive. */
function mulDiv(a: bigint, b: bigint, c: bigint): bigint {
  return (2n * a * b + c) / (2n * c);
}

/** 10⁻¹⁸ dollars, non-negative, as two places, half up. */
function cents(usd: bigint): string {
  const total = (usd + CENT / 2n) / CENT;
  const digits = total.toString().padStart(3, "0");
  return `${digits.slice(0, -2)}.${digits.slice(-2)}`;
}

/** `a − b` of two two-place amounts, signed (`-12.40`). */
function centsDifference(a: string, b: string): string {
  const difference = BigInt(a.replace(".", "")) - BigInt(b.replace(".", ""));
  const magnitude = (difference < 0n ? -difference : difference).toString().padStart(3, "0");
  return `${difference < 0n ? "-" : ""}${magnitude.slice(0, -2)}.${magnitude.slice(-2)}`;
}

/** `numerator / denominator` to four places, half up; both positive. */
function fourPlaces(numerator: bigint, denominator: bigint): string {
  const digits = mulDiv(numerator, 10_000n, denominator).toString().padStart(5, "0");
  return `${digits.slice(0, -4)}.${digits.slice(-4)}`;
}

/**
 * The multiple of `atoms` (with `decimals`) at `price` over `basis`
 * (10⁻¹⁸ dollars): `atoms × price / 10^decimals / basis`, exact until its
 * four-place rounding. Null without a positive basis, held atoms or a price.
 */
function multipleOf(atoms: bigint, decimals: number, price: string, basis: bigint): string | null {
  const match = DECIMAL.exec(price);
  if (!match || basis <= 0n || atoms <= 0n) return null;
  const fraction = match[2] ?? "";
  const priceDigits = BigInt(match[1] + fraction);
  if (priceDigits === 0n) return null;
  return fourPlaces(atoms * priceDigits * USD_UNIT, 10n ** BigInt(decimals + fraction.length) * basis);
}

// ---- the rule -----------------------------------------------------------

/** One sale coin's average-cost state after the ledger, before it is measured against the balance. */
export type CoinLedgerState = Readonly<{
  presale_id: string;
  /** Atoms the ledger accounts for: acquired less disposed. */
  tracked: bigint;
  /** 10⁻¹⁸ dollars paid for `tracked`. */
  basis: bigint;
  /** Part of `tracked` came with no price (an unpriced commitment or buy). */
  unknown: boolean;
  /** Proceeds less cost of everything sold, 10⁻¹⁸ dollars, signed; null once some sale's cost or proceeds is unknown. */
  realised: bigint | null;
}>;

/**
 * What a presale delivered to the account, summed over its wallets that
 * claimed: the tokens claimed and the commitments' USD that bought them.
 * Calls use only this acquisition, excluding later market buys (OA-9;
 * R3-32-AC-5).
 */
export type PresaleAcquisition = Readonly<{ presale_id: string; tokens: bigint; basis: bigint; unknown: boolean }>;

export type CostBasisBook = Readonly<{
  coins: ReadonlyMap<string, CoinLedgerState>;
  presales: ReadonlyMap<string, PresaleAcquisition>;
  /** Some wallet's history was longer than the read: every basis is unknown. */
  truncated: boolean;
}>;

type MutableCoin = { -readonly [K in keyof CoinLedgerState]: CoinLedgerState[K] };
type MutableAcquisition = { -readonly [K in keyof PresaleAcquisition]: PresaleAcquisition[K] };
type Commitments = { quote: bigint; usd: bigint; unpriced: boolean };

/**
 * Applies the rule to the account's rows in chain order. Per sale coin
 * (keyed by its presale id, which the indexer stamps on every trade), across all
 * the account's wallets as one holding, so a transfer between them changes
 * nothing.
 */
export function costBasisBook(ledger: CostBasisLedger): CostBasisBook {
  const coins = new Map<string, MutableCoin>();
  const presales = new Map<string, MutableAcquisition>();
  const commitments = new Map<string, Commitments>();
  const coin = (presaleId: string): MutableCoin => {
    let state = coins.get(presaleId);
    if (!state) coins.set(presaleId, (state = { presale_id: presaleId, tracked: 0n, basis: 0n, unknown: false, realised: 0n }));
    return state;
  };
  const acquire = (state: MutableCoin, atoms: bigint, usd: bigint | null) => {
    state.tracked += atoms;
    if (usd === null) state.unknown = true;
    else state.basis += usd;
  };

  // A wallet's commitments to a presale, which its claim prices.
  const walletKey = (row: CostBasisRow) => `${row.presale_id}|${row.actor}`;
  const claimTokens = (row: CostBasisRow) => {
    const tokens = atomsOf(row.coin_amount) ?? 0n;
    if (tokens === 0n) return; // a refund only (a cancelled sale): nothing acquired
    const commit = commitments.get(walletKey(row));
    const refund = atomsOf(row.quote_refund) ?? 0n;
    // The commitments' USD that bought the tokens: the share not refunded.
    const paid = !commit || commit.unpriced || commit.quote === 0n || refund > commit.quote
      ? null
      : mulDiv(commit.usd, commit.quote - refund, commit.quote);
    acquire(coin(row.presale_id), tokens, paid);
    const acquisition = presales.get(row.presale_id) ?? { presale_id: row.presale_id, tokens: 0n, basis: 0n, unknown: false };
    acquisition.tokens += tokens;
    if (paid === null) acquisition.unknown = true;
    else acquisition.basis += paid;
    presales.set(row.presale_id, acquisition);
    return;
  };

  const sellTokens = (row: CostBasisRow) => {
    const sold = atomsOf(row.coin_amount);
    if (sold === null || sold === 0n) return;
    const state = coin(row.presale_id);
    const proceeds = usdOf(row.usd_value);
    if (state.tracked === 0n) {
      // Tokens the ledger never saw arrive (a transfer in): what they cost is unknown.
      state.realised = null;
      return;
    }
    const held = state.tracked;
    const unknownBefore = state.unknown;
    let cost: bigint;
    if (sold >= held) {
      // Everything the ledger accounts for is gone; nothing of unknown cost is left in it.
      cost = state.basis;
      state.basis = 0n;
      state.tracked = 0n;
      state.unknown = false;
    } else {
      const kept = mulDiv(state.basis, held - sold, held);
      cost = state.basis - kept;
      state.basis = kept;
      state.tracked = held - sold;
    }
    // Selling more than the ledger saw arrive: some of it came by a transfer in, at no known cost.
    state.realised = state.realised === null || proceeds === null || unknownBefore || sold > held
      ? null
      : state.realised + proceeds - cost;
    return;
  };

  for (const row of ledger.rows) {
    switch (row.kind) {
      case "pnl_opening_commitment": {
        // A later claim mixes prelaunch funding with any postlaunch contributions.
        commitments.set(walletKey(row), { quote: 0n, usd: 0n, unpriced: true });
        break;
      }
      case "pnl_opening_balance": {
        // Quantity held before launch, with no prelaunch acquisition cost or profit imported.
        const tokens = atomsOf(row.coin_amount);
        if (tokens !== null && tokens > 0n) acquire(coin(row.presale_id), tokens, null);
        break;
      }
      case "trade_unresolved": {
        const state = coin(row.presale_id);
        state.unknown = true;
        state.realised = null;
        break;
      }
      case "presale_commit": {
        const key = walletKey(row);
        const commit = commitments.get(key) ?? { quote: 0n, usd: 0n, unpriced: false };
        const usd = usdOf(row.usd_value);
        commit.quote += atomsOf(row.quote_amount) ?? 0n;
        if (usd === null) commit.unpriced = true;
        else commit.usd += usd;
        commitments.set(key, commit);
        break;
      }
      case "presale_claim": {
        claimTokens(row);
        break;
      }
      case "trade_buy": {
        const tokens = atomsOf(row.coin_amount);
        if (tokens === null || tokens === 0n) break;
        acquire(coin(row.presale_id), tokens, usdOf(row.usd_value));
        break;
      }
      case "trade_sell": {
        sellTokens(row);
        break;
      }
    }
  }
  return { coins, presales, truncated: ledger.truncated };
}

/** The figures when the basis cannot be known (the ledger could not be read, or was cut short). */
export const UNKNOWN_BASIS: CostBasisFigures = Object.freeze({ basis_usd: null, basis_complete: false, pnl_usd: null, pnl_multiple: null });

/** What the account holds of a coin now, and its latest price (freshness is checked at `nowMs`). */
export type CoinHolding = Readonly<{ balance: string; decimals: number; price: PortfolioPrice | null }>;

/**
 * One coin's four figures: the ledger's state measured against what is held
 * now. More held than the ledger accounts for is an unknown component
 * (`basis_complete: false`, no P&L); less held means tokens left without a
 * trade, at the average cost. `basis_usd` is the basis of what is held —
 * when incomplete, the part that is known (a lower bound, since no cost is
 * negative), or null when no part is. `pnl_usd` is `value − basis` at the
 * value the portfolio shows (`saleCoinValueUsd`, so the figures add up on
 * screen) and `pnl_multiple` `value / basis`; both are null when the basis
 * is zero or unknown, or the coin has no price fresher than 120 s.
 */
export function coinBasisFigures(book: CostBasisBook | null, presaleId: string, holding: CoinHolding | null, nowMs: number): CostBasisFigures {
  if (book === null || book.truncated) return UNKNOWN_BASIS;
  const held = atomsOf(holding?.balance ?? "0");
  if (held === null) return UNKNOWN_BASIS;
  const state = book.coins.get(presaleId);
  // Held with no acquisition at all (a transfer in, an airdrop, a vesting claim).
  if (!state) return held === 0n ? NO_COST_BASIS : UNKNOWN_BASIS;
  let basis = state.basis;
  let unknown = state.unknown;
  if (held > state.tracked) unknown = true;
  else if (held < state.tracked) {
    basis = mulDiv(basis, held, state.tracked);
    if (held === 0n) unknown = false;
  }
  if (unknown) return basis === 0n ? UNKNOWN_BASIS : { ...UNKNOWN_BASIS, basis_usd: cents(basis) };
  const basisUsd = cents(basis);
  const price = holding?.price ?? undefined;
  if (basis === 0n || held === 0n || !holding || !isFreshPrice(price, nowMs)) {
    return { basis_usd: basisUsd, basis_complete: true, pnl_usd: null, pnl_multiple: null };
  }
  const value = atomsToUsd(held.toString(), holding.decimals, price.usd_price);
  const multiple = multipleOf(held, holding.decimals, price.usd_price, basis);
  if (value === null || multiple === null) return { basis_usd: basisUsd, basis_complete: true, pnl_usd: null, pnl_multiple: null };
  return { basis_usd: basisUsd, basis_complete: true, pnl_usd: centsDifference(value, basisUsd), pnl_multiple: multiple };
}

/**
 * A call's multiple: the presale acquisition's tokens at the price now
 * over what they cost — the same arithmetic as `coinBasisFigures`, so a
 * position whose only acquisition is its claim answers the same four-place
 * figure on both paths. Null before a claim, with an unknown cost, or
 * without a price fresher than 120 s.
 */
export function presaleCallMultiple(acquisition: PresaleAcquisition | undefined, decimals: number, price: PortfolioPrice | null, nowMs: number): string | null {
  const fresh = price ?? undefined;
  if (!acquisition || acquisition.unknown || !isFreshPrice(fresh, nowMs)) return null;
  return multipleOf(acquisition.tokens, decimals, fresh.usd_price, acquisition.basis);
}

/**
 * The figures of every sale coin, by presale id, for a read that has the
 * account's ledger and its sale-coin holdings (`readSaleCoinHoldings`):
 * the portfolio's and `/me/presales`' positions and coins all answer from
 * this one function. Either missing (null: its read failed) makes every
 * basis unknown, since the basis is measured against what is held.
 */
export function costBasisFiguresOf(
  ledger: CostBasisLedger | null,
  holdings: readonly SaleCoinHolding[] | null,
  nowMs: number,
): (presaleId: string) => CostBasisFigures {
  if (ledger === null || holdings === null) return () => UNKNOWN_BASIS;
  const book = costBasisBook(ledger);
  const held = new Map(holdings.map((holding) => [holding.presale_id, holding]));
  const figures = new Map<string, CostBasisFigures>();
  return (presaleId) => {
    let answer = figures.get(presaleId);
    if (!answer) figures.set(presaleId, (answer = coinBasisFigures(book, presaleId, held.get(presaleId) ?? null, nowMs)));
    return answer;
  };
}
