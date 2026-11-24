"use client";

import { useMemo, useState } from "react";
import { useShellAction } from "#web/components/blast-ui/shell-actions.tsx";
import { useToast } from "#web/components/blast-ui/Toasts.tsx";
import type { SocialTradeQuote } from "@blast/core/modules/social/contracts/trades.ts";
import { CoinSheet, type TradeOutcome } from "#web/components/social/coins/CoinSheet.tsx";
import { firstScreen, type CoinScreen, type WalletCoinView } from "#web/components/social/coins/coin-model.ts";
import { fixtureTrading } from "./swap-fixture.ts";
import { tradedToast } from "#web/components/social/trade/trade-result.ts";
import { tradeOpening } from "#web/components/social/coins/swap-model.ts";
import { FIXTURE_WALLET_ADDRESS, FIXTURE_COINS, DEFAULT_SWAP_MODE } from "./coins-fixture-model.ts";

/** What the host toasts after a trade (`Traded 100 USDC for 250 SUI`, the route under it), from the fixture's own answer. */
function tradedFixtureToast(toast: ReturnType<typeof useToast>, outcome: TradeOutcome, quote: SocialTradeQuote, coins: readonly WalletCoinView[]) {
  if (outcome.status !== "traded") return;
  const inCoin = coins.find((coin) => coin.coinType === quote.in_coin);
  const outCoin = coins.find((coin) => coin.coinType === quote.out_coin);
  if (!inCoin || !outCoin) return;
  const { title, sub } = tradedToast(
    {
      trade_id: "fixture", status: "confirmed", side: quote.side, in_coin: quote.in_coin, out_coin: quote.out_coin, amount_in: quote.amount_in ?? "0",
      amount_out: quote.amount_out ?? "0", min_out: quote.min_out ?? "0", amount_out_filled: quote.amount_out, route_label: quote.route_label,
      network_fee: null, reservation_id: null, transaction_bytes: null, digest: null, expires_at_ms: null, failure_code: null, created_at_ms: 0, settled_at_ms: 0,
    },
    { in: inCoin, out: outCoin },
  );
  toast(title, { ...(sub ? { sub } : {}), href: "https://suiscan.xyz/mainnet/tx/4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi", link: "View on Suiscan" });
}

/**
 * A coins host for tests: it registers the shell's `openFund`, `openDeposit`,
 * `openWithdraw` and `openTrade` the way `CoinsHost` does, over the sample
 * wallet and the fixture's answers. Nothing here reads a wallet or signs.
 */
export function FixtureCoinsHost() {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [session, setSession] = useState(0);
  const [first, setFirst] = useState<CoinScreen>({ kind: "dep" });
  const show = (next: CoinScreen) => {
    setFirst(next);
    setSession((value) => value + 1);
    setOpen(true);
  };
  useShellAction("openFund", () => show({ kind: "fund" }));
  useShellAction("openDeposit", () => show(firstScreen("deposit", null)));
  useShellAction("openWithdraw", () => show(firstScreen("withdraw", null)));
  useShellAction("openTrade", (argument) => {
    const opening = tradeOpening(argument);
    if (opening) show({ kind: "trade", key: opening.pair.in, out: opening.pair.out });
  });
  const trading = useMemo(
    () => fixtureTrading({
      coins: FIXTURE_COINS,
      more: [],
      mode: DEFAULT_SWAP_MODE,
      onSignIn: () => setOpen(false),
      onTraded: (outcome, quote) => {
        tradedFixtureToast(toast, outcome, quote, FIXTURE_COINS);
      },
    }),
    [toast],
  );
  return (
    <CoinSheet
      first={first}
      onClose={() => setOpen(false)}
      onCopy={() => undefined}
      onRetry={() => undefined}
      onWithdraw={() => new Promise((resolve) => setTimeout(() => resolve(false), 1_200))}
      open={open}
      session={session}
      trading={trading}
      wallet={{ status: "ready", address: FIXTURE_WALLET_ADDRESS, fee: "sponsored", coins: FIXTURE_COINS }}
    />
  );
}
