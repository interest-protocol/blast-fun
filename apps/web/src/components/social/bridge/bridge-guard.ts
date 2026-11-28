import { compareExact, exactAtoms, exactNumber } from "@blast/core/web/exact-amount.ts";
import { addresses, decodeBlinkQuote, getWormholeChainIdByName, hasBlinkQuoteHash, isNativeBlinkEvmToken, isNativeBlinkSvmToken, type BlinkQuote, type Quote } from "@mayanfinance/swap-sdk";
import { isValidSuiAddress, normalizeStructTag, normalizeSuiAddress } from "@mysten/sui/utils";

import type { BridgeChain } from "./bridge-config.ts";
import { CHAINS, sourceAddressKey, type DestinationToken, type QuoteFacts, type SourceToken } from "./bridge-model.ts";
import type { QuoteInput } from "./bridge-sdk.ts";

/** What the person asked for; a quote must match all of it before any wallet call. */
export type BridgeRequest = Readonly<{
  chain: BridgeChain;
  token: SourceToken;
  to: DestinationToken;
  amountIn64: string;
  /** The Blast account's Sui address: the only recipient the card ever sends to. */
  blastAddress: string;
  /** The connected wallet sending the funds. Blink also refunds to this address. */
  sourceAddress: string;
}>;

export type GuardResult = Readonly<{ ok: true }> | Readonly<{ ok: false; reason: string }>;

function sameSourceAddress(chain: BridgeChain, a: string, b: string): boolean {
  return sourceAddressKey(chain, a) === sourceAddressKey(chain, b);
}

function sameSourceToken(chain: BridgeChain, token: SourceToken, address: string): boolean {
  if (token.native) return chain === "solana" ? isNativeBlinkSvmToken(address) || isNativeBlinkEvmToken(address) : isNativeBlinkEvmToken(address);
  return sameSourceAddress(chain, token.mayan, address);
}

function sameCoinType(a: string, b: string): boolean {
  try {
    return normalizeStructTag(a) === normalizeStructTag(b);
  } catch {
    return false;
  }
}

function coversQuotedMinimum(quote: Quote, decimals: number, signedMinimum: string): boolean {
  const shown = exactNumber(quote.minReceived);
  const quoted = exactAtoms(quote.minReceivedBaseUnits, decimals);
  const signed = BigInt(signedMinimum);
  return shown !== null && quoted !== null && signed >= quoted.n && compareExact({ n: signed, scale: decimals }, shown) >= 0;
}

const PASSED: GuardResult = { ok: true };

function refused(reason: string): GuardResult {
  return { ok: false, reason };
}

/** What a quote must answer: the chain, both coins and the amount we asked Mayan to price. */
export type QuoteAsk = Pick<QuoteInput, "chain" | "token" | "to" | "amountIn64">;

/** The source side of the quote. The SDK builds the approvals and token transfers from these fields. */
function sourceRefusal(quote: Quote, { chain, token }: QuoteAsk): string | null {
  const from = quote.fromToken;
  if (from?.chainId !== (CHAINS[chain].chainId ?? 0) || from.wChainId !== getWormholeChainIdByName(chain)) return "wrong chains";
  if (typeof from.contract !== "string" || !sameSourceToken(chain, token, from.contract)
    || from.decimals !== token.decimals || (token.standard !== undefined && from.standard !== token.standard)) {
    return "wrong source token";
  }
  return null;
}

/** The order Mayan's price API tries them: fastest first. */
const ROUTE_ORDER = ["FAST_MCTP", "MCTP", "BLINK"] as const;
/** Our limit, not Mayan's rule: 500 bps is the most its price API documents for `slippageBps`. */
const MAX_SLIPPAGE_BPS = 500;
/** Our margin, not Mayan's rule: time left for the wallet prompt and the source chain. */
const DEADLINE_HEADROOM_MS = 60_000;

const usdcAtoms = (value: number) => Math.round(value * 1e6);

/**
 * Our check that what the SDK signs covers the minimum the card shows. An
 * auction order signs `minAmountOut` (SUI is cut to eight decimals). Without an
 * auction no minimum is signed: Circle moves USDC, less the signed fees.
 */
