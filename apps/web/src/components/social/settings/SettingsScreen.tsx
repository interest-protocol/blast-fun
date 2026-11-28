"use client";

import { diagnosticMessage, publicErrorMessage } from "#web/lib/errors.ts";

import { useQuery, type QueryClient } from "@tanstack/react-query";
import { normalizeStructTag } from "@mysten/sui/utils";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { setDevicePref, useDevicePrefs } from "#web/components/blast-ui/device-prefs.ts";
import { useShellActions } from "#web/components/blast-ui/shell-actions.tsx";
import { useToast } from "#web/components/blast-ui/Toasts.tsx";
import type { TokenSource } from "#web/components/social/social-api.ts";
import { useAppQueryClient } from "#web/lib/query/provider.tsx";
import type { SocialAccountWallet } from "@blast/core/web/contracts/me.ts";
import type { SocialExplorer, SocialSettingsResponse } from "@blast/core/web/contracts/settings.ts";

import { walletQuery } from "../queries";
import { walletCoinViews } from "../coins/coin-model";
import { signInHref } from "../sign-in-gate";
import { useSocialViewer } from "../SignInGate";
import { useSocialAccount } from "../use-social-account";
import { LinkWalletSheet, useLinkWalletSession } from "./LinkWalletSheet";
import { runWalletLink, type LinkOutcome, type LinkWalletChoice } from "./link-wallet-flow";
import { TOASTS } from "./settings-model";
import { SettingsView, type SettingsMode } from "./SettingsView";
import { UnlinkWalletSheet } from "./UnlinkWalletSheet";
import { useSettingsRecord, type SettingsRecord } from "./use-settings-record.ts";
import { useSettingsSaver } from "./use-settings-saver";
import { useUnlinkWallet } from "./use-unlink-wallet";

const zeroAtoms = 0n;
const loadLinkWalletDappKit = () => import("./link-wallet-dapp-kit");

function useWalletHoldCoins(client: QueryClient, source: TokenSource | undefined, hasAccountSettings: boolean) {
  const wallet = useQuery({ ...walletQuery(source ?? (async () => null)), enabled: hasAccountSettings && !!source }, client);
  if (wallet.data !== undefined) return walletCoinViews(wallet.data).filter((coin) => coin.atoms > zeroAtoms);
  return wallet.isError || !source ? "error" : "pending";
}

/**
 * The settings page (FEATURE-MAP §7) with its data: the signed-in account
 * (`me`, shared by the session), its settings (`GET /api/social/me/settings`,
 * once per account), saves through `useSettingsSaver`, the device's theme,
 * celebrations and (for visitors) explorer, the wallet list with copy and
 * "Link a Sui wallet" (T-017), the welcome tour and log out.
 */
function settingsMode(signedIn: boolean, status: ReturnType<typeof useSocialAccount>["status"], account: boolean, current: SettingsRecord | null, settings: SocialSettingsResponse | null): SettingsMode {
  if (status === "loading") return "loading";
  if (!signedIn || status === "signed_out") return "visitor";
  if (status === "error" && !account) return "error";
  if (!account) return status === "ready" ? "no-account" : "loading";
  if (current?.status === "error") return "error";
  return settings ? "account" : "loading";
}

export function SettingsScreen() {
  const viewer = useSocialViewer();
  const { status, account: liveAccount, refresh } = useSocialAccount();
  const device = useDevicePrefs();
  const toast = useToast();
  const run = useShellActions();
  const router = useRouter();
  const client = useAppQueryClient();
  const link = useLinkWalletSession();
  const [loggingOut, setLoggingOut] = useState(false);
  const account = viewer.signedIn ? liveAccount : null;
  const accountId = account?.account_id ?? null;
  const { current, setStored, retry, tokens } = useSettingsRecord(client, accountId, viewer.getAccessToken);
  const unlink = useUnlinkWallet({ account, getTokenSource: () => tokens.current, refresh, signOut: viewer.signOut });
  const stored = current?.status === "ready" ? current.settings : null;
  const saver = useSettingsSaver({
    accountId,
    stored,
    getAccessToken: viewer.getAccessToken,
    onStored: setStored,
    onFailed: (message) => toast(message),
  });
  const settings = saver.shown;

  const mode = settingsMode(viewer.signedIn, status, account !== null, current, settings);

  const holdCoins = useWalletHoldCoins(client, viewer.getAccessToken, mode === "account");

  const copy = async (wallet: SocialAccountWallet) => {
    try {
      await navigator.clipboard.writeText(wallet.address);
      return true;
    } catch (error) {
      toast(publicErrorMessage(error, "Copying is blocked here. Select the address instead."));
      return false;
    }
  };

  const pickWallet = async (choice: LinkWalletChoice): Promise<LinkOutcome> => {
    const source = tokens.current;
    if (!source) return { status: "failed", message: diagnosticMessage("Your session ended. Sign in again, then link the wallet.", { code: "unauthorized" }) };
    const { dappKitWalletAdapter } = await loadLinkWalletDappKit();
    return runWalletLink({ choice, adapter: dappKitWalletAdapter, getAccessToken: source });
  };

  const logOut = () => {
    if (!viewer.signOut || loggingOut) return;
    setLoggingOut(true);
    void viewer.signOut().then(
      () => {
        setLoggingOut(false);
      },
      (error) => {
        setLoggingOut(false);
        toast(publicErrorMessage(error, TOASTS.logOutFailed));
      },
    );
  };

  const explorer: SocialExplorer = mode === "account" && settings ? settings.explorer : device.explorer;

  return (
    <>
      <SettingsView
        errorMessage={current?.status === "error" ? current.message : undefined}
        callsign={account?.callsign ?? null}
        celebrate={device.celebrate}
        buyAlerts={device.buyAlerts}
        explorer={explorer}
        loggingOut={loggingOut}
        mode={mode}
        onCelebrate={(on) => {
          setDevicePref("celebrate", on);
        }}
        onBuyAlerts={(on) => {
          setDevicePref("buyAlerts", on);
        }}
        onBlastConfirmation={(on) => saver.change({ patch: { blast_mode_confirm_actions: on } })}
        holdCoins={holdCoins}
        onHoldCoin={(coinType) => saver.change({ patch: { commit_too_coin_type: coinType === null ? null : normalizeStructTag(coinType) } })}
        onCopy={copy}
        onExplorer={(next) => {
          if (mode === "account") saver.change({ patch: { explorer: next } });
          else setDevicePref("explorer", next);
        }}
        onLinkWallet={link.open}
        onUnlinkWallet={unlink.open}
        onLogOut={logOut}
        onNotification={(key, on) => saver.change({ patch: { notifications: { [key]: on } } })}
        onPrivate={(on) => saver.change({ patch: { private: on } })}
        onPublicPortfolio={(on) => saver.change({ patch: { public_portfolio: on } })}
        onRetry={() => {
          if (!account) refresh();
          else retry();
        }}
        onSignIn={() => {
          if (!run("openSignIn")) router.push(signInHref(window.location.pathname));
        }}
        settings={settings}
        wallets={account?.wallets ?? []}
      />
      {unlink.target ? <UnlinkWalletSheet {...unlink.target} onClose={unlink.close} onConfirm={unlink.confirm} /> : null}
      {link.session !== null ? (
        <LinkWalletSheet
          key={link.session}
          onClose={() => link.closed(link.session)}
          onLinked={(outcome) => {
            toast(TOASTS.linked(outcome.name));
            refresh();
          }}
          onPick={pickWallet}
        />
      ) : null}
    </>
  );
}
