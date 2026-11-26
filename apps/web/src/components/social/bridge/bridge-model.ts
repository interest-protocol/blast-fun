import { USDC_COIN_TYPE } from "@blast/core/lib/sui/coin-types.ts";

import { atomsToField, parseAtoms } from "../trade/trade-ticket.ts";

import type { BridgeChain, BridgeConfig } from "./bridge-config.ts";
import { BRIDGE_CHAINS } from "./bridge-config.ts";

/** A token people can send from a source chain. `mayan` is the address Mayan quotes it by. */
export type SourceToken = Readonly<{
  symbol: string;
  decimals: number;
  mayan: string;
  native: boolean;
  /** Atoms kept back by Max so the wallet can still pay its network fee. */
  reserve: bigint;
  logo: string;
}>;

export type ChainInfo = Readonly<{ label: string; logo: string; kind: "evm" | "solana"; chainId: number | null; tokens: readonly [SourceToken, SourceToken] }>;

const NATIVE = "0x0000000000000000000000000000000000000000";

/** Local brand marks (public/blast-ui): Ethereum's mark is also ETH's on every EVM chain, Solana's is SOL's. */
const LOGO = {
  base: "/blast-ui/chains/base.svg",
  ethereum: "/blast-ui/chains/ethereum.svg",
  arbitrum: "/blast-ui/chains/arbitrum.svg",
  solana: "/blast-ui/chains/solana.svg",
  usdc: "/blast-ui/coins/usdc.svg",
  sui: "/blast-ui/coins/sui.svg",
} as const;

function usdc(mayan: string): SourceToken {
  return { symbol: "USDC", decimals: 6, mayan, native: false, reserve: 0n, logo: LOGO.usdc };
}

function eth(reserve: bigint): SourceToken {
  return { symbol: "ETH", decimals: 18, mayan: NATIVE, native: true, reserve, logo: LOGO.ethereum };
}

/** Native token first, then USDC; the reserve covers a few sends at ordinary fees. */
export const CHAINS: Readonly<Record<BridgeChain, ChainInfo>> = {
  base: { label: "Base", logo: LOGO.base, kind: "evm", chainId: 8453, tokens: [eth(20_000_000_000_000n), usdc("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913")] },
  ethereum: { label: "Ethereum", logo: LOGO.ethereum, kind: "evm", chainId: 1, tokens: [eth(2_000_000_000_000_000n), usdc("0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48")] },
  arbitrum: { label: "Arbitrum", logo: LOGO.arbitrum, kind: "evm", chainId: 42161, tokens: [eth(50_000_000_000_000n), usdc("0xaf88d065e77c8cC2239327C5EDb3A432268e5831")] },
  solana: {
    label: "Solana",
    logo: LOGO.solana,
    kind: "solana",
    chainId: null,
    tokens: [{ symbol: "SOL", decimals: 9, mayan: NATIVE, native: true, reserve: 10_000_000n, logo: LOGO.solana }, usdc("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v")],
  },
};

export type DestinationToken = Readonly<{ symbol: "SUI" | "USDC"; decimals: number; coinType: string; logo: string }>;

export const DESTINATIONS: readonly DestinationToken[] = [
  { symbol: "SUI", decimals: 9, coinType: "0x2::sui::SUI", logo: LOGO.sui },
  { symbol: "USDC", decimals: 6, coinType: USDC_COIN_TYPE, logo: LOGO.usdc },
];

/** The chains this deployment has an RPC for, in picker order. */
export function bridgeChains(config: BridgeConfig): BridgeChain[] {
  return BRIDGE_CHAINS.filter((chain) => config.rpcs[chain] !== undefined);
}

/** Typed text as atoms; null when empty, unreadable or zero. */
export function amountAtoms(text: string, token: SourceToken): bigint | null {
  const atoms = parseAtoms(text, token.decimals);
  return atoms && atoms > 0n ? atoms : null;
}