function coversShownMinimum(quote: Quote, to: DestinationToken): boolean {
  if (quote.hasAuction) return quote.minAmountOut >= quote.minReceived;
  if (to.symbol !== "USDC") return false;
  // The SDK swaps to USDC first unless the source coin is the route's own input coin.
  const input = quote.type === "MCTP" ? quote.mctpInputContract : quote.fastMctpInputContract;
  const bridged = quote.fromToken.contract === input ? Number(quote.effectiveAmountIn64) : usdcAtoms(quote.minMiddleAmount ?? Number.NaN);
  // The EVM builder signs `redeemRelayerFee`, the Solana one `redeemRelayerFee64`.
  const redeem = Math.max(usdcAtoms(quote.redeemRelayerFee), Number(quote.redeemRelayerFee64 ?? 0));
  const circle = Number(quote.circleMaxFee64 ?? 0);
  return bridged - redeem - circle >= usdcAtoms(quote.minReceived);
}

/**
 * Whether the quote that came back is for what we asked, so the card may show it:
 * the chains, the source coin and amount, the coin on Sui, no referrer, no gas
 * drop, not gasless, a usable minimum and slippage, and not expired. A Blink
 * order carries its own expiry, checked before sending.
 */
export function checkQuote(quote: Quote, ask: QuoteAsk, now: number): GuardResult {
  if (!ROUTE_ORDER.some((route) => route === quote.type)) return refused("unsupported route");
  if (quote.fromChain !== ask.chain || quote.toChain !== "sui") return refused("wrong chains");
  const source = sourceRefusal(quote, ask);
  if (source) return refused(source);
  if (quote.effectiveAmountIn64 !== ask.amountIn64) return refused("wrong amount");
  if (!sameCoinType(quote.toToken?.contract, ask.to.coinType)) return refused("wrong destination coin");
  if (quote.referrerBps) return refused("unexpected referrer");
  if (quote.gasDrop) return refused("unexpected gas drop");
  if (quote.gasless) return refused("gasless order");
  if (!(quote.minReceived > 0 && quote.minReceived <= quote.expectedAmountOut)) return refused("wrong minimum output");
  if (!(quote.slippageBps >= 0 && quote.slippageBps <= MAX_SLIPPAGE_BPS)) return refused("wrong slippage");
  if (quote.type === "BLINK") return PASSED;
  if (!(Number(quote.deadline64) * 1000 > now + DEADLINE_HEADROOM_MS)) return refused("expired");
  return coversShownMinimum(quote, ask.to) ? PASSED : refused("unsigned minimum output");
}

/**
 * Our check before an EVM send: Mayan's SDK sends the MCTP routes to its
 * Forwarder contract. A Blink order has its own contracts.
 */
export function assertSendTarget(quote: Quote, to: unknown): void {
  if (quote.type !== "BLINK" && to !== addresses.MAYAN_FORWARDER_CONTRACT) {
    throw new Error(`Unexpected ${quote.type} contract ${to}`);
  }
}

/** The first route in our order whose quote passes `checkQuote`. */
export function pickRoute(quotes: readonly Quote[], ask: QuoteAsk, now: number): Quote | undefined {
  for (const route of ROUTE_ORDER) {
    const quote = quotes.find((candidate) => candidate.type === route && checkQuote(candidate, ask, now).ok);
    if (quote) return quote;
  }
  return undefined;
}

/**
 * Checks a bound Mayan quote before any wallet call. A Blink order is read in
 * full. For MCTP and Fast MCTP, Mayan's way: check the quote and the recipient
 * we hand its SDK, then let the SDK build the transaction.
 */
export function guardQuote(quote: Quote, request: BridgeRequest, now: number): GuardResult {
  if (quote.type === "BLINK") return guardBlinkQuote(quote, request, now);
  const checked = checkQuote(quote, request, now);
  if (!checked.ok) return checked;
  // The Blast address is the only recipient, and where a refund goes.
  const recipient = normalizeSuiAddress(request.blastAddress);
  return isValidSuiAddress(recipient) && BigInt(recipient) !== 0n ? PASSED : refused("wrong recipient");
}

/**
 * Checks a bound Mayan quote before the wallet sees it: a Blink order, from the
 * chosen chain and token, for the typed amount, paying the Blast address on Sui
 * in the chosen coin, refunding the source wallet, no referrer, not gasless,
 * not expired.
 * The SDK repeats the order checks when it builds the transaction; this keeps a
 * wrong quote from ever reaching a signing prompt.
 */
