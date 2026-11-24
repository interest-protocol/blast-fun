"use client";

import { useCallback, useState } from "react";
import type {
  SocialTradeQuoteRequest,
  SocialTradeQuote,
} from "@blast/core/modules/social/contracts/trades.ts";
import { PaymentCoinSelector } from "#web/components/social/commit/PaymentCoinSelector.tsx";
import { useTradeQuoteQuery } from "#web/components/social/trade/trade-quote-query.ts";
import { tradeQuoteReader } from "#web/components/social/trades/trades-client.ts";
import {
  paymentStatus,
  type PaymentStatus,
} from "#web/components/social/commit/payment-status.ts";
import { requestTradeQuote } from "#web/components/social/trades/trades-client.ts";
import { tradeSide } from "#web/components/social/trade/trade-ticket.ts";
import type { WalletCoinView } from "#web/components/social/coins/coin-model.ts";
import { useWalletCoinBalance, type WalletCoinBalance } from "#web/components/social/coins/use-wallet-coin-balance.ts";
import { useSocialViewer } from "#web/components/social/SignInGate.tsx";
import { Button } from "#web/components/blast-ui/Button.tsx";
import {
  SkeletonBox,
  SkeletonRegion,
} from "#web/components/blast-ui/Skeleton.tsx";
import { useCoinTradeWallet } from "./CoinTradeSignerProvider";
import type { CurveTradeInput } from "./curve-adapter";
import type { Curve } from "./curve-read";
import type { CurveTradeSession } from "./CurveTradeProvider";
import { parseTradeAmount } from "./amount";
import { atomsGrouped } from "@blast/core/web/format.ts";

export function useCurvePayment(
  session: CurveTradeSession,
  curve: Curve | null,
  state: Readonly<{ input: CurveTradeInput; phase: string }>,
  enabled: boolean,
) {
  const wallet = useCoinTradeWallet();
  const viewer = useSocialViewer();
  const accepted = curvePaymentCoin(curve, session.balances?.quote);
  const [picked, setPicked] = useState<WalletCoinView | null>(null);
  const selected = selectedCurvePayment(accepted, picked);
  const connected = connectedWallet(wallet);
  const routed = needsPaymentRoute(selected, accepted);
  const held = !["editing", "blocked", "failed", "rejected", "succeeded"].includes(
    state.phase,
  );
  const getAccessToken = viewer.getAccessToken;
  const request = useCallback(
    (body: SocialTradeQuoteRequest, signal: AbortSignal) =>
      requestTradeQuote(
        { getAccessToken: getAccessToken ?? (async () => null), signal },
        body,
      ),
    [getAccessToken],
  );
  const buy = session.direction === "buy";
  const payingByRoute = buy && routed;
  const payBalance = useCurveRouteBalance(wallet, selected, enabled && payingByRoute);
  const body = paymentRequest(
    routed,
    buy,
    enabled,
    connected,
    selected,
    accepted,
    state.input,
  );
  const snapshot = useTradeQuoteQuery({ read: tradeQuoteReader(request), request: body, held, scope: `curve:${session.launchId}:${wallet?.identity ?? ""}` });
  const refresh = () => snapshot.refresh({ cancel: true });
  const { quote } = snapshot;
  const { status, ready, payment } = curveRoutePayment(routed, snapshot, body, payBalance, selected);
  return {
    control: curvePaymentControl({
      visible: connected && buy,
      held,
      selected,
      accepted,
      onPick: (coin) => {
        setPicked(coin);
        session.controllers.buy.edit({
          ...state.input,
          amount: "",
          payment: undefined,
        });
      },
    }),
    note: (
      <CurvePaymentNotice
        visible={payingByRoute}
        status={status}
        quote={quote}
        selected={selected}
        accepted={accepted}
        symbol={curve?.symbol}
        refresh={refresh}
      />
    ),
    ready: !buy || ready,
    payment,
    funding: paymentFunding(routed, status, quote),
    payAsset: paymentAsset(buy ? selected : null),
    payBalance: payingByRoute ? payBalance : undefined,
  };
}

function selectedCurvePayment(accepted: WalletCoinView | null, picked: WalletCoinView | null) {
  return !accepted || !picked || picked.coinType === accepted.coinType ? accepted : picked;
}

function connectedWallet(wallet: ReturnType<typeof useCoinTradeWallet>) {
  return Boolean(wallet?.signedIn && wallet.identity);
}

function useCurveRouteBalance(wallet: ReturnType<typeof useCoinTradeWallet>, selected: WalletCoinView | null, active: boolean) {
  return useWalletCoinBalance(wallet?.address, selected?.coinType ?? "", active && wallet?.network === "mainnet", wallet?.pending);
}

function curveRoutePayment(routed: boolean, snapshot: ReturnType<typeof useTradeQuoteQuery>, body: SocialTradeQuoteRequest | null, balance: WalletCoinBalance, selected: WalletCoinView | null) {
  const { quote, nowMs } = snapshot;
  const quoted = paymentStatus(snapshot, nowMs);
  const short = balance.status === "ready" && balance.atoms < BigInt(body?.amount_in ?? "0");
  const status = quoted === "ready" && short ? "insufficient-balance" : quoted;
  const ready = !routed || (status === "ready" && balance.status === "ready" && Boolean(quote?.quote_id));
  return { status, ready, payment: routed && ready ? paymentTerms(quote, selected) : undefined };
}

