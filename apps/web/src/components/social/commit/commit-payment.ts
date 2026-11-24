import { parseAtoms } from "#web/components/social/trade/trade-ticket.ts";
import { commitOffLine } from "@blast/core/web/contracts/commit.ts";
import { atomsText, atomsValue } from "@blast/core/web/format.ts";
import { SOCIAL_TRADE_DEFAULT_SLIPPAGE_BPS, type SocialTradeQuote } from "@blast/core/web/contracts/trades.ts";
import { commitAmounts, commitRefusal, type CommitInput, type CommitSale } from "@blast/core/modules/social/commit/quote.ts";

import { PUBLIC_BASE_COINS, type WalletCoinView } from "../coins/coin-model";
import type { TradeQuoteRequester } from "../trades/trades-client.ts";
import { tradeSide } from "../trade/trade-ticket.ts";
import { impactText, isOffered } from "../trades/trade-quote-view";
import { commitErrorText } from "./commit-input";
import type { CommitBlastInput } from "./CommitPanel";
import { COMMIT_COIN_TYPES, commitQuoteUsd } from "./commit-view";

export function saleQuoteCoin(sale: CommitSale, coins: readonly WalletCoinView[] = []): WalletCoinView {
  const coinType = sale.quoteType ?? COMMIT_COIN_TYPES[sale.quoteCoin];
  const held = coins.find((coin) => coin.coinType === coinType);
  const base = PUBLIC_BASE_COINS.find((coin) => coin.coinType === coinType);
  return { ...PUBLIC_BASE_COINS[0]!, ...base, ...held, key: held?.key ?? base?.key ?? coinType, coinType, symbol: sale.quoteCoin, name: sale.quoteCoin === "TSUI" ? "Test SUI" : held?.name ?? base?.name ?? sale.quoteCoin,
    decimals: sale.quoteDecimals ?? base?.decimals ?? 0, price: held?.price ?? base?.price ?? null, metadataAvailable: true, presale: null };
}

/** True when paying with `coin` swaps it into the sale's quote coin first; one coin pays for one purchase. */
export function routedPayment(sale: CommitSale, coin: WalletCoinView): boolean {
  return coin.coinType !== saleQuoteCoin(sale).coinType;
}

/** The symbol a purchase pays in: the sale's own name for its quote coin, else the chosen coin's. */
export function payWithOf(sale: CommitSale, coin: WalletCoinView): string {
  return routedPayment(sale, coin) ? coin.symbol : sale.quoteCoin;
}

/** The commitment is the guaranteed output, never the spot-price estimate. */
export function fundedPaymentInput(input: CommitInput, atoms: string | null, decimals: number): CommitInput {
  const amount = atoms === null ? 0n : BigInt(atoms);
  return { ...input, sale: { ...input.sale, quoteDecimals: decimals }, payWith: input.sale.quoteCoin, viewer: { ...input.viewer, quoteCoin: input.sale.quoteCoin, quoteUsd: commitQuoteUsd(input.sale, input.viewer), quoteBalance: atomsValue(amount, decimals) ?? 0 }, typed: atomsText(amount, decimals) };
}

function matchesPayment(input: CommitInput, coin: WalletCoinView, quote: SocialTradeQuote, nowMs: number): boolean {
  return isOffered(quote, nowMs) && quote.unavailable_reason === null && quote.offer_refused === null &&
    quote.in_coin === coin.coinType && quote.out_coin === saleQuoteCoin(input.sale).coinType &&
    quote.side === tradeSide(quote.in_coin, quote.out_coin) && quote.slippage_bps === SOCIAL_TRADE_DEFAULT_SLIPPAGE_BPS &&
    quote.amount_in === parseAtoms(input.typed, coin.decimals)?.toString() && quote.min_out !== null && BigInt(quote.min_out) > 0n;
}

export function paymentPreview(input: CommitInput, coin: WalletCoinView, quote: SocialTradeQuote | null, nowMs: number): CommitInput {
  if (!routedPayment(input.sale, coin)) return input;
  return fundedPaymentInput(input, quote && matchesPayment(input, coin, quote, nowMs) ? quote.min_out : null, saleQuoteCoin(input.sale).decimals);
}

/** `quote` is the swap quote the order seals, or null when the sale's own coin pays. */
export type PreparedPayment = Readonly<{ input: CommitInput; order: CommitBlastInput; quote: SocialTradeQuote | null }> | Readonly<{ refusal: string }>;

function refusalText(input: CommitInput): string | null {
  const refusal = commitRefusal(input);
  if (refusal === null) return null;
  return refusal === "blocked" ? commitOffLine(input.blockers) : commitErrorText(refusal, input);
}

