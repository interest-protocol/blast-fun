import { createElement } from "react";
import { TradeFill } from "#web/components/blast-ui/CoinAmount.tsx";
import { diagnosticMessage } from "#web/lib/errors.ts";
import type { ClientWithCoreApi } from "@mysten/sui/client";

import { EXPLORER_NAMES, explorerTransactionUrl } from "@blast/core/lib/explorer.ts";
import type { ToastOptions } from "#web/components/blast-ui/Toasts.tsx";
import type { SocialWallet } from "@blast/core/web/contracts/coins.ts";
import type { SocialExplorer } from "@blast/core/web/contracts/settings.ts";

import type { CommitSigner } from "../commit/commit-flow";
import { blastWalletSigner } from "../commit/commit-signers";
import type { SocialApiOptions } from "#web/components/social/social-api.ts";
import type { runTrade as RunTrade } from "../trades/trade-flow";
import type { TradeSendInput, TradeSendResult } from "./trade-kit";
import { normalizeStructTag } from "@mysten/sui/utils";
import { SOCIAL_TRADE_BASE_COINS, walletTradeGasBudget, type TradeFeeRequired } from "@blast/core/web/contracts/trades.ts";
import { tradeBalanceMessage } from "./trade-balance";
import { sentToast, tradedToast } from "./trade-result";

/**
 * The trade kit's `send` (R3-55 over R3-31), apart from React so it is a
 * test: the Blast wallet read at the press picks the signer — an embedded
 * wallet signs with Privy's key, a wallet session signs in Slush; Blast's gas
 * pool pays for both within the day's cap (owner ruling 2026-11-20, reversing
 * OA-17), and a wallet session the server answers wallet-pays pays its own
 * fee — then `runTrade` builds, signs, executes and settles **the quote on
 * screen**: its `quote_id`, its `amount_in` (for a sell, the token amount, not
 * the dollars typed) and its `min_out`, so the fill is held to what the
 * person saw. A fill plays `land` and toasts what filled; a refusal plays
 * `error`; either way the balances are read again.
 */

export const WALLET_NOT_READY = "Your Blast wallet is not ready. Reload and try again.";

type TradeWallet = Pick<SocialWallet, "address" | "signer">;

export type TradeSendDependencies = Readonly<{
  api: SocialApiOptions;
  /** Mainnet, for a trade the wallet pays for. */
  client: () => ClientWithCoreApi;
  /** The Blast wallet now. */
  wallet: () => Promise<TradeWallet | null>;
  /** Exact native SUI, read only when Blast cannot cover the fee. */
  suiBalance: (address: string) => Promise<bigint | null>;
  /** Privy's embedded signer (the sponsored arm), when its bridge is mounted. */
  embedded: () => CommitSigner | null;
  /** A wallet session's own signer (Slush): signs, executes nothing; Blast's gas wraps it when sponsored. */
  walletSigner: (address: string) => CommitSigner;
  /** The trade path itself (`trades/trade-flow.ts`), loaded when a trade runs. */
  flow: () => Promise<Readonly<{ runTrade: typeof RunTrade }>>;
  /** A fresh UUID v4 per trade the person asked for. */
  key: () => string;
  play: (cue: Readonly<{ kind: "land" | "error" }>) => void;
  toast: (title: string, options?: ToastOptions) => void;
  explorer: SocialExplorer;
  /** The balances moved (or may have): every balance reads again. */
  moved: () => void;
}>;

function signerForTrade(wallet: TradeWallet | null, deps: TradeSendDependencies, expectedAddress?: string) {
  if (expectedAddress !== undefined && wallet?.address !== expectedAddress) return null;
  return blastWalletSigner(wallet, deps.embedded, deps.walletSigner);
}

function walletFeeOffer(result: TradeFeeRequired, available: bigint | null, input: TradeSendInput, refuse: (code: string | null, message: string) => TradeSendResult): TradeSendResult {
  const { quote, coins } = input;
  if (available === null) return refuse("balance_unavailable", "Your native SUI balance could not be checked. Refresh your wallet and try again.");
  const sui = SOCIAL_TRADE_BASE_COINS.sui;
  const budget = BigInt(result.requiredMist ?? walletTradeGasBudget(BigInt(result.feeMist)));
  const required = budget + (normalizeStructTag(quote.in_coin) === sui ? BigInt(quote.amount_in!) : 0n);
  if (available >= required) return result;
  const message = tradeBalanceMessage({ reason: "gas", coin_type: sui, required_atoms: required.toString(), available_atoms: available.toString() }, coins.in.symbol, coins.in.decimals);
  return { ...result, payable: false, message: `Blast can’t pay this trade’s network fee right now. ${message}` };
}

export async function sendTrade(deps: TradeSendDependencies, input: TradeSendInput): Promise<TradeSendResult> {
  const { quote, coins } = input;
  const refuse = (code: string | null, message: string): TradeSendResult => {
    deps.play({ kind: "error" });
    return { status: "refused", code, message };
  };
  if (quote.quote_id === null || quote.amount_in === null || quote.min_out === null) return refuse("quote_expired", diagnosticMessage("The quote expired. Refresh it and retry.", { code: "quote_expired" }));
  const wallet = await deps.wallet();
  const signer = signerForTrade(wallet, deps, input.walletAddress);
  if (signer === null) return refuse("signer-unavailable", diagnosticMessage(WALLET_NOT_READY, { code: "signer-unavailable" }));
  const { runTrade } = await deps.flow();
  const result = await runTrade(
    { api: deps.api, client: deps.client(), signer, ...(input.onPhase ? { onPhase: input.onPhase } : {}) },
    {
      quoteId: quote.quote_id,
      amountIn: quote.amount_in,
      minOut: quote.min_out,
      idempotencyKey: input.idempotencyKey ?? deps.key(),
      ...(input.acceptFee === true ? { acceptFee: true } : {}),
      inSymbol: coins.in.symbol,
      inDecimals: coins.in.decimals,
    },
  );
  if (result.status === "fee_required") return walletFeeOffer(result, await deps.suiBalance(signer.address), input, refuse);
  // Filled, refused or sent, a log row was written and the balances may have moved.
  try { deps.moved(); } catch { /* Read refresh cannot change the execution outcome. */ }
  if (result.status === "failed") return refuse(result.code, result.message);
  const fill = result.status === "traded" ? tradedToast(result.trade, coins) : null;
  const words = fill ?? sentToast();
  const href = result.trade.digest === null ? null : explorerTransactionUrl(deps.explorer, result.trade.digest);
  try { if (result.status === "traded") deps.play({ kind: "land" }); } catch { /* Feedback is best effort. */ }
  try { deps.toast(words.title, {
    ...(fill ? { titleContent: createElement(TradeFill, { verb: "Traded", first: fill.first, second: fill.second }) } : {}),
    ...(words.sub === null ? {} : { sub: words.sub }),
    ...(href ? { href, link: `View on ${EXPLORER_NAMES[deps.explorer]}` } : {}),
  }); } catch { /* The submitted transaction remains successful or pending. */ }
  return { status: result.status, title: words.title };
}