/** Max fills the balance, less the fee reserve for a native token. */
export function maxField(balance: bigint, token: SourceToken): string {
  const spendable = balance - (token.native ? token.reserve : 0n);
  return spendable > 0n ? atomsToField(spendable, token.decimals) : "0";
}

/** True when the amount, plus the fee reserve for a native token, is more than the balance. */
export function exceedsBalance(atoms: bigint, balance: bigint, token: SourceToken): boolean {
  return atoms + (token.native ? token.reserve : 0n) > balance;
}

/** The parts of a Mayan quote the card shows. */
export type QuoteFacts = Readonly<{
  expectedAmountOut: number;
  minReceived: number;
  clientRelayerFeeSuccess?: number | null;
  etaSeconds?: number;
  /** The amount sent, in tokens, and its USD value from the Blink quote, to show the fee in the source token too. */
  amountIn?: number;
  amountInUsd?: number;
}>;

export type QuoteRows = Readonly<{ amount: string; minimum: string; fee: string; eta: string }>;

const usdFormat = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 });

function amountText(value: number, decimals: number, digits = 6): string {
  return new Intl.NumberFormat("en-US", { maximumSignificantDigits: digits, maximumFractionDigits: Math.min(decimals, 8), roundingMode: "trunc" }).format(value);
}

function feeText(quote: QuoteFacts, from: SourceToken): string {
  const fee = quote.clientRelayerFeeSuccess ?? 0;
  const usd = fee > 0 && fee < 0.01 ? "< $0.01" : usdFormat.format(fee);
  const { amountIn, amountInUsd } = quote;
  // USDC is already dollars: one unit says it.
  if (!fee || !amountIn || !amountInUsd || from.symbol === "USDC") return usd;
  return `${amountText((fee * amountIn) / amountInUsd, from.decimals, 3)}\u00a0${from.symbol} · ${usd}`;
}

/** An amount from Mayan (a number or decimal text) with its symbol, to six significant digits. */
export function displayAmount(value: number | string, symbol: string): string {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? `${amountText(number, 9)}\u00a0${symbol}` : `${value}\u00a0${symbol}`;
}

/** Rows under the amount: what arrives, the floor (slippage included), Mayan's fee and time. */
export function quoteRows(quote: QuoteFacts, from: SourceToken, to: DestinationToken): QuoteRows {
  const seconds = quote.etaSeconds ?? 0;
  return {
    amount: amountText(quote.expectedAmountOut, to.decimals),
    minimum: `${amountText(quote.minReceived, to.decimals)}\u00a0${to.symbol}`,
    fee: feeText(quote, from),
    eta: seconds < 60 ? `About ${Math.max(seconds, 1)}\u00a0s` : `About ${Math.round(seconds / 60)}\u00a0min`,
  };
}

/** A coarse USD band for analytics: the BLINK cap is about $300. */
export function usdBand(usd: number | undefined): string {
  if (usd === undefined) return "unknown";
  if (usd < 10) return "<10";
  if (usd < 100) return "10-100";
  if (usd < 250) return "100-250";
  return "250+";
}

/** Mayan's explorer status, as the card shows it. */
export type TransferState = "pending" | "done" | "refunded";

export function transferState(clientStatus: string | null | undefined): TransferState {
  if (clientStatus === "COMPLETED") return "done";
  if (clientStatus === "REFUNDED") return "refunded";
  return "pending";
}

type QuoteFailure = Readonly<{ code?: unknown; data?: { minAmountIn?: unknown; maxAmountIn?: unknown } | null }>;

