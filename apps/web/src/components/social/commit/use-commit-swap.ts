"use client";
import { tradeSide } from "../trade/trade-ticket.ts";
import { parseAtoms } from "#web/components/social/trade/trade-ticket.ts";

import { useCallback } from "react";

import { SOCIAL_TRADE_DEFAULT_SLIPPAGE_BPS, type SocialTradeQuoteRequest } from "@blast/core/web/contracts/trades.ts";
import type { CommitInput, CommitPrimary } from "@blast/core/modules/social/commit/quote.ts";
import { paymentPreview, routedPayment, saleQuoteCoin } from "./commit-payment";
import { PUBLIC_BASE_COINS, type WalletCoinView } from "../coins/coin-model";
import { tradeQuoteReader, type TradeQuoteRequester } from "../trades/trades-client.ts";
import { canTrade } from "../coins/swap-model";
import { requestTradeQuote } from "../trades/trades-client";
import { paymentStatus, paymentStatusMessage } from "./payment-status";
import { useSocialViewer } from "../SignInGate";
import { useTradeQuoteQuery, type TradeQuoteTimers } from "../trade/trade-quote-query";

function paymentRequest(coin: WalletCoinView | null, quoteCoin: WalletCoinView, atoms: bigint | null, active: boolean): SocialTradeQuoteRequest | null {
  if (!coin || !canTrade(coin) || !active || atoms === null || atoms <= BigInt(0)) return null;
  return { in_coin: coin.coinType, out_coin: quoteCoin.coinType, side: tradeSide(coin.coinType, quoteCoin.coinType), amount_in: atoms.toString(), slippage_bps: SOCIAL_TRADE_DEFAULT_SLIPPAGE_BPS };
}

/** The normal swap quote engine also previews the payment leg of a presale purchase. */
export function useCommitSwap(coin: WalletCoinView | null, quoteCoin: WalletCoinView, typed: string, held: boolean, active: boolean, requester?: TradeQuoteRequester, scope = "", timers?: TradeQuoteTimers) {
  const session = useSocialViewer();
  const getAccessToken = session.getAccessToken;
  const read = useCallback((body: Parameters<typeof requestTradeQuote>[1], signal: AbortSignal) =>
    requestTradeQuote({ getAccessToken: getAccessToken ?? (async () => null), signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]) }, body), [getAccessToken]);
  const atoms = coin ? parseAtoms(typed, coin.decimals) : null;
  const request = paymentRequest(coin, quoteCoin, atoms, active);
  const snapshot = useTradeQuoteQuery({ read: tradeQuoteReader(requester ?? read), request, held, ...(timers ? { timers } : {}), scope });
  const { nowMs } = snapshot;
  const refresh = () => snapshot.refresh({ cancel: true });
  const quote = snapshot.quote;
  const state = active && coin && !canTrade(coin) ? "unsupported" : paymentStatus(snapshot, nowMs, held);
  const ready = state === "ready";
  const message = active ? paymentStatusMessage(state, coin?.symbol ?? "this coin", quoteCoin.symbol) : null;
  return { quote, ready, message, atoms, state, refresh, loading: snapshot.loading };
}

/** Compact and quick controls use the same quote engine as the full presale form. */
export function useCompactPayment(input: CommitInput | null, payCoin: WalletCoinView | null, held: boolean, active: boolean, requester?: TradeQuoteRequester, scope = "", timers?: TradeQuoteTimers) {
  const routed = input !== null && payCoin !== null && routedPayment(input.sale, payCoin);
  const coin = routed ? payCoin : null;
  const quoteCoin = input ? saleQuoteCoin(input.sale) : PUBLIC_BASE_COINS[0]!;
  const payment = useCommitSwap(coin, quoteCoin, input?.typed ?? "", held, active && routed, requester, `${input?.sale.presaleId ?? ""}:mainnet:${scope}`, timers);
  const funded = input && payCoin ? paymentPreview(input, payCoin, payment.quote, input.nowMs) : input;
  return { ...payment, routed, funded };
}

export function compactPaymentPrimary<T extends Readonly<{ label: string; disabled: boolean; action: CommitPrimary["action"] | "sign-in" }>>(primary: T, payment: ReturnType<typeof useCompactPayment>): T {
  if (!payment.routed) return primary;
  const label = payment.ready ? primary.action === "commit" ? "Swap & contribute" : primary.label : payment.loading ? "Checking swap route…" : "Swap unavailable";
  return { ...primary, label, disabled: primary.disabled || !payment.ready };
}
