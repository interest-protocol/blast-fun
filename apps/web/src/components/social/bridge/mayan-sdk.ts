import {
  fetchQuote,
  getEvmSwapApproveTxs,
  getSwapFromEvmTxPayload,
  isEvmSwapAllowanceEnough,
  swapFromSolana,
  type QuoteOptions,
} from "@mayanfinance/swap-sdk";
import { Connection, PublicKey, Transaction, VersionedTransaction } from "@solana/web3.js";
import { BrowserProvider, Contract, JsonRpcProvider, type TransactionRequest } from "ethers";

import { mayanRpc, type BridgeChain } from "./bridge-config.ts";
import { CHAINS, transferState, type SourceToken } from "./bridge-model.ts";
import { explorerRows, MAYAN_EXPLORER, type BridgeSdk, type EvmWallet, type SolanaWallet } from "./bridge-sdk.ts";

/** Blink only: Mayan's one route that refunds on the source chain and needs no relayer on Sui. */
const BLINK_ONLY: QuoteOptions = { blink: true, swift: false, mctp: false, fastMctp: false, wormhole: false, shuttle: false, monoChain: false, gasless: false };
const ERC20 = ["function balanceOf(address) view returns (uint256)"];

/** The Mayan SDK, ethers and web3.js behind the card's `BridgeSdk`, on Mayan's RPCs. */
export function mayanSdk(): BridgeSdk {
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

  const evmSigner = async (wallet: EvmWallet) => new BrowserProvider(await wallet.provider()).getSigner(wallet.address);

  // Returns the hash once the wallet sends. `sendTransaction` would then poll the
  // wallet's own RPC with no time limit, which never ends for some smart-contract wallets.
  const sendEvm = async (wallet: EvmWallet, chain: BridgeChain, transaction: TransactionRequest): Promise<string> => {
    const signer = await evmSigner(wallet);
    const chainId = CHAINS[chain].chainId!;
    const walletChainId = Number(await signer.provider.send("eth_chainId", []));
    if (walletChainId !== chainId) throw new Error(`Wallet is on chain ${walletChainId}, not ${chain}`);
    return signer.sendUncheckedTransaction({ ...transaction, chainId });
  };

  const solanaBalance = async (token: SourceToken, owner: string): Promise<bigint> => {
    const connection = solanaConnection();
    const key = new PublicKey(owner);
    if (token.native) return BigInt(await connection.getBalance(key));
    const accounts = await connection.getParsedTokenAccountsByOwner(key, { mint: new PublicKey(token.mayan) });
    return accounts.value.reduce((sum, account) => sum + BigInt(account.account.data.parsed?.info?.tokenAmount?.amount ?? "0"), 0n);
  };

  return {
    async quote({ chain, token, to, amountIn64, swapper, destination }) {
      const [quote] = await fetchQuote(
        { amountIn64, fromToken: token.mayan, fromChain: chain, toToken: to.coinType, toChain: "sui", slippageBps: "auto", swapperAddress: swapper, destinationAddress: destination },
        BLINK_ONLY,
      );
      if (!quote) throw Object.assign(new Error("No Blink route"), { code: "ROUTE_NOT_FOUND" });
      return quote;
    },
    async balance(chain, token, owner) {
      if (chain === "solana") return solanaBalance(token, owner);
      const provider = evm(chain);
      if (token.native) return provider.getBalance(owner);
      return BigInt(await new Contract(token.mayan, ERC20, provider).getFunction("balanceOf")(owner));
    },
    allowanceEnough: (quote, wallet, chain) => isEvmSwapAllowanceEnough(quote, wallet.address, evm(chain)),
    async approve(quote, wallet, chain) {
      const provider = evm(chain);
      for (const transaction of await getEvmSwapApproveTxs(quote, wallet.address, provider)) {
        // react-doctor-disable-next-line react-doctor/async-await-in-loop -- Approvals are ordered (a reset to zero comes before the new allowance); each must be mined before the next is signed.
        const hash = await sendEvm(wallet, chain, transaction);
        await provider.waitForTransaction(hash, 1, 120_000);
      }
    },
    async send(quote, request, wallet, onSigned) {
      if (wallet.kind === "evm") {
        const chainId = CHAINS[request.chain].chainId!;
        const payload = await getSwapFromEvmTxPayload(quote, wallet.address, request.blastAddress, null, wallet.address, chainId, null, null, { evmProvider: evm(request.chain) });
        const hash = await sendEvm(wallet, request.chain, { to: payload.to, data: payload.data, value: payload.value });
        onSigned(hash);
        return hash;
      }
      const sign = solanaSigner(wallet);
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
function solanaSigner(wallet: SolanaWallet) {
  async function sign(transaction: Transaction): Promise<Transaction>;
  async function sign(transaction: VersionedTransaction): Promise<VersionedTransaction>;
  async function sign(transaction: Transaction | VersionedTransaction): Promise<Transaction | VersionedTransaction> {
    if (transaction instanceof VersionedTransaction) return VersionedTransaction.deserialize(await wallet.signTransaction(transaction.serialize()));
    const bytes = transaction.serialize({ requireAllSignatures: false, verifySignatures: false });
    return Transaction.from(await wallet.signTransaction(bytes));
  }
  return sign;
}
