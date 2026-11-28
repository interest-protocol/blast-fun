import { USDC_COIN_TYPE } from "@blast/core/lib/sui/coin-types.ts";
import { groupedExact } from "@blast/core/web/exact-amount.ts";
import { NO_VALUE } from "@blast/core/web/format.ts";

import { atomsToField, parseAtoms, sellPresetAtoms, type SellPreset } from "../trade/trade-ticket.ts";

import type { BridgeChain } from "./bridge-config.ts";

/** A token people can send from a source chain. `mayan` is the address Mayan quotes it by. */
export type SourceToken = Readonly<{
  symbol: string;
  decimals: number;
  mayan: string;
  native: boolean;
  /** Atoms kept back so the wallet can still pay its network fee. */
  reserve: bigint;
  logo: string | null;
  name?: string;
  standard?: "spl" | "spl2022";
}>;

export type ChainInfo = Readonly<{ label: string; logo: string; kind: "evm" | "solana"; chainId: number | null; tokens: readonly [SourceToken, SourceToken] }>;

const NATIVE = "0x0000000000000000000000000000000000000000";

/** Local brand marks (public/blast-ui): Ethereum's mark is also ETH's on every EVM chain, Polygon's is POL's, Solana's is SOL's. */
const LOGO = {
  base: "/blast-ui/chains/base.svg",
  ethereum: "/blast-ui/chains/ethereum.svg",
  arbitrum: "/blast-ui/chains/arbitrum.svg",
  optimism: "/blast-ui/chains/optimism.svg",
  polygon: "/blast-ui/chains/polygon.svg",
  solana: "/blast-ui/chains/solana.svg",
  usdc: "/blast-ui/coins/usdc.svg",
  sui: "/blast-ui/coins/sui.svg",
} as const;

function usdc(mayan: string, standard?: SourceToken["standard"]): SourceToken {
  return { symbol: "USDC", name: "USD Coin", decimals: 6, mayan, native: false, reserve: 0n, logo: LOGO.usdc, standard };
}

function eth(reserve: bigint): SourceToken {
  return { symbol: "ETH", name: "Ether", decimals: 18, mayan: NATIVE, native: true, reserve, logo: LOGO.ethereum };
}

/** Native token first, then USDC; the reserve covers a few sends at ordinary fees. */
export const CHAINS: Readonly<Record<BridgeChain, ChainInfo>> = {
  base: { label: "Base", logo: LOGO.base, kind: "evm", chainId: 8453, tokens: [eth(20_000_000_000_000n), usdc("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913")] },
  ethereum: { label: "Ethereum", logo: LOGO.ethereum, kind: "evm", chainId: 1, tokens: [eth(2_000_000_000_000_000n), usdc("0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48")] },
  arbitrum: { label: "Arbitrum", logo: LOGO.arbitrum, kind: "evm", chainId: 42161, tokens: [eth(50_000_000_000_000n), usdc("0xaf88d065e77c8cC2239327C5EDb3A432268e5831")] },
  optimism: { label: "Optimism", logo: LOGO.optimism, kind: "evm", chainId: 10, tokens: [eth(20_000_000_000_000n), usdc("0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85")] },
  polygon: {
    label: "Polygon",
    logo: LOGO.polygon,
    kind: "evm",
    chainId: 137,
    tokens: [{ symbol: "POL", name: "Polygon", decimals: 18, mayan: NATIVE, native: true, reserve: 300_000_000_000_000_000n, logo: LOGO.polygon }, usdc("0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359")],
  },
  solana: {
    label: "Solana",
    logo: LOGO.solana,
    kind: "solana",
    chainId: null,
    tokens: [{ symbol: "SOL", name: "Solana", decimals: 9, mayan: NATIVE, native: true, reserve: 10_000_000n, logo: LOGO.solana }, usdc("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", "spl")],
  },
};

/** Solana mints use case-sensitive base58; EVM addresses can have mixed-case checksums. */
export function sourceAddressKey(chain: BridgeChain, address: string): string {
  return chain === "solana" ? address : address.toLowerCase();
}

export type DestinationToken = Readonly<{
  symbol: "SUI" | "USDC";
  decimals: number;
  coinType: string;
  /** The coin's two metadata objects on Sui mainnet (read 2026-11-28). An auction order signs one of them as the coin to deliver. */
  metadataId: string;
  currencyId: string;
  logo: string;
}>;

export const DESTINATIONS: readonly DestinationToken[] = [
  {
    symbol: "SUI",
    decimals: 9,
    coinType: "0x2::sui::SUI",
    metadataId: "0x9258181f5ceac8dbffb7030890243caed69a9599d2886d957a9cb7656af3bdb3",
    currencyId: "0xf256d3fb6a50eaa748d94335b34f2982fbc3b63ceec78cafaa29ebc9ebaf2bbc",
    logo: LOGO.sui,
  },
  {
    symbol: "USDC",
    decimals: 6,
    coinType: USDC_COIN_TYPE,
    metadataId: "0x69b7a7c3c200439c1b5f3b19d7d495d5966d5f08de66c69276152f8db3992ec6",
    currencyId: "0x75cfbbf8c962d542e99a1d15731e6069f60a00db895407785b15d14f606f2b4a",
    logo: LOGO.usdc,
  },
];