/** A short sentence for a failed quote, in Mayan's limits where it gives them. */
export function quoteErrorText(error: unknown, chain: ChainInfo, token: SourceToken): string {
  const { code, data } = (error ?? {}) as QuoteFailure;
  if (isPausedError(error)) return PAUSED_TEXT;
  if (code === "AMOUNT_TOO_SMALL" && typeof data?.minAmountIn === "number") return `The smallest amount is ${data.minAmountIn}\u00a0${token.symbol}. Code: bridge_amount_too_small.`;
  if (code === "AMOUNT_TOO_LARGE" && typeof data?.maxAmountIn === "number") return `The largest amount is ${data.maxAmountIn}\u00a0${token.symbol}. Code: bridge_amount_too_large.`;
  if (code === "ROUTE_NOT_FOUND") return `No route from ${chain.label} ${token.symbol} to Sui right now. Code: bridge_no_route.`;
  return QUOTE_FAILED_TEXT;
}

export const PAUSED_TEXT = "Bridging is paused. You can still deposit on Sui. Code: bridge_paused.";
export const QUOTE_FAILED_TEXT = "Couldn’t get a price. Code: bridge_quote_failed.";
/** A send that threw may still have reached the chain (Solana confirms after sending), so it never says nothing left. */
export const SEND_FAILED_TEXT = "The bridge didn’t start. Check your wallet before you try again. Code: bridge_send_failed.";

/** Mayan answers 9999 when it stops this SDK version; the card pauses and we upgrade. */
export function isPausedError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return code === 9999 || code === "9999";
}

/** What the main button says and does, in the order the checks run. */
export type BridgeAction =
  | Readonly<{ kind: "paused" | "wait" | "enter" | "short" | "quoting" | "busy" }>
  | Readonly<{ kind: "signIn" | "connect" | "switch" | "retry" | "approve" | "requote" | "bridge" }>;

export type ActionInput = Readonly<{
  paused: boolean;
  signedIn: boolean;
  blastAddress: string | null;
  sourceConnected: boolean;
  wrongChain: boolean;
  atoms: bigint | null;
  insufficient: boolean;
  quoting: boolean;
  /** The quote failed for a reason a second ask may fix. */
  quoteFailed: boolean;
  hasQuote: boolean;
  busy: boolean;
  needsApproval: boolean;
  rateChanged: boolean;
}>;

export function bridgeAction(input: ActionInput): BridgeAction {
  if (input.paused) return { kind: "paused" };
  if (!input.signedIn) return { kind: "signIn" };
  if (!input.blastAddress) return { kind: "wait" };
  if (!input.sourceConnected) return { kind: "connect" };
  if (input.wrongChain) return { kind: "switch" };
  if (input.atoms === null) return { kind: "enter" };
  if (input.insufficient) return { kind: "short" };
  if (input.busy) return { kind: "busy" };
  if (input.quoteFailed && !input.quoting) return { kind: "retry" };
  if (input.quoting || !input.hasQuote) return { kind: "quoting" };
  if (input.needsApproval) return { kind: "approve" };
  if (input.rateChanged) return { kind: "requote" };
  return { kind: "bridge" };
}

/** The button keeps its verb; a disabled one gets a reason line beside it. */
export function actionLabel(action: BridgeAction, chain: ChainInfo, token: SourceToken): string {
  switch (action.kind) {
    case "signIn":
      return "Sign in";
    case "connect":
      return "Connect wallet";
    case "switch":
      return `Switch to ${chain.label}`;
    case "approve":
      return `Approve ${token.symbol}`;
    case "retry":
      return "Try again";
    case "requote":
      return "Bridge at new rate";
    default:
      return "Bridge";
  }
}

/** Why the button is off, in one short line; null when the button or the rows already say it. */
export function actionReason(action: BridgeAction, token: SourceToken): string | null {
  switch (action.kind) {
    case "wait":
      return "Loading your account.";
    case "enter":
      return "Enter an amount.";
    case "short":
      return `Not enough ${token.symbol} for this amount.`;
    default:
      return null;
  }
}

/** Disabled states: the button only explains. */
export function actionDisabled(action: BridgeAction): boolean {
  return ["paused", "wait", "enter", "short", "quoting", "busy"].includes(action.kind);
}
