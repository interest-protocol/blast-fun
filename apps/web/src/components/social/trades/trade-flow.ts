import { diagnosticMessage, publicErrorMessage, type ErrorDiagnostic } from "#web/lib/errors.ts";
import { bcs } from "@mysten/sui/bcs";
import type { ClientWithCoreApi } from "@mysten/sui/client";
import { TransactionDataBuilder } from "@mysten/sui/transactions";
import { fromBase64, normalizeSuiAddress } from "@mysten/sui/utils";

import type { SocialTrade } from "@blast/core/web/contracts/trades.ts";

import {
  executeOnFullnode,
  pollSettlement,
  sendSponsored,
  signExactly,
  type Sent,
  type TransactionSigner,
  type Unsigned,
} from "#web/components/social/sponsored-transaction.ts";
import type { ApiResult, SocialApiOptions } from "#web/components/social/social-api.ts";
import { tradeBalanceMessage } from "../trade/trade-balance";
import type { TradeFeeRequired } from "@blast/core/web/contracts/trades.ts";
import { createTrade, settleTrade } from "./trades-client";

/**
 * One trade (social feed R3-31; FEATURE-MAP-R3 §14.1 and §21.3's
 * `executeTrade`), the browser's half: ask the server to build the trade the
 * quote pinned, check the bytes it returned, have the wallet sign exactly
 * them, execute, then let the server settle it from the chain.
 *
 * - **Blast pays** (an embedded Blast wallet or a wallet session within the
 *   day's cap, owner ruling 2026-11-20): the bytes carry the sponsor's gas;
 *   the wallet signs exactly them and the sponsor executes them
 *   (`POST /api/presale/sponsor/{reservation_id}/execute`, as commits and
 *   withdrawals do).
 * - **The wallet pays** (a wallet past the day's cap that accepted the fee):
 *   the wallet signs and the fullnode executes.
 *
 * Nothing is signed before the server built it, nothing is sent that the
 * wallet did not sign, and the server never holds a key. A retry with the same
 * `idempotencyKey` gets the first trade back and never builds a second one.
 */

export type TradePhase = "preparing" | "signing" | "trading" | "settling";

export type TradeRequest = Readonly<{
  quoteId: string;
  amountIn: string;
  minOut: string;
  /** A UUID v4 per trade the person asked for; resent on a retry of the same trade. */
  idempotencyKey: string;
  /** Pay the network fee from the wallet's SUI, after `fee_required` was shown and accepted. */
  acceptFee?: boolean;
  /** The input coin's symbol, for the gate's `Not enough ${symbol}`. */
  inSymbol: string;
  inDecimals?: number;
}>;

export type TradeDependencies = Readonly<{
  api: SocialApiOptions;
  /** Mainnet, to execute a trade the wallet pays for. */
  client: ClientWithCoreApi;
  /** Privy's embedded key or Slush: either signs only. */
  signer: TransactionSigner;
  onPhase?: (phase: TradePhase) => void;
}>;

export type TradeResult =
  | Readonly<{ status: "traded"; trade: SocialTrade }>
  /** Blast will not pay the fee today: show `feeMist` and run again with `acceptFee` and the same key. */
  | TradeFeeRequired
  /** Nothing filled. `code` lets a surface re-quote on `price_moved` or `quote_expired`. */
  | Readonly<{ status: "failed"; message: string; code: string | null; trade: SocialTrade | null }>
  /** Sent, and the chain does not show it yet: the account's transaction log settles it. */
  | Readonly<{ status: "pending"; trade: SocialTrade }>;

/** The gate's failure words (§14.1): `Not enough ${symbol}` and `That didn’t go through`. */
export const TRADE_FAILED = "That didn’t go through";
export const TRADE_NOT_SIGNED = "You didn’t confirm it. Nothing was sent.";
export const TRADE_BYTES_CHANGED = "Your wallet signed a different transaction. Nothing was sent.";
export const TRADE_BYTES_UNEXPECTED = "Blast returned a different transaction. Nothing was signed.";

function failure(code: string | null, inSymbol: string, trade: SocialTrade | null, diagnostic: ErrorDiagnostic = {}, inDecimals = 9): TradeResult {
  let message = TRADE_FAILED;
  if (code === "insufficient_balance") {
    message = trade?.balance_failure
      ? tradeBalanceMessage(trade.balance_failure, inSymbol, inDecimals)
      : "Not enough funds. Check the sell-token balance and native SUI for the network fee.";
  }
  return { status: "failed", message: diagnosticMessage(message, { ...diagnostic, code }), code, trade };
}