function guardBlinkQuote(quote: Quote, request: BridgeRequest, now: number): GuardResult {
  if (quote.type !== "BLINK") return { ok: false, reason: "not a Blink quote" };
  if (!hasBlinkQuoteHash(quote)) return { ok: false, reason: "no Blink order" };
  let order: BlinkQuote;
  try {
    order = decodeBlinkQuote(quote.blinkQuote);
  } catch {
    return { ok: false, reason: "unreadable Blink order" };
  }
  // Gasless orders take another SDK path (Permit2 or a sponsored Solana deposit) that this card never builds.
  if (quote.gasless || order.gasless) return { ok: false, reason: "gasless order" };
  const params = order.orderParams;
  const { chain, token, amountIn64 } = request;
  if (params.srcChain !== chain || params.dstChain !== "sui" || quote.fromChain !== chain || quote.toChain !== "sui") {
    return { ok: false, reason: "wrong chains" };
  }
  // The SDK uses the outer fields for ERC-20 approvals and SPL transfer instructions.
  const from = quote.fromToken;
  if (from?.chainId !== (CHAINS[chain].chainId ?? 0) || from.wChainId !== getWormholeChainIdByName(chain)) {
    return { ok: false, reason: "wrong chains" };
  }
  if (typeof from.contract !== "string" || !sameSourceToken(chain, token, from.contract) || !sameSourceToken(chain, token, params.srcToken)
    || from.decimals !== token.decimals || (token.standard !== undefined && from.standard !== token.standard)) {
    return { ok: false, reason: "wrong source token" };
  }
  if (quote.effectiveAmountIn64 !== amountIn64 || order.amountIn !== amountIn64 || String(params.expectedAmountIn) !== amountIn64) {
    return { ok: false, reason: "wrong amount" };
  }
  if (!sameCoinType(params.dstToken, request.to.coinType)) return { ok: false, reason: "wrong destination coin" };
  if (!coversQuotedMinimum(quote, request.to.decimals, params.minAmountOut)) {
    return { ok: false, reason: "wrong minimum output" };
  }
  if (normalizeSuiAddress(params.recipient) !== normalizeSuiAddress(request.blastAddress)) return { ok: false, reason: "wrong recipient" };
  if (!sameSourceAddress(request.chain, params.refundAddress, request.sourceAddress)) return { ok: false, reason: "wrong refund address" };
  if (params.referrers.length > 0) return { ok: false, reason: "unexpected referrer" };
  if (!(Date.parse(order.expiresAt) > now)) return { ok: false, reason: "expired" };
  return { ok: true };
}

/**
 * Mayan's fee in dollars: the relayer fee, the protocol fee (on live quotes,
 * missing from the SDK's types) and Circle's fee in USDC atoms. Null when one
 * is missing: a partial sum would show less than the person pays.
 */
function totalFee(quote: Quote): number | null {
  const circle = quote.circleMaxFee64;
  const parts = [
    quote.clientRelayerFeeSuccess,
    (quote as Readonly<{ protocolFeeUsd?: unknown }>).protocolFeeUsd,
    typeof circle === "string" && /^\d+$/.test(circle) ? Number(circle) / 1e6 : null,
  ];
  let total = 0;
  for (const part of parts) {
    if (typeof part !== "number" || !Number.isFinite(part)) return null;
    total += part;
  }
  return total;
}

/** The numbers the card shows, read from a quote (bound or not). */
export function quoteFacts(quote: Quote, token: SourceToken): QuoteFacts {
  const embedded = quote.blinkQuote?.crossChain;
  const usdMicros = Number(embedded?.amountInUsdMicros ?? 0);
  return {
    expectedAmountOut: quote.expectedAmountOut,
    minReceived: quote.minReceived,
    // A Blink order states one fee; the MCTP routes add Mayan's and Circle's.
    fee: quote.type === "BLINK" ? quote.clientRelayerFeeSuccess : totalFee(quote),
    etaSeconds: quote.etaSeconds,
    amountIn: Number(quote.effectiveAmountIn64) / 10 ** token.decimals,
    amountInUsd: usdMicros > 0 ? usdMicros / 1e6 : undefined,
  };
}
