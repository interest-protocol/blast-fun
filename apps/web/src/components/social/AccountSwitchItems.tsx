"use client";

import { useQuery } from "@tanstack/react-query";
import clsx from "clsx";
import { useState } from "react";
import { shortAddress } from "@blast/core/web/format.ts";

import { usePrivySession } from "#web/components/auth/privy-session.ts";
import styles from "#web/components/blast-ui/AppShell.module.css";
import {
  BlastMenuItem,
  BlastMenuRadioGroup,
  BlastMenuRadioItem,
  BlastMenuRadioItemIndicator,
  BlastSubmenu,
} from "#web/components/blast-ui/BlastMenu.tsx";
import { DiagnosticText } from "#web/components/blast-ui/DiagnosticText.tsx";
import { CheckIcon } from "#web/components/blast-ui/Icons.tsx";
import { LoadingIndicator } from "#web/components/blast-ui/LoadingIndicator.tsx";
import { useShellActions } from "#web/components/blast-ui/shell-actions.tsx";
import { useToast } from "#web/components/blast-ui/Toasts.tsx";
import { findEmbeddedSuiWallet } from "#web/components/mission-control/privy-embedded-wallet.ts";
import { usePrivySessionMounted } from "#web/components/presale/providers/PrivySessionProvider.tsx";
import { diagnosticMessage, PublicError } from "#web/lib/errors.ts";
import { useAppQueryClient } from "#web/lib/query/provider.tsx";

import { signInMethodName, useWalletSuiName, walletCookie, walletSessionName } from "./account-wallets";
import { switchAccountSession, type AccountSession } from "./account-selection";
import { fetchWalletIdentity } from "./coins/coins-client";
import { withdrawalSwitchBlock, type WithdrawalSwitchBlock } from "./coins/withdraw-attempt";
import { walletIdentityQuery, walletIdentityScope } from "./queries";
import { useSocialViewer } from "./SignInGate";
import { requirePrivyAccessToken } from "./use-active-privy-session";
import { useWalletSession } from "./WalletSession";

const SWITCH_FAILED = "Could not switch accounts. Try again.";
const switchNotice = { id: "account-switch", tone: "error" } as const;
const WITHDRAWAL_SWITCH_MESSAGE: Record<WithdrawalSwitchBlock, string> = {
  broadcasting: "Wait for your withdrawal to submit before switching accounts.",
  receipt: "Retry your withdrawal to check its status before switching accounts. This won’t send it again.",
};

export function AccountSwitchItems({ closeMenu }: Readonly<{ closeMenu: () => void }>) {
  const viewer = useSocialViewer();
  const privyAvailable = usePrivySessionMounted();
  const wallet = useWalletSession();

  if (!viewer.signedIn || viewer.sessionPending || !wallet.available || !privyAvailable) {
    return null;
  }

  const active = viewer.sessionIdentity === "wallet" ? "wallet" : "privy";
  const walletScope = walletIdentityScope({ sessionIdentity: "wallet", callsign: active === "wallet" ? viewer.callsign : null });
  return <AccountChoices active={active} closeMenu={closeMenu} walletScope={walletScope} />;
}