/** Typed text as atoms; null when empty, unreadable or zero. */
export function amountAtoms(text: string, token: SourceToken): bigint | null {
  const atoms = parseAtoms(text, token.decimals);
  return atoms && atoms > 0n ? atoms : null;
}

/** The full source precision, including token balances smaller than one millionth. */
export function bridgeAmountField(atoms: bigint, decimals: number): string {
  return groupedExact({ n: atoms, scale: decimals }, decimals);
}

/** The balance line: six places, never rounded up. A balance too small for that shows in full. */
export function bridgeBalanceText(atoms: bigint, decimals: number): string {
  const short = atomsToField(atoms, decimals);
  return atoms === 0n || /[1-9]/.test(short) ? short : bridgeAmountField(atoms, decimals);
}

/** Apply the preset to the balance available after the native fee reserve. */
export function presetField(balance: bigint, token: SourceToken, preset: SellPreset): string {
  const spendable = balance - (token.native ? token.reserve : 0n);
  const atoms = sellPresetAtoms(preset, { atoms: spendable > 0n ? spendable : 0n, decimals: token.decimals });
  return bridgeAmountField(atoms, token.decimals);
}

/** True when the amount, plus the fee reserve for a native token, is more than the balance. */
export function exceedsBalance(atoms: bigint, balance: bigint, token: SourceToken): boolean {
  return atoms + (token.native ? token.reserve : 0n) > balance;
}

/** The parts of a Mayan quote the card shows. */
export type QuoteFacts = Readonly<{
  expectedAmountOut: number;
  minReceived: number;
  /** Mayan's fee in dollars; null or absent when the quote does not say. */
  fee?: number | null;
  etaSeconds?: number;
  /** The amount sent, in tokens, and its USD value from the Blink quote, to show the fee in the source token too. */
  amountIn?: number;
  amountInUsd?: number;
}>;

export type QuoteRows = Readonly<{ amount: string; minimum: string; fee: string; eta: string }>;

const usdFormat = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** The significant digits an amount shows. */
export const SHOWN_DIGITS = 6;

/**
 * Drops digits instead of rounding, so a minimum never shows more than Mayan guarantees.
 * Cut here too because Firefox before 116 ignores `roundingMode` and rounds up.
 */
export function amountText(value: number, decimals: number, digits = SHOWN_DIGITS): string {
  return new Intl.NumberFormat("en-US", { maximumSignificantDigits: digits, maximumFractionDigits: Math.min(decimals, 8), roundingMode: "trunc" }).format(cutDigits(value, digits));
}

/**
 * `value` cut, never rounded, to `digits` significant digits. It cuts the
 * shortest decimal text of the number, so no multiplication adds float noise.
 */
export function cutDigits(value: number, digits: number): number {
  if (value === 0 || !Number.isFinite(value)) return value;
  const [mantissa = "", exponent = "0"] = value.toExponential().split("e");
  const sign = mantissa.startsWith("-") ? "-" : "";
  const kept = mantissa.replace(/[-.]/g, "").slice(0, digits);
  return Number(`${sign}${kept[0]}.${kept.slice(1) || "0"}e${exponent}`);
}