async function routedPaymentQuote(input: CommitInput, coin: WalletCoinView, read: TradeQuoteRequester, now: () => number, shown: SocialTradeQuote | null): Promise<SocialTradeQuote | Readonly<{ refusal: string }>> {
  const atoms = parseAtoms(input.typed, coin.decimals);
  if (atoms === null || atoms <= 0n) return { refusal: commitOffLine(["swap_unavailable"])! };
  if (atoms > coin.atoms) return { refusal: "Not enough to cover it" };
  let quote = shown;
  if (quote === null) {
    try {
      const outType = saleQuoteCoin(input.sale).coinType;
      const result = await read({ in_coin: coin.coinType, out_coin: outType, side: tradeSide(coin.coinType, outType), amount_in: atoms.toString(), slippage_bps: SOCIAL_TRADE_DEFAULT_SLIPPAGE_BPS }, AbortSignal.timeout(15_000));
      quote = result.status === "ok" ? result.body : null;
    } catch {
      return { refusal: "Couldn’t get a swap quote. Try again." };
    }
  }
  if (quote === null || !matchesPayment(input, coin, quote, now())) return { refusal: commitOffLine(["swap_unavailable"])! };
  return quote;
}

/** A path with no confirm screen refuses a swap that moves the price too far, or whose impact is unknown. */
function impactRefusal(quote: SocialTradeQuote, maxImpactBps: number | undefined): string | null {
  if (maxImpactBps === undefined) return null;
  if (quote.price_impact_bps === null) return "This swap’s price impact is unknown. Use the commit window to see the route.";
  if (quote.price_impact_bps <= maxImpactBps) return null;
  return `This swap moves the price more than ${maxImpactBps / 100}%. Use the commit window to see the route.`;
}

function paymentOrder(input: CommitInput, coin: WalletCoinView, funded: CommitInput, quote: SocialTradeQuote | null): CommitBlastInput {
  const amounts = commitAmounts(funded);
  return { payWith: funded.sale.quoteCoin, pay: quote ? Number(input.typed) : amounts.pay, quote: amounts.quote, usd: amounts.usd, why: funded.why.trim(),
    ...(quote ? { swapQuoteId: quote.quote_id!, quoteAtoms: quote.min_out!, paymentSymbol: coin.symbol } : {}) };
}

/**
 * All compact controls prepare the same sealed swap quote for the existing
 * commit flow. `coin` is the wallet coin the person pays with; when it is not
 * the sale's quote coin, the purchase swaps it in the same transaction.
 * `maxImpactBps` is for paths with no confirm screen.
 */
export async function prepareCommitPayment(input: CommitInput, coin: WalletCoinView, read: TradeQuoteRequester, now: () => number, shown: SocialTradeQuote | null = null, maxImpactBps?: number): Promise<PreparedPayment> {
  let current = { ...input, nowMs: now() };
  const routed = routedPayment(current.sale, coin);
  if (!routed && shown !== null) return { refusal: commitOffLine(["swap_unavailable"])! };
  const initialRefusal = commitRefusal(current);
  // Before the quote a routed amount is in the pay coin, so the sale's own
  // bounds (and, for a quote coin with no dollar rate, its size) wait for the
  // funded commitment, which is judged again below.
  const pending = ["min", "cap", "insufficient"].includes(initialRefusal ?? "") || (initialRefusal === "empty" && Number(current.typed) > 0);
  if (initialRefusal !== null && (!routed || !pending)) return { refusal: refusalText(current)! };
  let quote: SocialTradeQuote | null = null;
  if (routed) {
    const result = await routedPaymentQuote(current, coin, read, now, shown);
    if ("refusal" in result) return result;
    const impact = impactRefusal(result, maxImpactBps);
    if (impact !== null) return { refusal: impact };
    quote = result;
    current = { ...paymentPreview(current, coin, quote, now()), nowMs: now() };
  }
  const refusal = refusalText(current);
  if (refusal !== null) return { refusal };
  return { input: current, order: paymentOrder(input, coin, current, quote), quote };
}

export function paymentRouteText(quote: SocialTradeQuote, sale: CommitSale): string {
  const coin = saleQuoteCoin(sale);
  const minimum = quote.min_out === null ? "—" : atomsText(quote.min_out, coin.decimals);
  const impact = quote.price_impact_bps === null ? "—" : impactText(quote.price_impact_bps);
  const fee = quote.blast_fee_bps === null ? "—" : impactText(quote.blast_fee_bps);
  return `${minimum} ${coin.symbol} minimum · ${quote.route_label ?? "Swap route"} · impact ${impact} · slippage ${impactText(quote.slippage_bps)} · Blast swap fee ${fee} · ${quote.network_fee?.label ?? "Network fee shown in wallet"}`;
}