function AccountChoices({ active, closeMenu, walletScope }: Readonly<{
  active: AccountSession;
  closeMenu: () => void;
  walletScope: string;
}>) {
  const privy = usePrivySession();
  const wallet = useWalletSession();
  const client = useAppQueryClient();
  const run = useShellActions();
  const toast = useToast();
  const [pendingSession, setPendingSession] = useState<AccountSession | null>(null);
  const pending = pendingSession !== null;

  const walletQuery = walletIdentityQuery(walletScope, walletCookie);
  const walletRead = useQuery({ ...walletQuery, enabled: wallet.active, refetchOnWindowFocus: false }, client);
  const walletAddress = walletRead.data?.address;
  const walletName = walletSessionName(walletAddress);
  const privyAddress = findEmbeddedSuiWallet(privy.user)?.address;

  function reportWithdrawalBlock(): boolean {
    const block = withdrawalSwitchBlock();
    if (!block) {
      return false;
    }
    const message = WITHDRAWAL_SWITCH_MESSAGE[block];
    toast(message, {
      ...switchNotice,
      titleContent: <DiagnosticText message={diagnosticMessage(message, { code: "withdrawal_switch_blocked" })} />,
    });
    return true;
  }

  function reportSwitchFailure() {
    toast(SWITCH_FAILED, {
      ...switchNotice,
      titleContent: <DiagnosticText message={diagnosticMessage(SWITCH_FAILED, { code: "account_switch_failed" })} />,
    });
  }

  function signIn(session: AccountSession) {
    if (reportWithdrawalBlock()) {
      return;
    }
    if (!wallet.keepAccount(active)) {
      reportSwitchFailure();
      return;
    }
    closeMenu();
    run("openAccountSignIn", session);
  }

  function select(session: AccountSession) {
    if (session === active || pending || reportWithdrawalBlock()) {
      return;
    }
    setPendingSession(session);
    const verified = session === "wallet"
      ? client.fetchQuery({ ...walletQuery, staleTime: 0 })
      : verifyPrivyAccount(privy.getAccessToken);
    void verified.then(() => {
      if (!switchAccountSession(session)) {
        setPendingSession(null);
        if (!reportWithdrawalBlock()) {
          reportSwitchFailure();
        }
      }
    }).catch((cause: unknown) => {
      setPendingSession(null);
      if (session === "wallet" && cause instanceof PublicError && cause.httpStatus === 401) {
        wallet.refresh();
        signIn("wallet");
        return;
      }
      reportSwitchFailure();
    });
  }

  return (
    <BlastSubmenu
      className={clsx(styles.menu, styles.accountSubmenu)}
      label="Accounts"
      trigger={<span className={styles.mtext}><b>Accounts</b></span>}
      triggerClassName={clsx(styles.mitem, styles.accountsTrigger)}
    >
      <BlastMenuRadioGroup value={active}>
        {(privy.authenticated || active === "privy") && (
          <AccountRow session="privy" name={signInMethodName(privy.user)} address={privyAddress} pendingSession={pendingSession} onSelect={select} />
        )}
        {wallet.active && (
          <AccountRow session="wallet" name={walletName} address={walletAddress} pendingSession={pendingSession} onSelect={select} />
        )}
      </BlastMenuRadioGroup>
      {privy.ready && !privy.authenticated && active === "wallet" && (
        <BlastMenuItem className={clsx(styles.mitem, styles.accountChoice)} closeOnClick={false} disabled={pending} onClick={() => signIn("privy")}>Add Blast account</BlastMenuItem>
      )}
      {!wallet.active && active === "privy" && (
        <BlastMenuItem className={clsx(styles.mitem, styles.accountChoice)} closeOnClick={false} disabled={pending} onClick={() => signIn("wallet")}>Sign in with Slush</BlastMenuItem>
      )}
    </BlastSubmenu>
  );
}

async function verifyPrivyAccount(getAccessToken: () => Promise<string | null>): Promise<void> {
  const result = await fetchWalletIdentity({ getAccessToken: () => requirePrivyAccessToken(getAccessToken) });
  if (result.status !== "ok") {
    throw new Error("Privy could not verify this account.");
  }
}

function AccountRow({ session, name, address, pendingSession, onSelect }: Readonly<{
  session: AccountSession;
  name: string;
  address?: string | null;
  pendingSession: AccountSession | null;
  onSelect: (session: AccountSession) => void;
}>) {
  const suiName = useWalletSuiName(address);

  return (
    <BlastMenuRadioItem
      className={clsx(styles.mitem, styles.accountChoice)}
      closeOnClick={false}
      disabled={pendingSession !== null}
      onClick={() => onSelect(session)}
      value={session}
    >
      <span className={styles.mtext}>
        <b><span className="nm">{suiName ?? name}</span></b>
        {address && (
          <span className={styles.accountMenuDetails}>
            {suiName && <span className="nm">{name} ·</span>}
            <span>{shortAddress(address)}</span>
          </span>
        )}
      </span>
      <span className={styles.accountChoiceStatus}>
        {pendingSession === session ? (
          <LoadingIndicator label={`Switching to ${suiName ?? name}`} />
        ) : (
          <BlastMenuRadioItemIndicator aria-hidden="true"><CheckIcon /></BlastMenuRadioItemIndicator>
        )}
      </span>
    </BlastMenuRadioItem>
  );
}
