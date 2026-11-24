import type { SocialWallet } from "../../../../../../packages/core/src/modules/social/contracts/coins.ts";
import {
  SOCIAL_TRADE_BASE_COINS,
  SOCIAL_TRADE_DEFAULT_SLIPPAGE_BPS,
  type SocialTradeQuote,
  type SocialTradeQuoteRequest,
} from "@blast/core/modules/social/contracts/trades.ts";

/**
 * Sample trade answers for the trade suites and the workspace fixtures.
 * **Tests and development only**: nothing in the product imports this file,
 * and the fixture pages answer not-found in production. Nothing here reaches a
 * route or the chain.
 *
 * The figures are the gate's: Kai's Blast wallet with $860 USDC, 412.38 SUI
 * and 600,000 KSTL (Kestrel at $0.0021) and 100,000 LUMN (Lumen at $0.0013),
 * the sale coins as `presale-fixtures.ts` types them (9 places). A sample
 * quote is shaped exactly like R3-30's answer; its impact follows a fixed
 * ladder of the trade's dollar size — `<0.01%` for $1, `0.11%` at $100, `1%`
 * at $250, `4%` at $500 (amber), `12%` at $860 (red) — so every state the
 * ticket lists is one preset or one keystroke away. It is a fixture's table,
 * not a model: the product's impact is the route's (OA-29).
 */

export const FIXTURE_USDC = SOCIAL_TRADE_BASE_COINS.usdc;
export const FIXTURE_SUI = SOCIAL_TRADE_BASE_COINS.sui;

/** The sale coins' types, as `presale-fixtures.ts` builds them. */
export const fixtureCoinType = (symbol: string) => `0x${"7a3f".padEnd(60, "0")}c91e::${symbol.toLowerCase()}::${symbol}`;

/** USD per whole coin, as decimal parts (n / d), for the sample sale coins. */
const PRICES: Readonly<Record<string, readonly [bigint, bigint]>> = {
  SUI: [342n, 100n],
  KSTL: [21n, 10_000n],
  LUMN: [13n, 10_000n],
};

const symbolOf = (coinType: string) => coinType.split("::").at(-1) ?? "";

/** Kai's sample Blast wallet. `fee: "sponsored"` is an embedded wallet; `"wallet"` a Slush session. */
export function fixtureWallet(
  fee: "sponsored" | "wallet" = "sponsored",
  atoms: Readonly<{ usdc?: bigint; kstl?: bigint; lumn?: bigint }> = {},
): SocialWallet {
  const usdc = atoms.usdc ?? 860_000_000n;
  const kstl = atoms.kstl ?? 600_000_000_000_000n;
  const lumn = atoms.lumn ?? 100_000_000_000_000n;
  const coin = (symbol: string, held: bigint, price: string, value: string, presaleId: string) => ({
    coin_type: fixtureCoinType(symbol),
    symbol,
    name: symbol === "KSTL" ? "Kestrel" : "Lumen",
    decimals: 9,
    atoms: held.toString(),
    usd_price: price,
    value_usd: value,
    icon_url: null,
    presale: { presale_id: presaleId, venue: "cetus", trading: true, multiple: null },
  });
  const dollars = (micro: bigint) => `${micro / 1_000_000n}.${(micro % 1_000_000n).toString().padStart(6, "0").slice(0, 2)}`;
  return {
    address: `0x${"ca1".padEnd(64, "0")}`,
    signer: fee === "sponsored" ? "privy" : "wallet",
    fee,
    coins: [
      { coin_type: FIXTURE_USDC, symbol: "USDC", name: "USD Coin", decimals: 6, atoms: usdc.toString(), usd_price: "1", value_usd: dollars(usdc), icon_url: null, presale: null },
      { coin_type: FIXTURE_SUI, symbol: "SUI", name: "Sui", decimals: 9, atoms: "412380000000", usd_price: "3.42", value_usd: "1410.34", icon_url: null, presale: null },
      ...(kstl > 0n ? [coin("KSTL", kstl, "0.0021", dollars((kstl * 21n) / 10_000_000n), `0x${"a".repeat(64)}`)] : []),
      ...(lumn > 0n ? [coin("LUMN", lumn, "0.0013", dollars((lumn * 13n) / 10_000_000n), `0x${"b".repeat(64)}`)] : []),
    ],
    as_of_ms: 0,
  };
}

/** The impact ladder, in basis points, by the trade's size in micro-dollars (linear between the rungs). */
const LADDER: readonly (readonly [bigint, bigint])[] = [
  [0n, 0n],
  [1_000_000n, 0n],
  [100_000_000n, 11n],
  [250_000_000n, 100n],
  [500_000_000n, 400n],
  [860_000_000n, 1_200n],
  [2_000_000_000n, 2_400n],
];

