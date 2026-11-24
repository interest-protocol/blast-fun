import type { SocialTransferFee } from "../../../../../../packages/core/src/modules/social/contracts/coins.ts";
import type { SocialTradeQuote, SocialTradeQuoteRequest } from "@blast/core/modules/social/contracts/trades.ts";

import type { ApiResult } from "#web/components/social/social-api.ts";
import type { WalletCoinView } from "#web/components/social/coins/coin-model.ts";
import type { CoinSheetTrading, TradeOutcome } from "#web/components/social/coins/SwapForm.tsx";

/**
 * Development fixture for the swap (`/dev/social/coins`, the sale page's
 * fixture; never in production, never from a test of the real path): quote
 * answers shaped exactly like R3-30's, over the design's sample wallet, so
 * the swap's every state can be compared with the gate without a session,
 * a fullnode or the aggregator. The figures are the gate's sample's own —
 * its `quoteTrade` at the amounts the comparison types — and nothing here is
 * reachable outside `/dev/social/*`.
 */

export type SwapFixtureMode = Readonly<{
  /** `none`: the quote never answers (`Finding the best price`); `unavailable`: no route; `error`: the route refuses; `stale`: it expires at once. */
  quote: "ok" | "none" | "unavailable" | "error" | "stale";
  /** What a press answers: the trade, `That didn’t go through`, `Not enough …`, or the fee prompt. */
  trade: "ok" | "fail" | "short" | "fee";
  signedIn: boolean;
  fee: SocialTransferFee;
}>;

/** The gate sample's answers at the amounts the comparison types: `amount_out` and its USD, by `in|out|amount_in`. */
const GATE_ANSWERS: Readonly<Record<string, Readonly<{ out: string; inUsd: string; outUsd: string; impact: number }>>> = {
  // 100 SUI → 341.99 USDC (≈ $342.00 each), impact <0.01%.
  "sui|usdc|100000000000": { out: "341997073", inUsd: "342.00", outUsd: "342.00", impact: 0 },
  // The flip: 342 USDC → 99.99 SUI.
  "usdc|sui|342000000": { out: "99999146198", inUsd: "342.00", outUsd: "342.00", impact: 0 },
  // 100 USDC → 47,604 KSTL through Kestrel's pool (≈ $99.97), impact 0.03%.
  "usdc|kstl|100000000": { out: "47604447534729", inUsd: "100.00", outUsd: "99.97", impact: 3 },
  // 1,000 KSTL → 2.09 USDC.
  "kstl|usdc|1000000000000": { out: "2099993", inUsd: "2.10", outUsd: "2.10", impact: 0 },
};

const VENUE_ROUTES: Readonly<Record<string, string>> = {
  "sui|usdc": "Best price across Sui pools",
  "usdc|sui": "Best price across Sui pools",
};

function routeLabel(inCoin: WalletCoinView, outCoin: WalletCoinView): string {
  const pair = `${inCoin.key}|${outCoin.key}`;
  if (VENUE_ROUTES[pair]) return VENUE_ROUTES[pair];
  const sale = [inCoin, outCoin].filter((coin) => coin.presale !== null);
  const where = [...new Set([...(sale.length ? ["Cetus"] : []), ...([inCoin, outCoin].some((coin) => coin.key === "sui") ? ["Sui pools"] : [])])];
  const hop = inCoin.key !== "usdc" && outCoin.key !== "usdc" ? ` → USDC` : "";
  return `${inCoin.symbol}${hop} → ${outCoin.symbol} · ${where.reverse().join(" and ") || "Sui pools"}`;
}

const cents = (value: number) => (Math.floor(value * 100) / 100).toFixed(2);

function fixtureNetworkFee(mode: SwapFixtureMode): SocialTradeQuote["network_fee"] {
  if (!mode.signedIn) return null;
  if (mode.fee === "sponsored") return { payer: "blast", label: "Paid by Blast", estimate_mist: "2565136" };
  return { payer: "wallet", label: "Paid from your SUI", estimate_mist: "2565136" };
}

function fixturePrice(coin: WalletCoinView): number | null {
  return coin.key === "usdc" ? 1 : coin.price;
}

function fixtureOutput(known: (typeof GATE_ANSWERS)[string] | undefined, outPrice: number | null, inValue: number, decimals: number): bigint {
  if (known) return BigInt(known.out);
  if (outPrice === null || outPrice <= 0) return 0n;
  return BigInt(Math.floor((inValue / outPrice) * 10 ** decimals));
}

