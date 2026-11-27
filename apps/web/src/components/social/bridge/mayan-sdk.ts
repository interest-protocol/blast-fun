import {
  fetchQuote,
  getAssociatedTokenAddress,
  getEvmSwapApproveTxs,
  getSwapFromEvmTxPayload,
  isEvmSwapAllowanceEnough,
  swapFromSolana,
  type Quote,
  type QuoteOptions,
} from "@mayanfinance/swap-sdk";
import { Connection, PublicKey, Transaction, VersionedTransaction } from "@solana/web3.js";
import { BrowserProvider, Contract, JsonRpcProvider, type TransactionRequest } from "ethers";

import { fetchSourceTokens } from "./bridge-catalog.ts";
import { mayanRpc, type BridgeChain } from "./bridge-config.ts";
import { assertFastMctpApproval, assertFastMctpPayload, fastMctpTerms, supportsFastMctp } from "./bridge-fast-mctp.ts";
import type { BridgeRequest } from "./bridge-guard.ts";
import { CHAINS, transferState, type SourceToken } from "./bridge-model.ts";
import { abortableProvider, explorerRows, MAYAN_EXPLORER, type BridgeSdk, type EvmWallet, type SolanaWallet } from "./bridge-sdk.ts";

/** Blink only: Mayan's one route that refunds on the source chain and needs no relayer on Sui. */
const BLINK_ONLY: QuoteOptions = { blink: true, swift: false, mctp: false, fastMctp: false, wormhole: false, shuttle: false, monoChain: false, gasless: false };
const ERC20 = ["function balanceOf(address) view returns (uint256)"];
const TOKEN_2022_PROGRAM = new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");