function unsignedFailure(unsigned: Unsigned, trade: SocialTrade): TradeResult {
  // A wallet may rebuild what it signs: only the bytes the server built may go out.
  if (unsigned.reason === "mismatch") return { status: "failed", message: diagnosticMessage(TRADE_BYTES_CHANGED, { code: "invalid_response" }), code: null, trade };
  const cancelled = unsigned.reason === "rejected";
  const code = cancelled ? "rejected" : "sign_failed";
  const message = cancelled ? TRADE_NOT_SIGNED : "Your wallet could not sign. Reconnect it and retry. Nothing was sent.";
  return { status: "failed", message: publicErrorMessage(unsigned.error, message, code), code, trade };
}

/** Decode the server's transaction only when its sender and digest match the trade. */
export function readBuiltBytes(encoded: string, trade: Pick<SocialTrade, "digest">, sender: string): Uint8Array | null {
  try {
    const bytes = fromBase64(encoded);
    const data = bcs.TransactionData.parse(bytes).V1;
    return data && normalizeSuiAddress(data.sender) === normalizeSuiAddress(sender) && TransactionDataBuilder.getDigestFromBytes(bytes) === trade.digest ? bytes : null;
  } catch {
    return null;
  }
}

/** Reads the trade until the chain shows it or the waits run out; a read that fails keeps the trade last read and waits again. */
async function settled(deps: TradeDependencies, trade: SocialTrade): Promise<SocialTrade> {
  let latest = trade;
  async function read(): Promise<ApiResult<SocialTrade>> {
    const answer = await settleTrade(deps.api, trade.trade_id);
    if (answer.status === "ok") latest = answer.body;
    // A failed read is answered as the trade last read (its status synthesized), so the poll keeps waiting.
    return { status: "ok", body: latest, httpStatus: answer.httpStatus ?? 0 };
  }
  await pollSettlement(read, isBuilt);
  return latest;
}

function isBuilt(trade: SocialTrade): boolean {
  return trade.status === "built";
}

function ended(trade: SocialTrade, inSymbol: string, inDecimals = 9): TradeResult {
  if (trade.status === "confirmed") return { status: "traded", trade };
  if (trade.status === "failed") return failure(trade.failure_code, inSymbol, trade, {}, inDecimals);
  return { status: "pending", trade };
}

/** Through the sponsor when Blast pays, else on the fullnode. */
function sendBuiltTrade(deps: TradeDependencies, trade: SocialTrade, bytes: Uint8Array, signature: string): Promise<Sent> {
  return trade.network_fee?.payer === "blast" && trade.reservation_id
    ? sendSponsored(deps.api, trade.reservation_id, signature)
    : executeOnFullnode(deps.client, bytes, signature);
}

export async function runTrade(deps: TradeDependencies, request: TradeRequest): Promise<TradeResult> {
  deps.onPhase?.("preparing");
  const created = await createTrade(deps.api, {
    quote_id: request.quoteId,
    amount_in: request.amountIn,
    min_out: request.minOut,
    idempotency_key: request.idempotencyKey,
    ...(request.acceptFee ? { accept_fee: true } : {}),
  });
  if (created.status === "fee_required") return created;
  if (created.status === "error") return failure(created.code ?? "network_unavailable", request.inSymbol, null, created);
  if (created.status === "refused") return failure(created.code, request.inSymbol, null, created);
  const { trade } = created;
  // A replay of a trade already sent: settle it, never sign it again.
  if (trade.status !== "built" || trade.transaction_bytes === null) return ended(trade.status === "built" ? await settled(deps, trade) : trade, request.inSymbol, request.inDecimals);

  const bytes = readBuiltBytes(trade.transaction_bytes, trade, deps.signer.address);
  if (bytes === null) return { status: "failed", message: diagnosticMessage(TRADE_BYTES_UNEXPECTED, { code: "invalid_response" }), code: null, trade };

  deps.onPhase?.("signing");
  const signed = await signExactly(deps.signer, bytes);
  if (signed.status === "unsigned") return unsignedFailure(signed, trade);

  deps.onPhase?.("trading");
  const sent = await sendBuiltTrade(deps, trade, bytes, signed.signature);
  // A refused execute sent nothing; anything else may have: settle by the digest, which the chain decides.
  if (sent.status === "refused") return failure(sent.refusal.code, request.inSymbol, trade, sent.refusal);
  deps.onPhase?.("settling");
  return ended(await settled(deps, trade), request.inSymbol, request.inDecimals);
}