export function fixtureImpactBps(microUsd: bigint): number {
  for (let index = 1; index < LADDER.length; index += 1) {
    const [x1, y1] = LADDER[index]!;
    const [x0, y0] = LADDER[index - 1]!;
    if (microUsd <= x1) return Number(y0 + ((y1 - y0) * (microUsd - x0)) / (x1 - x0));
  }
  return 2_400;
}

export type FixtureQuoteOptions = Readonly<{
  signedIn: boolean;
  /** Who pays the fee of an offered quote. */
  fee?: "blast" | "wallet";
  nowMs: number;
  /** The wallet the quote is dry-run from: its balance decides whether it is offered. */
  wallet?: SocialWallet | null;
}>;

/**
 * A sample answer of `POST /api/social/trades/quote` for `request`: the coin
 * at its sample price less the ladder's impact, `min_out` at the default 0.5%
 * slippage, one Cetus leg. Offered (with a `quote_id` good for 20 s) only for a
 * signed-in wallet that holds the input; otherwise shown, with no impact (no
 * dry run, as the route answers it).
 */
export function fixtureTradeQuote(request: SocialTradeQuoteRequest, options: FixtureQuoteOptions): SocialTradeQuote {
  const buy = request.side === "buy";
  const coin = buy ? request.out_coin : request.in_coin;
  const symbol = symbolOf(coin);
  const [priceN, priceD] = PRICES[symbol] ?? [1n, 1_000n];
  const amountIn = BigInt(request.amount_in ?? "0");
  // The trade's size in micro-dollars: USDC at face value, or the coin at its price (9 places).
  const microUsd = buy ? amountIn : (amountIn * priceN) / (priceD * 1_000n);
  const offeredHere = options.signedIn && (options.wallet?.coins ?? []).some((held) => held.coin_type === request.in_coin && BigInt(held.atoms) >= amountIn);
  const impact = fixtureImpactBps(microUsd);
  const keep = BigInt(10_000 - impact);
  const amountOut = buy ? (amountIn * 1_000n * priceD * keep) / (priceN * 10_000n) : (microUsd * keep) / 10_000n;
  const minOut = (amountOut * BigInt(10_000 - SOCIAL_TRADE_DEFAULT_SLIPPAGE_BPS)) / 10_000n;
  const usd = (micro: bigint) => `${micro / 1_000_000n}.${(micro % 1_000_000n).toString().padStart(6, "0").slice(0, 2)}`;
  const offer: Pick<SocialTradeQuote, "quote_id" | "expires_at_ms" | "price_impact_bps" | "price_impact_unavailable" | "dry_run" | "offer_refused"> = offeredHere
    ? { quote_id: `q1.fixture_quote_${request.side}_${amountIn}`, expires_at_ms: options.nowMs + 20_000, price_impact_bps: impact, price_impact_unavailable: null, dry_run: "passed", offer_refused: null }
    : { quote_id: null, expires_at_ms: null, price_impact_bps: null, price_impact_unavailable: "no_dry_run", dry_run: "not_run", offer_refused: options.signedIn ? "insufficient_balance" : "sign_in" };
  return {
    ...offer,
    quoted_at_ms: options.nowMs,
    side: request.side,
    in_coin: request.in_coin,
    out_coin: request.out_coin,
    amount_in: amountIn.toString(),
    amount_out: amountOut.toString(),
    min_out: minOut.toString(),
    slippage_bps: SOCIAL_TRADE_DEFAULT_SLIPPAGE_BPS,
    // OA-29: the impact is a second dry run's, so a quote that was not dry-run has none, and says why.
    fee_bps: 100,
    fee_amount: ((amountIn * 100n) / 10_000n).toString(),
    blast_fee_bps: 0,
    blast_fee_amount: "0",
    route: [{ pool_id: `0x${"c".repeat(64)}`, venue: "cetus", in_coin: request.in_coin, out_coin: request.out_coin, amount_in: amountIn.toString(), amount_out: amountOut.toString() }],
    route_label: buy ? `USDC → ${symbol} · Cetus` : `${symbol} → USDC · Cetus`,
    price_per_out: buy ? (symbol === "LUMN" ? "0.0013" : "0.0021") : "1",
    amount_in_usd: usd(microUsd),
    amount_out_usd: usd(buy ? (microUsd * keep) / 10_000n : amountOut),
    network_fee: fixtureNetworkFee(options, offeredHere),
    unavailable_reason: null,
  };
}

function fixtureNetworkFee(options: FixtureQuoteOptions, offeredHere: boolean): SocialTradeQuote["network_fee"] {
  if (!options.signedIn) return null;
  const payer = options.fee ?? "blast";
  return { payer, label: payer === "blast" ? "Paid by Blast" : "Paid from your SUI", estimate_mist: offeredHere ? "2100000" : null };
}