function feeText(quote: QuoteFacts, from: SourceToken): string {
  const { fee } = quote;
  // A quote without a fee says nothing about it: never show that as $0.00.
  if (fee === null || fee === undefined) return NO_VALUE;
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

function etaText(seconds: number): string {
  return seconds < 60 ? `About ${Math.max(seconds, 1)}\u00a0s` : `About ${Math.round(seconds / 60)}\u00a0min`;
}

/** Rows under the amount: what arrives, the floor (slippage included), Mayan's fee and time. */
export function quoteRows(quote: QuoteFacts, from: SourceToken, to: DestinationToken): QuoteRows {
  const seconds = quote.etaSeconds;
  return {
    amount: amountText(quote.expectedAmountOut, to.decimals),
    minimum: `${amountText(quote.minReceived, to.decimals)}\u00a0${to.symbol}`,
    fee: feeText(quote, from),
    eta: typeof seconds === "number" ? etaText(seconds) : NO_VALUE,
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

type QuoteFailure = Readonly<{ code?: unknown; message?: unknown; data?: { minAmountIn?: unknown; maxAmountIn?: unknown } | null }>;

/** USDC is the coin most likely to have a price, so offer it unless it is the coin that failed. */
function noRouteText(chain: ChainInfo, token: SourceToken): string {
  const isUsdc = token.mayan.toLowerCase() === chain.tokens[1].mayan.toLowerCase();
  return `No price for ${token.symbol}. ${isUsdc ? "Try another chain" : "Bridge USDC"}. Code: bridge_no_route.`;
}

/** Mayan names its current limit only in the message, in the source coin. Cut, so the figure still fits. */
function overLimitText(message: unknown, token: SourceToken): string {
  const stated = typeof message === "string" ? /Max per swap: (\d+(?:\.\d+)?)/.exec(message)?.[1] : undefined;
  const limit = stated === undefined ? null : `Largest right now: ${amountText(Number(stated), token.decimals, 4)}\u00a0${token.symbol}.`;
  return `${limit ?? "Try a smaller amount."} Code: bridge_amount_too_large.`;
}

/** A short sentence for a failed quote, in Mayan's limits where it gives them. */
export function quoteErrorText(error: unknown, chain: ChainInfo, token: SourceToken): string {
  const { code, data, message } = (error ?? {}) as QuoteFailure;
  if (isPausedError(error)) return PAUSED_TEXT;
  if (code === "ROUTE_NOT_FOUND") return noRouteText(chain, token);
  if (code === "BRIDGE_LIMIT_EXCEEDED" || code === "ALLOWANCE_TOO_LOW") return overLimitText(message, token);
  if (code === "AMOUNT_TOO_SMALL" && typeof data?.minAmountIn === "number") return `The smallest amount is ${data.minAmountIn}\u00a0${token.symbol}. Code: bridge_amount_too_small.`;
  if (code === "AMOUNT_TOO_LARGE" && typeof data?.maxAmountIn === "number") return `The largest amount is ${data.maxAmountIn}\u00a0${token.symbol}. Code: bridge_amount_too_large.`;
  return QUOTE_FAILED_TEXT;
}

export const PAUSED_TEXT = "Bridging is paused. You can still deposit on Sui. Code: bridge_paused.";
export const QUOTE_FAILED_TEXT = "Couldn’t get a price. Code: bridge_quote_failed.";
export const BALANCE_FAILED_TEXT = "Couldn’t load the balance. Code: bridge_balance_failed.";
export const TOKENS_FAILED_TEXT = "Couldn’t load tokens. Code: bridge_tokens_failed.";
export const LOAD_FAILED_TEXT = "Bridge to Sui couldn’t load. Code: bridge_load_failed.";
export const SEND_FAILED_TEXT = "The bridge didn’t start. Check your wallet before you try again. Code: bridge_send_failed.";

/**
 * This SDK version is too old for Mayan: their SDK throws 9999 and their price API
 * answers `SDK_VERSION_TOO_OLD`. The card pauses and we upgrade.
 */
export function isPausedError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return code === 9999 || code === "9999" || code === "SDK_VERSION_TOO_OLD";
}

/** What the main button says and does, in the order the checks run. */
export type BridgeAction =
  | Readonly<{ kind: "paused" | "wait" | "enter" | "balance" | "short" | "quoting" | "busy" }>
  | Readonly<{ kind: "signIn" | "connect" | "switch" | "retry" | "approve" | "requote" | "checkSolana" | "bridge" }>;

export type ActionInput = Readonly<{
  paused: boolean;
  signedIn: boolean;
  blastAddress: string | null;
  sourceConnected: boolean;
  wrongChain: boolean;
  atoms: bigint | null;
  balanceReady: boolean;
  insufficient: boolean;
  quoting: boolean;
  /** The quote failed for a reason a second ask may fix. */
  quoteFailed: boolean;
  hasQuote: boolean;
  busy: boolean;
  solanaPending?: boolean;
  needsApproval: boolean;
  rateChanged: boolean;
}>;

export function bridgeAction(input: ActionInput): BridgeAction {
  if (input.paused) return { kind: "paused" };
  if (!input.signedIn) return { kind: "signIn" };
  if (!input.blastAddress) return { kind: "wait" };
  if (!input.sourceConnected) return { kind: "connect" };
  if (input.wrongChain) return { kind: "switch" };
  if (input.busy) return { kind: "busy" };
  if (input.solanaPending) return { kind: "checkSolana" };
  if (input.atoms === null) return { kind: "enter" };
  if (!input.balanceReady) return { kind: "balance" };
  if (input.insufficient) return { kind: "short" };
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
      return `Connect ${chain.label} wallet`;
    case "switch":
      return `Switch to ${chain.label}`;
    case "approve":
      return `Approve ${token.symbol}`;
    case "retry":
      return "Try again";
    case "checkSolana":
      return "Check Solana transfer";
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
    case "balance":
      return "Checking your balance.";
    case "short":
      return `Not enough ${token.symbol} for this amount.`;
    case "checkSolana":
      return "Check the last Solana transfer before sending again.";
    default:
      return null;
  }
}

/** Disabled states: the button only explains. */
export function actionDisabled(action: BridgeAction): boolean {
  return ["paused", "wait", "enter", "balance", "short", "quoting", "busy"].includes(action.kind);
}
