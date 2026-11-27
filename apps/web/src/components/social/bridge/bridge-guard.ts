import { compareExact, exactAtoms, exactNumber } from "@blast/core/web/exact-amount.ts";
import { decodeBlinkQuote, getWormholeChainIdByName, hasBlinkQuoteHash, isNativeBlinkEvmToken, isNativeBlinkSvmToken, type BlinkQuote, type Quote } from "@mayanfinance/swap-sdk";
import { normalizeStructTag, normalizeSuiAddress } from "@mysten/sui/utils";

import type { BridgeChain } from "./bridge-config.ts";
import { CHAINS, sourceAddressKey, type DestinationToken, type QuoteFacts, type SourceToken } from "./bridge-model.ts";

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

/**
 * Checks a bound Mayan quote before the wallet sees it: a Blink order, from the
 * chosen chain and token, for the typed amount, paying the Blast address on Sui
 * in the chosen coin, refunding the source wallet, no referrer, not gasless,
 * not expired.
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
