import { decodeBlinkQuote, hasBlinkQuoteHash, isNativeBlinkEvmToken, isNativeBlinkSvmToken, type BlinkQuote, type Quote } from "@mayanfinance/swap-sdk";
import { normalizeStructTag, normalizeSuiAddress } from "@mysten/sui/utils";

import type { BridgeChain } from "./bridge-config.ts";
import type { DestinationToken, QuoteFacts, SourceToken } from "./bridge-model.ts";

/** What the person asked for; a quote must match all of it before any wallet call. */
export type BridgeRequest = Readonly<{
  chain: BridgeChain;
  token: SourceToken;
  to: DestinationToken;
  amountIn64: string;
  /** The Blast account's Sui address: the only recipient the card ever sends to. */
  blastAddress: string;
  /** The connected source wallet: the only refund address. */
  sourceAddress: string;
}>;

export type GuardResult = Readonly<{ ok: true; order: BlinkQuote }> | Readonly<{ ok: false; reason: string }>;

function sameSourceAddress(chain: BridgeChain, a: string, b: string): boolean {
  return chain === "solana" ? a === b : a.toLowerCase() === b.toLowerCase();
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

/**
 * Checks a bound Mayan quote before the wallet sees it: a Blink order, from the
 * chosen chain and token, for the typed amount, paying the Blast address on Sui
 * in the chosen coin, refunding the source wallet, no referrer, not expired.
 * The SDK repeats the order checks when it builds the transaction; this keeps a
 * wrong quote from ever reaching a signing prompt.
 */
export function guardQuote(quote: Quote, request: BridgeRequest, now: number): GuardResult {
  if (quote.type !== "BLINK") return { ok: false, reason: "not a Blink quote" };
  if (!hasBlinkQuoteHash(quote)) return { ok: false, reason: "no Blink order" };
  let order: BlinkQuote;
  try {
    order = decodeBlinkQuote(quote.blinkQuote);
  } catch {
    return { ok: false, reason: "unreadable Blink order" };
  }
  const params = order.orderParams;
  if (params.srcChain !== request.chain || params.dstChain !== "sui") return { ok: false, reason: "wrong chains" };
  if (!sameSourceToken(request.chain, request.token, params.srcToken)) return { ok: false, reason: "wrong source token" };
  if (order.amountIn !== request.amountIn64) return { ok: false, reason: "wrong amount" };
  if (!sameCoinType(params.dstToken, request.to.coinType)) return { ok: false, reason: "wrong destination coin" };
  if (normalizeSuiAddress(params.recipient) !== normalizeSuiAddress(request.blastAddress)) return { ok: false, reason: "wrong recipient" };
  if (!sameSourceAddress(request.chain, params.refundAddress, request.sourceAddress)) return { ok: false, reason: "wrong refund address" };
  if (params.referrers.length > 0) return { ok: false, reason: "unexpected referrer" };
  if (Date.parse(order.expiresAt) <= now) return { ok: false, reason: "expired" };
  return { ok: true, order };
}

/** The numbers the card shows, read from a quote (bound or not). */
export function quoteFacts(quote: Quote, token: SourceToken): QuoteFacts {
  const embedded = quote.blinkQuote?.crossChain;
  const usdMicros = Number(embedded?.amountInUsdMicros ?? 0);
  return {
    expectedAmountOut: quote.expectedAmountOut,
    minReceived: quote.minReceived,
    clientRelayerFeeSuccess: quote.clientRelayerFeeSuccess,
    etaSeconds: quote.etaSeconds,
    amountIn: Number(quote.effectiveAmountIn64) / 10 ** token.decimals,
    amountInUsd: usdMicros > 0 ? usdMicros / 1e6 : undefined,
  };
}
