"use client";

import { useRef, useState } from "react";
import { toast as sonner } from "sonner";

import { T4 } from "#web/components/blast-ui/motion-tokens.ts";
import { useShellAction } from "#web/components/blast-ui/shell-actions.tsx";
import { useToast } from "#web/components/blast-ui/Toasts.tsx";
import { diagnosticMessage, splitDiagnostic } from "#web/lib/errors.ts";
import { useSignInDraft } from "../sign-in-draft";
import { coinDraftKey, firstScreen, parseSavedCoinScreen, type CoinOpening, type CoinScreen, type WalletCoinView } from "./coin-model";
import type { CoinsHost } from "./CoinsHost";
import { tradableCoinView, tradeOpening } from "./swap-model";

const loadingToast = "opening-wallet";

function loadCoinsHost() {
  return import("./CoinsHost");
}

/** Keep the shell actions live while the wallet UI is still unloaded. */
export function CoinsOverlay() {
  const [opening, setOpening] = useState<CoinOpening | null>(null);
  const [Host, setHost] = useState<typeof CoinsHost | null>(null);
  const loading = useRef(false);
  const toast = useToast();

  const open = (screen: CoinScreen, coins?: readonly WalletCoinView[]) => {
    setOpening({ screen, coins });
    if (Host || loading.current) return;
    loading.current = true;
    const pending = window.setTimeout(() => toast("Opening wallet…", { id: loadingToast, tone: "pending" }), T4);
    void loadCoinsHost().then(({ CoinsHost }) => {
      setHost(() => CoinsHost);
    }, () => {
      setOpening(null);
      const { text, detail } = splitDiagnostic(diagnosticMessage("Wallet couldn’t open. Try again.", { code: "request_failed" }));
      toast(text, { tone: "error", sub: detail ?? undefined });
    }).finally(() => {
      loading.current = false;
      window.clearTimeout(pending);
      sonner.dismiss(loadingToast);
    });
  };

  useShellAction("openFund", () => open({ kind: "fund" }));
  useShellAction("openDeposit", () => open(firstScreen("deposit", null)));
  useShellAction("openWithdraw", () => open(firstScreen("withdraw", null)));
  useShellAction("openCoin", (key) => open(firstScreen("coin", key ?? null)));
  useShellAction("openAllCoins", () => open({ kind: "all" }));
  useShellAction("openTrade", (argument) => {
    const trade = tradeOpening(argument);
    if (trade) open(trade.screen, trade.action ? [tradableCoinView(trade.action.coin)] : []);
  });
  useSignInDraft(coinDraftKey("open"), null, (saved) => {
    const next = parseSavedCoinScreen(saved.screen);
    if (next) open(next);
  });

  return Host && opening ? <Host opening={opening} /> : null;
}
