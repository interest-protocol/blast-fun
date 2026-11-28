"use client";

import { useRef, useState } from "react";
import { toast as sonner } from "sonner";

import { T4 } from "#web/components/blast-ui/motion-tokens.ts";
import { useShellAction } from "#web/components/blast-ui/shell-actions.tsx";
import { useToast, type ShowToast } from "#web/components/blast-ui/Toasts.tsx";
import { diagnosticMessage, splitDiagnostic } from "#web/lib/errors.ts";
import { useSignInDraft } from "../sign-in-draft";
import { useSocialViewer } from "../SignInGate";
import { coinDraftKey, firstScreen, parseSavedCoinScreen, type CoinOpening, type CoinScreen, type WalletCoinView } from "./coin-model";
import type { CoinsHost } from "./CoinsHost";
import { tradableCoinView, tradeOpening } from "./swap-model";
import { useWalletActionDraft, type WalletActionDraft } from "./wallet-action-draft";

const loadingToast = "opening-wallet";
const failureToast = "wallet-open-failed";

function loadCoinsHost(loading: { current: boolean }, toast: ShowToast, onLoaded: (host: typeof CoinsHost) => void) {
  if (loading.current) return;
  loading.current = true;
  sonner.dismiss(failureToast);
  const pending = window.setTimeout(() => toast("Opening wallet…", { id: loadingToast, tone: "pending" }), T4);
  void import("./CoinsHost").then(({ CoinsHost }) => {
    onLoaded(CoinsHost);
  }, () => {
    const { text, detail } = splitDiagnostic(diagnosticMessage("Wallet couldn’t open.", { code: "request_failed" }));
    toast(text, {
      id: failureToast,
      tone: "error",
      sub: detail ?? undefined,
      action: { label: "Try again", onClick: () => loadCoinsHost(loading, toast, onLoaded) },
    });
  }).finally(() => {
    loading.current = false;
    window.clearTimeout(pending);
    sonner.dismiss(loadingToast);
  });
}

/** Keep the shell actions live while the wallet UI is still unloaded. */
export function CoinsOverlay() {
  const [opening, setOpening] = useState<CoinOpening | null>(null);
  const [Host, setHost] = useState<typeof CoinsHost | null>(null);
  const loading = useRef(false);
  const toast = useToast();
  const viewer = useSocialViewer();

  function open(screen: CoinScreen, coins?: readonly WalletCoinView[], walletDraft?: WalletActionDraft) {
    setOpening(current => {
      const retry = (screen.kind === "pick" && current?.screen.kind === "wd")
        || (screen.kind === "trade" && current?.screen.kind === "trade" && !coins?.length);
      return !Host && !walletDraft && current?.walletDraft && retry ? current : { screen, coins, walletDraft };
    });
    if (!Host) loadCoinsHost(loading, toast, loaded => setHost(() => loaded));
  }

  useShellAction("openFund", () => open({ kind: "fund" }));
  useShellAction("openDeposit", () => open(firstScreen("deposit", null)));
  useShellAction("openWithdraw", () => open(firstScreen("withdraw", null)));
  useShellAction("openBridge", () => open(firstScreen("bridge", null)));
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
  useWalletActionDraft("overlay", viewer.sessionIdentity === "wallet" ? "wallet" : "privy", restored => {
    open(restored.screen, restored.coins, restored.walletDraft);
  }, viewer.signedIn && !viewer.sessionPending);

  return Host && opening ? <Host opening={opening} /> : null;
}