/**
 * The curve payment the estimate uses: undefined when unrouted (the typed
 * amount pays the curve), else the routed quote's `min_out`, null while there
 * is none. A quote refused for balance still prices the route, so an amount
 * above the balance still shows its estimate.
 */
export function paymentFunding(routed: boolean, status: PaymentStatus, quote: SocialTradeQuote | null): string | null | undefined {
  if (!routed) return undefined;
  return status === "ready" || status === "insufficient-balance" ? quote?.min_out ?? null : null;
}

function curvePaymentControl({
  visible,
  held,
  selected,
  accepted,
  onPick,
}: Readonly<{
  visible: boolean;
  held: boolean;
  selected: WalletCoinView | null;
  accepted: WalletCoinView | null;
  onPick(coin: WalletCoinView): void;
}>) {
  if (!visible || !selected || !accepted) return null;
  return (
    <PaymentCoinSelector
      coins={[]}
      busy={held}
      selected={selected}
      accepted={accepted}
      purchase={false}
      inField
      onPick={onPick}
    />
  );
}

function CurvePaymentNotice({
  visible,
  selected,
  accepted,
  ...props
}: Readonly<{
  visible: boolean;
  selected: WalletCoinView | null;
  accepted: WalletCoinView | null;
}> &
  Omit<Parameters<typeof PaymentNote>[0], "selected" | "accepted">) {
  if (!visible || !selected || !accepted) return null;
  return <PaymentNote {...props} selected={selected} accepted={accepted} />;
}

function paymentRequest(
  routed: boolean,
  buy: boolean,
  enabled: boolean,
  connected: boolean,
  selected: WalletCoinView | null,
  accepted: WalletCoinView | null,
  input: CurveTradeInput,
) {
  if (!routed || !buy || !enabled || !connected) return null;
  return quoteRequest(selected, accepted, input);
}

function quoteRequest(
  selected: WalletCoinView | null,
  accepted: WalletCoinView | null,
  input: CurveTradeInput,
): SocialTradeQuoteRequest | null {
  if (!selected || !accepted) return null;
  const amount = parseTradeAmount(input.amount, selected.decimals);
  if (!amount.ok) return null;
  return {
    in_coin: selected.coinType,
    out_coin: accepted.coinType,
    amount_in: amount.atomic.toString(),
    slippage_bps: Number(input.slippageBps),
    side: tradeSide(selected.coinType, accepted.coinType),
  };
}

function PaymentNote({
  status,
  quote,
  selected,
  accepted,
  symbol,
  refresh,
}: Readonly<{
  status: PaymentStatus;
  quote: SocialTradeQuote | null;
  selected: WalletCoinView;
  accepted: WalletCoinView;
  symbol?: string;
  refresh(): void;
}>) {
  if (status === "quoting")
    return (
      <SkeletonRegion label="Finding payment route">
        <SkeletonBox />
      </SkeletonRegion>
    );
  if (status === "no-route" || status === "unsupported")
    return (
      <p role="status">
        No route from {selected.symbol} to {accepted.symbol} for this amount.
        Choose another coin or amount.
      </p>
    );
  if (status === "ready" && quote) {
    const fee = BigInt(quote.blast_fee_amount ?? "0");
    return (
      <p role="status">
        {selected.symbol} → {accepted.symbol} → {symbol}. Swap and buy complete
        together.{" "}
        {fee > BigInt(0)
          ? `Routing fee ${atomsGrouped(fee, accepted.decimals)} ${accepted.symbol}. `
          : ""}
        Extra {accepted.symbol} returns to your wallet.
      </p>
    );
  }
  if (status === "idle") return null;
  return (
    <p role="alert">
      {status === "insufficient-balance"
        ? quote?.balance_failure?.reason === "gas"
          ? "Not enough SUI for the network fee."
          : `Not enough ${selected.symbol} for this payment.`
        : "Payment quote unavailable or expired."}{" "}
      <Button size="sm" onClick={refresh}>
        Refresh quote
      </Button>
    </p>
  );
}

function curvePaymentCoin(
  curve: Curve | null,
  balance?: bigint,
): WalletCoinView | null {
  return curve
    ? {
        key: curve.quote.coinType,
        coinType: curve.quote.coinType,
        symbol: curve.quote.symbol,
        name: curve.quote.symbol,
        decimals: curve.quote.decimals,
        atoms: balance ?? BigInt(0),
        amount: 0,
        price: null,
        value: null,
        iconUrl: curve.quote.iconUrl,
        round: true,
        presale: null,
      }
    : null;
}

function paymentTerms(
  quote: SocialTradeQuote | null,
  selected: WalletCoinView | null,
): CurveTradeInput["payment"] {
  if (!quote?.quote_id || !quote.min_out || !quote.expires_at_ms || !selected)
    return undefined;
  return {
    coinType: selected.coinType,
    symbol: selected.symbol,
    decimals: selected.decimals,
    quoteId: quote.quote_id,
    quoteAmount: quote.min_out,
    expiresAtMs: quote.expires_at_ms,
  };
}

function paymentAsset(selected: WalletCoinView | null) {
  if (!selected) return null;
  return {
    symbol: selected.symbol,
    decimals: selected.decimals,
    quote: {
      coinType: selected.coinType,
      symbol: selected.symbol,
      decimals: selected.decimals,
      iconUrl: selected.iconUrl,
    },
  };
}

function needsPaymentRoute(
  selected: WalletCoinView | null,
  accepted: WalletCoinView | null,
): boolean {
  return Boolean(
    selected && accepted && selected.coinType !== accepted.coinType,
  );
}
