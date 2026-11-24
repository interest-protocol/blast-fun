"use client";

import { diagnosticMessage, publicErrorMessage } from "#web/lib/errors.ts";

import { useQuery, type QueryClient } from "@tanstack/react-query";
import { normalizeStructTag } from "@mysten/sui/utils";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";

import { soundChangeMark } from "#web/components/blast-feel/index.ts";
import { setDevicePref, useDevicePrefs } from "#web/components/blast-ui/device-prefs.ts";
import { useShellActions } from "#web/components/blast-ui/shell-actions.tsx";
import { useToast } from "#web/components/blast-ui/Toasts.tsx";
import { queryKeys } from "#web/lib/query/keys.ts";
import { useAppQueryClient } from "#web/lib/query/provider.tsx";
import type { SocialAccountWallet } from "@blast/core/web/contracts/me.ts";
import type { SocialExplorer, SocialSettingsResponse } from "@blast/core/web/contracts/settings.ts";

import { settingsQuery, walletQuery } from "../queries";
import { walletCoinViews } from "../coins/coin-model";
import type { TokenSource } from "#web/components/social/social-api.ts";
import { signInHref } from "../sign-in-gate";
import { useSocialViewer } from "../SignInGate";
import { useSocialAccount } from "../use-social-account";
import { LinkWalletSheet, useLinkWalletSession } from "./LinkWalletSheet";
import { runWalletLink, type LinkOutcome, type LinkWalletChoice } from "./link-wallet-flow";
import { TOASTS } from "./settings-model";
import { SettingsView, type SettingsMode } from "./SettingsView";
import { adoptAccountSettings } from "./use-account-settings-sync";
import { useSettingsSaver } from "./use-settings-saver";
import { useSoundSwitch } from "./use-sound-switch";


const loadLinkWalletDappKit = () => import("./link-wallet-dapp-kit");

type Loaded =
  | Readonly<{ accountId: string; status: "ready"; settings: SocialSettingsResponse }>
  | Readonly<{ accountId: string; status: "error"; message?: string }>;

/** The account's settings, read on every visit through the shared cache (OA-38: the shell's one-time sync in flight is the same request); null on any failure. */
function freshSettings(client: QueryClient, getAccessToken: TokenSource, accountId: string): Promise<SocialSettingsResponse | null> {
  return client.fetchQuery({ ...settingsQuery(getAccessToken, accountId), staleTime: 0 }).catch(() => null);
}

/**
 * The settings page (FEATURE-MAP §7) with its data: the signed-in account
 * (`me`, shared by the session), its settings (`GET /api/social/me/settings`,
 * once per account), saves through `useSettingsSaver`, the device's theme,
 * celebrations and (for visitors) explorer, the wallet list with copy and
 * "Link a Sui wallet" (T-017), the welcome tour and log out.
 */
function settingsMode(signedIn: boolean, status: ReturnType<typeof useSocialAccount>["status"], account: boolean, current: Loaded | null, settings: SocialSettingsResponse | null): SettingsMode {
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
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [generation, setGeneration] = useState(0);
  const link = useLinkWalletSession();
  const [loggingOut, setLoggingOut] = useState(false);
  const sound = useSoundSwitch();
  const account = viewer.signedIn ? liveAccount : null;
  const accountId = account?.account_id ?? null;
  const tokens = useRef(viewer.getAccessToken);
  useEffect(() => {
    tokens.current = viewer.getAccessToken;
  }, [viewer.getAccessToken]);

  useEffect(() => {
    const source = tokens.current;
    if (!accountId || !source) return;
    const controller = new AbortController();
    const mark = soundChangeMark();
    void freshSettings(client, source, accountId).then((settings) => {
      if (controller.signal.aborted) return;
      if (settings) {
        setLoaded({ accountId, status: "ready", settings });
        // The account's explorer and sound choice, onto this device (its sound only if it has one and it
        // was not changed here since; an account with none is handed this device's own choice).
        adoptAccountSettings(settings, mark, source);
      } else setLoaded({ accountId, status: "error", message: publicErrorMessage(client.getQueryState(queryKeys.me.settings(accountId))?.error, "Your settings could not load. Try again.") });
    });
    return () => controller.abort();
  }, [accountId, client, generation]);

  const current = loaded?.accountId === accountId ? loaded : null;
  const stored = current?.status === "ready" ? current.settings : null;
  const setStored = useCallback(
    (settings: SocialSettingsResponse) => {
      if (accountId) setLoaded({ accountId, status: "ready", settings });
      // The save's answer is the account's settings now: the shared read takes it as is.
      client.setQueriesData({ queryKey: queryKeys.me.settings(accountId ?? undefined) }, settings);
      setDevicePref("explorer", settings.explorer);
    },
    [accountId, client],
  );
  const saver = useSettingsSaver({
    accountId,
    stored,
    getAccessToken: viewer.getAccessToken,
    onStored: setStored,
    onFailed: (message) => toast(message),
  });
  const settings = saver.shown;

  const mode = settingsMode(viewer.signedIn, status, account !== null, current, settings);

  const walletRead = useQuery({ ...walletQuery(viewer.getAccessToken ?? (async () => null)), enabled: mode === "account" && !!viewer.getAccessToken }, client);
  const holdCoins = walletRead.data !== undefined ? walletCoinViews(walletRead.data).filter((coin) => coin.atoms > 0n) : walletRead.isError || !viewer.getAccessToken ? "error" : "pending";

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
        explorer={explorer}
        loggingOut={loggingOut}
        mode={mode}
        onCelebrate={(on) => {
          setDevicePref("celebrate", on);
        }}
        onSound={sound.set}
        onBlastConfirmation={(on) => saver.change({ patch: { blast_mode_confirm_actions: on } })}
        holdCoins={holdCoins}
        onHoldCoin={(coinType) => saver.change({ patch: { commit_too_coin_type: coinType === null ? null : normalizeStructTag(coinType) } })}
        onCopy={copy}
        onExplorer={(next) => {
          if (mode === "account") saver.change({ patch: { explorer: next } });
          else setDevicePref("explorer", next);
        }}
        onLinkWallet={link.open}
        onLogOut={logOut}
        onNotification={(key, on) => saver.change({ patch: { notifications: { [key]: on } } })}
        onPrivate={(on) => saver.change({ patch: { private: on } })}
        onPublicPortfolio={(on) => saver.change({ patch: { public_portfolio: on } })}
        onRetry={() => {
          if (!account) refresh();
          else setGeneration((value) => value + 1);
        }}
        onSignIn={() => {
          if (!run("openSignIn")) router.push(signInHref(window.location.pathname));
        }}
        settings={settings}
        sound={sound.on}
        wallets={account?.wallets ?? []}
      />
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