/** One fixture answer in R3-30's shape for the sample wallet. */
export function fixtureQuote(body: SocialTradeQuoteRequest, coins: readonly WalletCoinView[], mode: SwapFixtureMode, nowMs: number): SocialTradeQuote {
  const inCoin = coins.find((coin) => coin.coinType === body.in_coin)!;
  const outCoin = coins.find((coin) => coin.coinType === body.out_coin)!;
  const amountIn = BigInt(body.amount_in ?? "0");
  const base = {
    quoted_at_ms: nowMs, side: body.side, in_coin: body.in_coin, out_coin: body.out_coin, slippage_bps: 50,
    price_impact_unavailable: null, route: [], dry_run: "not_run" as const,
  };
  if (mode.quote === "unavailable") {
    return {
      ...base, quote_id: null, expires_at_ms: null, amount_in: null, amount_out: null, min_out: null, price_impact_bps: null, fee_bps: null,
      fee_amount: null, blast_fee_bps: null, blast_fee_amount: null, route_label: null, price_per_out: null, amount_in_usd: null, amount_out_usd: null, network_fee: null,
      offer_refused: null, unavailable_reason: "no_pool",
    };
  }
  const known = GATE_ANSWERS[`${inCoin.key}|${outCoin.key}|${amountIn}`];
  const inValue = (Number(amountIn) / 10 ** inCoin.decimals) * (fixturePrice(inCoin) ?? 0);
  const outPrice = fixturePrice(outCoin);
  const out = fixtureOutput(known, outPrice, inValue, outCoin.decimals);
  const offered = mode.signedIn && amountIn <= inCoin.atoms;
  return {
    ...base,
    quote_id: offered ? `q1.fixture-${inCoin.key}-${outCoin.key}-${amountIn}` : null,
    expires_at_ms: offered ? nowMs + (mode.quote === "stale" ? 0 : 20_000) : null,
    amount_in: amountIn.toString(),
    amount_out: out.toString(),
    min_out: ((out * 9_950n) / 10_000n).toString(),
    price_impact_bps: offered ? known?.impact ?? 0 : null,
    price_impact_unavailable: offered ? null : "no_dry_run",
    fee_bps: 25,
    fee_amount: ((amountIn * 25n) / 10_000n).toString(),
    // Blast's 0.5% app fee, which the output above is already net of.
    blast_fee_bps: 50,
    blast_fee_amount: ((out * 50n) / 9_950n).toString(),
    route_label: routeLabel(inCoin, outCoin),
    price_per_out: outPrice === null ? null : String(outPrice),
    amount_in_usd: known?.inUsd ?? cents(inValue),
    amount_out_usd: known?.outUsd ?? cents(inValue),
    network_fee: fixtureNetworkFee(mode),
    dry_run: offered ? "passed" : "not_run",
    offer_refused: !mode.signedIn ? "sign_in" : offered ? null : "insufficient_balance",
    unavailable_reason: null,
  };
}

/**
 * The fixture's trading capabilities: answers after a moment like the route,
 * never touches the network. `onTraded` shows the host’s toast; the form
 * settles on the button before resetting the amounts.
 */
export function fixtureTrading(input: Readonly<{
  coins: readonly WalletCoinView[];
  more: readonly WalletCoinView[];
  mode: SwapFixtureMode;
  onSignIn: () => void;
  onTraded: (outcome: TradeOutcome, quote: SocialTradeQuote) => void;
}>): CoinSheetTrading {
  const { coins, mode } = input;
  const wait = (ms: number, signal?: AbortSignal) =>
    new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, ms);
      signal?.addEventListener("abort", () => {
        clearTimeout(timer);
        reject(new DOMException("aborted", "AbortError"));
      });
    });
  return {
    signedIn: mode.signedIn,
    onSignIn: input.onSignIn,
    async requestQuote(body, signal): Promise<ApiResult<SocialTradeQuote>> {
      if (mode.quote === "none") return new Promise(() => undefined);
      await wait(180, signal);
      if (mode.quote === "error") return { status: "refused", code: "service_unavailable", retryAfterSeconds: null };
      return { status: "ok", body: fixtureQuote(body, [...coins, ...input.more], mode, Date.now()), httpStatus: 200 };
    },
    async listCoins(query, signal) {
      await wait(60, signal);
      const q = (query ?? "").toLowerCase();
      return input.more.filter((coin) => !q || coin.symbol.toLowerCase().includes(q) || coin.name.toLowerCase().includes(q));
    },
    async trade(ask) {
      await wait(1_200);
      if (mode.trade === "fail") return { status: "failed", message: "That didn’t go through", code: "execution_failed" };
      if (mode.trade === "short") return { status: "failed", message: `Not enough ${ask.inCoin.symbol}`, code: "insufficient_balance" };
      if (mode.trade === "fee" && !ask.acceptFee) return { status: "fee_required", feeMist: "2565136" };
      const outcome: TradeOutcome = { status: "traded" };
      input.onTraded(outcome, ask.quote);
      return outcome;
    },
  };
}
