import {
  fetchQuote,
  getAssociatedTokenAddress,
  getEvmSwapApproveTxs,
  getSwapFromEvmTxPayload,
  getTransactionFirstSignature,
  isEvmSwapAllowanceEnough,
  swapFromSolana,
  type Quote,
  type QuoteOptions,
} from "@mayanfinance/swap-sdk";
import { Connection, PublicKey, Transaction, VersionedTransaction } from "@solana/web3.js";
import { BrowserProvider, Contract, JsonRpcProvider, type TransactionRequest } from "ethers";

import { fetchSourceTokens } from "./bridge-catalog.ts";
import { mayanRpc, type BridgeChain } from "./bridge-config.ts";
import { pickRoute, type BridgeRequest } from "./bridge-guard.ts";
import { CHAINS, transferState, type SourceToken } from "./bridge-model.ts";
import { abortableProvider, explorerRows, MAYAN_EXPLORER, type BridgeSdk, type EvmWallet, type SolanaWallet } from "./bridge-sdk.ts";
import { verifySolanaExpiry, type SolanaExpiry } from "./solana-expiry.ts";
import { readSolanaSubmission, rememberSolanaSubmission, settleSolanaSubmission, withSolanaSubmissionLock } from "./solana-submission.ts";

/** Blink only: Mayan's one route that refunds on the source chain and needs no relayer on Sui. */
const BLINK_ONLY: QuoteOptions = { blink: true, swift: false, mctp: false, fastMctp: false, wormhole: false, shuttle: false, monoChain: false, gasless: false };
/** Every route Mayan prices from these chains to Sui, asked in one request. */
const ALL_ROUTES: QuoteOptions = { ...BLINK_ONLY, fastMctp: true, mctp: true, fullList: true };
const ERC20 = ["function balanceOf(address) view returns (uint256)"];
const TOKEN_2022_PROGRAM = new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");

/** The Mayan SDK, ethers and web3.js behind the card's `BridgeSdk`, on Mayan's RPCs. */
export function mayanSdk(allRoutes = false): BridgeSdk {
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

  // With every route off, only Blink quotes may reach a wallet.
  const assertRouteOn = (quote: Quote) => {
    if (!allRoutes && quote.type !== "BLINK") throw new Error(`The ${quote.type} route is off`);
  };

  const evmPayload = (quote: Quote, { chain, blastAddress }: BridgeRequest, wallet: EvmWallet) =>
    getSwapFromEvmTxPayload(quote, wallet.address, blastAddress, null, wallet.address, CHAINS[chain].chainId!, null, null, { evmProvider: evm(chain) });

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
      const quotes = await fetchQuote(
        { amountIn64, fromToken: token.mayan, fromChain: chain, toToken: to.coinType, toChain: "sui", slippageBps: "auto", swapperAddress: swapper, destinationAddress: destination },
        allRoutes ? ALL_ROUTES : BLINK_ONLY,
      );
      const quote = allRoutes ? pickRoute(quotes, input, Date.now()) : quotes.find(({ type }) => type === "BLINK");
      if (quote) return quote;
      if (quotes.length > 0) console.warn("Mayan sent no usable route", quotes.map(({ type }) => type));
      throw Object.assign(new Error("No supported bridge route"), { code: "ROUTE_NOT_FOUND" });
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
      assertRouteOn(quote);
      const provider = evm(chain);
      const transactions = await getEvmSwapApproveTxs(quote, wallet.address, provider);
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
      assertRouteOn(quote);
      if (wallet.kind === "evm") {
        const payload = await evmPayload(quote, request, wallet);
        const hash = await sendEvm(wallet, request.chain, { to: payload.to, data: payload.data, value: payload.value }, signal);
        onSigned(hash);
        return hash;
      }
      if (readSolanaSubmission(wallet.address)) throw new Error("Another Solana transfer is awaiting confirmation");
      const connection = new BridgeSolanaConnection(mayanRpc("solana"), "confirmed");
      const sign = solanaSigner(wallet, signal, (transaction) => {
        const expiry = connection.expiry;
        const blockhash = transaction instanceof VersionedTransaction ? transaction.message.recentBlockhash : transaction.recentBlockhash;
        if (!expiry || expiry.blockhash !== blockhash) throw new Error("Unknown Solana transaction blockhash");
        const signature = getTransactionFirstSignature(transaction);
        // Mayan can broadcast as soon as its signer resolves. Record the exact signed transaction first.
        rememberSolanaSubmission(wallet.address, signature, expiry);
        onSigned(signature);
      });
      const { signature } = await swapFromSolana(quote, wallet.address, request.blastAddress, null, sign, connection, []);
      return signature;
    },
    checkSolanaSubmission: (address, signal) => withSolanaSubmissionLock(address, () => settleSolanaSubmission(
      solanaConnection(), address, (expiry, signature) => verifySolanaExpiry(expiry, signature, signal),
    )),
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

/** Anchor Mayan's own blockhash to the finalized chain before the wallet signs. */
class BridgeSolanaConnection extends Connection {
  expiry?: SolanaExpiry;

  override async getLatestBlockhash() {
    const { context, value } = await this.getLatestBlockhashAndContext("finalized");
    this.expiry = { slot: context.slot, ...value };
    return value;
  }
}

/** Privy signs bytes; the SDK hands over web3.js transactions. */
function solanaSigner(wallet: SolanaWallet, signal: AbortSignal, onSigned: (transaction: Transaction | VersionedTransaction) => void) {
  async function sign(transaction: Transaction): Promise<Transaction>;
  async function sign(transaction: VersionedTransaction): Promise<VersionedTransaction>;
  async function sign(transaction: Transaction | VersionedTransaction): Promise<Transaction | VersionedTransaction> {
    signal.throwIfAborted();
    const signed = transaction instanceof VersionedTransaction
      ? VersionedTransaction.deserialize(await wallet.signTransaction(transaction.serialize()))
      : Transaction.from(await wallet.signTransaction(transaction.serialize({ requireAllSignatures: false, verifySignatures: false })));
    onSigned(signed);
    return signed;
  }
  return sign;
}