/** The Mayan SDK, ethers and web3.js behind the card's `BridgeSdk`, on Mayan's RPCs. */
export function mayanSdk(allowFastMctp = false): BridgeSdk {
  const evmProviders = new Map<BridgeChain, JsonRpcProvider>();
  const evm = (chain: BridgeChain): JsonRpcProvider => {
    let provider = evmProviders.get(chain);
    if (!provider) {
      provider = new JsonRpcProvider(mayanRpc(chain), CHAINS[chain].chainId ?? undefined, { staticNetwork: true });
      evmProviders.set(chain, provider);
    }
    return provider;
  };
  let solana: Connection | null = null;
  const solanaConnection = () => (solana ??= new Connection(mayanRpc("solana"), "confirmed"));

  const evmPayload = async (quote: Quote, request: BridgeRequest, wallet: EvmWallet) => {
    const { chain, blastAddress, sourceAddress } = request;
    const fastMctp = quote.type === "FAST_MCTP";
    if (fastMctp && (!allowFastMctp || !fastMctpTerms(quote, request, Date.now())
      || wallet.address.toLowerCase() !== sourceAddress.toLowerCase())) {
      throw new Error("Invalid Fast MCTP transfer");
    }
    const chainId = CHAINS[chain].chainId!;
    const payload = await getSwapFromEvmTxPayload(quote, wallet.address, blastAddress, null, wallet.address, chainId, null, null, {
      evmProvider: evm(chain),
      ...(fastMctp ? { refundAddress: blastAddress } : {}),
    });
    if (fastMctp) assertFastMctpPayload(payload, quote, request);
    return payload;
  };

  // Returns the hash once the wallet sends. `sendTransaction` would then poll the
  // wallet's own RPC with no time limit, which never ends for some smart-contract wallets.
  const sendEvm = async (wallet: EvmWallet, chain: BridgeChain, transaction: TransactionRequest, signal: AbortSignal): Promise<string> => {
    signal.throwIfAborted();
    const chainId = CHAINS[chain].chainId!;
    const provider = await wallet.provider();
    // After a close, no request reaches the wallet, so no prompt opens. The network is
    // given, not detected: ethers retries a failed detection every second, forever.
    signal.throwIfAborted();
    const signer = await new BrowserProvider(abortableProvider(provider, signal), chainId, { staticNetwork: true }).getSigner(wallet.address);
    const walletChainId = Number(await signer.provider.send("eth_chainId", []));
    if (walletChainId !== chainId) throw new Error(`Wallet is on chain ${walletChainId}, not ${chain}`);
    return signer.sendUncheckedTransaction({ ...transaction, chainId });
  };

  const solanaBalance = async (token: SourceToken, owner: string): Promise<bigint> => {
    const connection = solanaConnection();
    const key = new PublicKey(owner);
    if (token.native) return BigInt(await connection.getBalance(key));
    const program = token.standard === "spl2022" ? TOKEN_2022_PROGRAM : undefined;
    const account = getAssociatedTokenAddress(new PublicKey(token.mayan), key, true, program);
    const { value } = await connection.getParsedAccountInfo(account);
    return BigInt(value && "parsed" in value.data ? value.data.parsed.info.tokenAmount.amount : "0");
  };

  return {
    tokens: fetchSourceTokens,
    async quote(input) {
      const { chain, token, to, amountIn64, swapper, destination } = input;
      const fallback = allowFastMctp && supportsFastMctp(input);
      const quotes = await fetchQuote(
        { amountIn64, fromToken: token.mayan, fromChain: chain, toToken: to.coinType, toChain: "sui", slippageBps: "auto", swapperAddress: swapper, destinationAddress: destination },
        fallback ? { ...BLINK_ONLY, fullList: true, fastMctp: true } : BLINK_ONLY,
      );
      const quote = quotes.find(({ type }) => type === "BLINK")
        ?? (fallback ? quotes.find((result) => fastMctpTerms(result, input, Date.now())) : undefined);
      if (!quote) throw Object.assign(new Error("No supported bridge route"), { code: "ROUTE_NOT_FOUND" });
      return quote;
    },
    async balance(chain, token, owner) {
      if (chain === "solana") return solanaBalance(token, owner);
      const provider = evm(chain);
      if (token.native) return provider.getBalance(owner);
      return BigInt(await new Contract(token.mayan, ERC20, provider).getFunction("balanceOf")(owner));
    },
    allowanceEnough: (quote, wallet, chain) => isEvmSwapAllowanceEnough(quote, wallet.address, evm(chain)),
    async approve(quote, request, wallet, signal) {
      const { chain } = request;
      signal.throwIfAborted();
      if (quote.type === "FAST_MCTP") await evmPayload(quote, request, wallet);
      const provider = evm(chain);
      const transactions = await getEvmSwapApproveTxs(quote, wallet.address, provider);
      if (quote.type === "FAST_MCTP") {
        if (transactions.length !== 1) throw new Error("Unexpected Fast MCTP approval count");
        assertFastMctpApproval(transactions[0]!, request.amountIn64);
      }
      for (const transaction of transactions) {
        // react-doctor-disable-next-line react-doctor/async-await-in-loop -- Approvals are ordered (a reset to zero comes before the new allowance); each must be mined before the next is signed.
        const hash = await sendEvm(wallet, chain, transaction, signal);
        // react-doctor-disable-next-line react-doctor/async-await-in-loop -- The next approval depends on this receipt.
        const receipt = await provider.waitForTransaction(hash, 1, 120_000);
        if (receipt?.status !== 1) throw new Error("The token approval did not confirm.");
      }
    },
    async send(quote, request, wallet, onSigned, signal) {
      signal.throwIfAborted();
      if (wallet.kind === "evm") {
        const payload = await evmPayload(quote, request, wallet);
        const hash = await sendEvm(wallet, request.chain, { to: payload.to, data: payload.data, value: payload.value }, signal);
        onSigned(hash);
        return hash;
      }
      if (quote.type === "FAST_MCTP") throw new Error("Fast MCTP requires a Base wallet");
      const sign = solanaSigner(wallet, signal);
      // No extra RPCs: every Solana call goes to Mayan's RPC only.
      const { signature } = await swapFromSolana(quote, wallet.address, request.blastAddress, null, sign, solanaConnection(), [], undefined, undefined, undefined, { onTransactionSigned: onSigned });
      return signature;
    },
    async history(blastAddress) {
      const response = await fetch(`${MAYAN_EXPLORER}/v3/swaps?trader=${encodeURIComponent(blastAddress)}&limit=20`);
      if (!response.ok) throw new Error(`Mayan explorer ${response.status}`);
      return explorerRows(await response.json(), blastAddress);
    },
    async status(hash) {
      const response = await fetch(`${MAYAN_EXPLORER}/v3/swap/trx/${encodeURIComponent(hash)}`);
      // The explorer may not know a transaction for a few seconds after it is sent.
      if (response.status === 404) return { state: "pending", toAmount: null };
      if (!response.ok) throw new Error(`Mayan explorer ${response.status}`);
      const swap = (await response.json()) as { clientStatus?: string; toAmount?: string };
      return { state: transferState(swap.clientStatus), toAmount: swap.toAmount ?? null };
    },
  };
}

/** Privy signs bytes; the SDK hands over web3.js transactions. */
function solanaSigner(wallet: SolanaWallet, signal: AbortSignal) {
  async function sign(transaction: Transaction): Promise<Transaction>;
  async function sign(transaction: VersionedTransaction): Promise<VersionedTransaction>;
  async function sign(transaction: Transaction | VersionedTransaction): Promise<Transaction | VersionedTransaction> {
    signal.throwIfAborted();
    if (transaction instanceof VersionedTransaction) return VersionedTransaction.deserialize(await wallet.signTransaction(transaction.serialize()));
    const bytes = transaction.serialize({ requireAllSignatures: false, verifySignatures: false });
    return Transaction.from(await wallet.signTransaction(bytes));
  }
  return sign;
}
