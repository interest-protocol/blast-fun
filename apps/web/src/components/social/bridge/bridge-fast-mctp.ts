import { Interface, ZeroHash, type TransactionRequest } from "ethers";
import type { Quote } from "@mayanfinance/swap-sdk";
import { isValidSuiAddress, normalizeSuiAddress } from "@mysten/sui/utils";

import type { QuoteInput } from "./bridge-sdk.ts";
import type { BridgeRequest } from "./bridge-guard.ts";
import { CHAINS, DESTINATIONS } from "./bridge-model.ts";

// Mayan's verified Base contracts. The quote cannot choose a spender or protocol.
const FORWARDER = "0x337685fdab40d39bd02028545a4ffa7d287cc3e2";
const FAST_MCTP = "0xc1062b7c5dc8e4b1df9f200fe360cdc0ed6e7741";
const BASE_USDC = CHAINS.base.tokens[1].mayan.toLowerCase();
const SUI_USDC = DESTINATIONS[1].coinType;
const SUI_CCTP_DOMAIN = 8;
const FAST_FINALITY = 1;
const DIRECT_BRIDGE = 1;
const forwarder = new Interface(["function forwardERC20(address,uint256,(uint256,uint256,uint8,bytes32,bytes32),address,bytes)"]);
const fastMctp = new Interface(["function bridge(address,uint256,uint64,uint256,uint64,bytes32,uint32,bytes32,uint8,uint8,uint32,bytes)"]);
const erc20 = new Interface(["function approve(address,uint256)"]);

export function supportsFastMctp({ chain, token, to }: Pick<QuoteInput, "chain" | "token" | "to">): boolean {
  return chain === "base" && !token.native && token.decimals === 6
    && token.mayan.toLowerCase() === BASE_USDC && to.coinType === SUI_USDC && to.decimals === 6;
}

function unsigned(value: unknown): bigint | null {
  return typeof value === "string" && /^\d{1,20}$/.test(value) ? BigInt(value) : null;
}

/** Limit Fast MCTP to a direct transfer of canonical USDC with no auxiliary actions or referrer. */
export function fastMctpTerms(quote: Quote, input: QuoteInput, now: number) {
  if (!supportsFastMctp(input) || quote.type !== "FAST_MCTP" || quote.fromChain !== "base" || quote.toChain !== "sui"
    || quote.onlyBridging !== true || quote.hasAuction !== false || quote.gasless !== false
    || quote.fromToken?.chainId !== CHAINS.base.chainId || quote.fromToken.decimals !== 6
    || quote.fromToken.contract?.toLowerCase() !== BASE_USDC || quote.fastMctpInputContract?.toLowerCase() !== BASE_USDC
    || quote.toToken?.wChainId !== 21 || quote.toToken.decimals !== 6 || quote.toToken.contract !== SUI_USDC
    || quote.fastMctpMayanContract?.toLowerCase() !== FAST_MCTP || Number(quote.fastMctpMinFinality) !== FAST_FINALITY
    || quote.gasDrop !== 0 || (quote.referrerBps ?? 0) !== 0
    || quote.effectiveAmountIn64 !== input.amountIn64) {
    return null;
  }

  const amount = unsigned(input.amountIn64);
  const circleMaxFee = unsigned(quote.circleMaxFee64);
  const redeemFee = unsigned(quote.redeemRelayerFee64);
  const expected = unsigned(quote.expectedAmountOutBaseUnits);
  const deadline = unsigned(quote.deadline64);
  if (amount === null || circleMaxFee === null || redeemFee === null || expected === null
    || deadline === null || Number(deadline) * 1000 <= now
    || !Number.isSafeInteger(Number(amount)) || expected === 0n || expected + circleMaxFee + redeemFee > amount
    || !Number.isFinite(quote.minReceived) || quote.minReceived <= 0 || quote.minReceived > quote.expectedAmountOut
    || quote.expectedAmountOut !== Number(expected) / 1e6) {
    return null;
  }
  return { amount, circleMaxFee, redeemFee };
}

/**
 * Check the exact bytes sent to the wallet. A direct CCTP transfer has one recipient:
 * the Blast address on Sui. It has no Base return path or separate refund address.
 */
export function assertFastMctpPayload(transaction: TransactionRequest, quote: Quote, request: BridgeRequest, now = Date.now()): void {
  const terms = fastMctpTerms(quote, request, now);
  const recipient = normalizeSuiAddress(request.blastAddress);
  if (!terms || !isValidSuiAddress(recipient) || recipient === ZeroHash) {
    throw new Error("Invalid Fast MCTP transfer");
  }
  const bridge = fastMctp.encodeFunctionData("bridge", [
    BASE_USDC, terms.amount, terms.redeemFee, terms.circleMaxFee, 0, recipient, SUI_CCTP_DOMAIN,
    ZeroHash, 0, DIRECT_BRIDGE, FAST_FINALITY, "0x",
  ]);
  const expected = forwarder.encodeFunctionData("forwardERC20", [
    BASE_USDC, terms.amount, [0, 0, 0, ZeroHash, ZeroHash], FAST_MCTP, bridge,
  ]);
  if (transaction.to?.toString().toLowerCase() !== FORWARDER || Number(transaction.chainId) !== CHAINS.base.chainId
    || BigInt(transaction.value ?? 0) !== 0n || transaction.data?.toLowerCase() !== expected) {
    throw new Error("Fast MCTP transaction differs from the requested transfer");
  }
}

export function assertFastMctpApproval(transaction: TransactionRequest, amountIn64: string): void {
  const expected = erc20.encodeFunctionData("approve", [FORWARDER, BigInt(amountIn64)]);
  if (transaction.to?.toString().toLowerCase() !== BASE_USDC || BigInt(transaction.value ?? 0) !== 0n
    || transaction.data?.toLowerCase() !== expected) {
    throw new Error("Fast MCTP approval differs from the requested amount");
  }
}
