import type { Quote } from "@mayanfinance/swap-sdk";

import type { BridgeChain } from "./bridge-config.ts";
import type { BridgeRequest } from "./bridge-guard.ts";
import { transferState, type DestinationToken, type SourceToken, type TransferState } from "./bridge-model.ts";
import type { SolanaSubmissionState } from "./solana-submission.ts";

/** An EIP-1193 provider, as Privy's `getEthereumProvider()` returns it. */
export type Eip1193 = Readonly<{ request(args: { method: string; params?: unknown[] | object }): Promise<unknown> }>;

/**
 * The wallet's provider, refusing every new request once `signal` aborts:
 * `eth_requestAccounts` (a locked wallet) prompts as well as `eth_sendTransaction`.
 * A request already sent runs on, so a submitted transaction still returns its hash.
 */
export function abortableProvider(provider: Eip1193, signal: AbortSignal): Eip1193 {
  return {
    request: (args) => {
      signal.throwIfAborted();
      return provider.request(args);
    },
  };
}

export type EvmWallet = Readonly<{
  kind: "evm";
  address: string;
  chainId: number | null;
  switchChain(chainId: number): Promise<void>;
  provider(): Promise<Eip1193>;
}>;

export type SolanaWallet = Readonly<{
  kind: "solana";
  address: string;
  /** Signs a serialized transaction and returns it signed; never sends it. */
  signTransaction(transaction: Uint8Array): Promise<Uint8Array>;
}>;

export type SourceWallet = EvmWallet | SolanaWallet;

export type QuoteInput = Readonly<{
  chain: BridgeChain;
  token: SourceToken;
  to: DestinationToken;
  amountIn64: string;
  /** Both set for a bound quote (it carries a Blink order); both absent for a preview. */
  swapper?: string;
  destination?: string;
}>;

/** One bridge into the Blast address, from Mayan's explorer or just signed here. */
export type BridgeRow = Readonly<{
  hash: string;
  chain: BridgeChain | null;
  fromAmount: string;
  fromSymbol: string;
  toAmount: string | null;
  toSymbol: string;
  state: TransferState;
  /** ISO time the bridge started. */
  at: string;
}>;

/**
 * Everything the card asks of Mayan, the source chain RPCs and the wallets.
 * `mayan-sdk.ts` implements it with the Mayan SDK; tests pass a fake.
 */
export type BridgeSdk = Readonly<{
  tokens(chain: BridgeChain): Promise<readonly SourceToken[]>;
  quote(input: QuoteInput): Promise<Quote>;
  balance(chain: BridgeChain, token: SourceToken, owner: string): Promise<bigint>;
  /** EVM tokens only: whether the router may spend the quote's amount already. */
  allowanceEnough(quote: Quote, wallet: EvmWallet, chain: BridgeChain): Promise<boolean>;
  /** `signal` aborts before any wallet request that has not started yet. */
  approve(quote: Quote, wallet: EvmWallet, chain: BridgeChain, signal: AbortSignal): Promise<void>;
  /**
   * Signs and sends the guarded quote; resolves with the source transaction hash.
   * `onSigned` gets the hash as soon as it exists (Solana: once signed, before sending).
   * `signal` aborts before the wallet is asked, if it has not been asked yet.
   */
  send(quote: Quote, request: BridgeRequest, wallet: SourceWallet, onSigned: (hash: string) => void, signal: AbortSignal): Promise<string>;
  checkSolanaSubmission(address: string, signal: AbortSignal): Promise<Readonly<{ signature: string; state: SolanaSubmissionState }> | null>;
  history(blastAddress: string): Promise<BridgeRow[]>;
  /** Mayan's state for a source transaction, and what arrived once it has. */
  status(hash: string): Promise<TransferStatus>;
}>;

export type TransferStatus = Readonly<{ state: TransferState; toAmount: string | null }>;

export const MAYAN_EXPLORER = "https://explorer-api.mayan.finance";

/** Mayan's explorer names chains by Wormhole id. */
const WORMHOLE_CHAINS: Readonly<Record<string, BridgeChain>> = { "1": "solana", "2": "ethereum", "5": "polygon", "23": "arbitrum", "24": "optimism", "30": "base" };
const SUI_WORMHOLE_ID = "21";

type ExplorerSwap = Readonly<{
  sourceTxHash?: unknown;
  sourceChain?: unknown;
  destChain?: unknown;
  destAddress?: unknown;
  fromAmount?: unknown;
  fromTokenSymbol?: unknown;
  toAmount?: unknown;
  toTokenSymbol?: unknown;
  clientStatus?: unknown;
  initiatedAt?: unknown;
}>;

const text = (value: unknown): string | null => (typeof value === "string" && value !== "" ? value : null);

/**
 * The explorer's `trader` filter includes the recipient of an inbound swap.
 * Keep the rows that paid the Blast address on Sui, newest first.
 */
export function explorerRows(json: unknown, blastAddress: string, limit = 5): BridgeRow[] {
  const data = (json as { data?: unknown } | null)?.data;
  if (!Array.isArray(data)) return [];
  const rows: BridgeRow[] = [];
  for (const swap of data as ExplorerSwap[]) {
    const hash = text(swap.sourceTxHash);
    const at = text(swap.initiatedAt);
    if (!hash || !at || String(swap.destChain) !== SUI_WORMHOLE_ID || text(swap.destAddress)?.toLowerCase() !== blastAddress.toLowerCase()) continue;
    rows.push({
      hash,
      chain: WORMHOLE_CHAINS[String(swap.sourceChain)] ?? null,
      fromAmount: text(swap.fromAmount) ?? "",
      fromSymbol: text(swap.fromTokenSymbol) ?? "",
      toAmount: text(swap.toAmount),
      toSymbol: text(swap.toTokenSymbol) ?? "",
      state: transferState(text(swap.clientStatus)),
      at,
    });
  }
  return rows.sort((a, b) => Date.parse(b.at) - Date.parse(a.at)).slice(0, limit);
}

/** A just-signed bridge stays first until the explorer lists it, then the explorer's row wins. */
export function mergeRows(sent: readonly BridgeRow[], listed: readonly BridgeRow[], limit = 5): BridgeRow[] {
  const known = new Set(listed.map((row) => row.hash));
  return [...sent.filter((row) => !known.has(row.hash)), ...listed].slice(0, limit);
}

export function explorerLink(hash: string): string {
  return `https://explorer.mayan.finance/tx/${encodeURIComponent(hash)}`;
}
