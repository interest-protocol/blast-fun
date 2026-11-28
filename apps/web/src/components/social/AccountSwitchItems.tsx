"use client";

import { useQuery } from "@tanstack/react-query";
import { useId, useState } from "react";
import { shortAddress } from "@blast/core/web/format.ts";

import { usePrivySession } from "#web/components/auth/privy-session.ts";
import styles from "#web/components/blast-ui/AppShell.module.css";
import { BlastMenuItem, BlastMenuRadioGroup, BlastMenuRadioItem, BlastMenuRadioItemIndicator } from "#web/components/blast-ui/BlastMenu.tsx";
import { DiagnosticText } from "#web/components/blast-ui/DiagnosticText.tsx";
import { CheckIcon } from "#web/components/blast-ui/Icons.tsx";
import { LoadingIndicator } from "#web/components/blast-ui/LoadingIndicator.tsx";
import { useShellActions } from "#web/components/blast-ui/shell-actions.tsx";
import { findEmbeddedSuiWallet } from "#web/components/mission-control/privy-embedded-wallet.ts";
import { usePrivySessionMounted } from "#web/components/presale/providers/PrivySessionProvider.tsx";
import { rememberedWalletName } from "#web/components/sign-in/wallet-sign-in-client.ts";
import { diagnosticMessage, PublicError } from "#web/lib/errors.ts";
import { useAppQueryClient } from "#web/lib/query/provider.tsx";

import { switchAccountSession, type AccountSession } from "./account-selection";
import { fetchWalletIdentity } from "./coins/coins-client";
import { walletIdentityQuery, walletIdentityScope } from "./queries";
import { useSocialViewer } from "./SignInGate";
import { requirePrivyAccessToken } from "./use-active-privy-session";
import { useWalletSession } from "./WalletSession";

const walletCookie = async () => null;
const SWITCH_FAILED = diagnosticMessage("Could not switch accounts. Try again.", { code: "account_switch_failed" });

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
  const labelId = useId();
  const [status, setStatus] = useState<"idle" | "switching" | "failed">("idle");
  const pending = status === "switching";

  const walletQuery = walletIdentityQuery(walletScope, walletCookie);
  const walletRead = useQuery({ ...walletQuery, enabled: wallet.active, refetchOnWindowFocus: false }, client);
  const walletAddress = walletRead.data?.address;
  const walletName = (walletAddress && rememberedWalletName(walletAddress)) || "Sui wallet";
  const privyAddress = findEmbeddedSuiWallet(privy.user)?.address;

  function signIn(session: AccountSession) {
    if (!wallet.keepAccount(active)) {
      setStatus("failed");
      return;
    }
    closeMenu();
    run("openAccountSignIn", session);
  }

  function select(session: AccountSession) {
    if (session === active || pending) {
      return;
    }
    setStatus("switching");
    const verified = session === "wallet"
      ? client.fetchQuery({ ...walletQuery, staleTime: 0 })
      : verifyPrivyAccount(privy.getAccessToken);
    void verified.then(() => {
      if (!switchAccountSession(session)) {
        setStatus("failed");
      }
    }).catch((cause: unknown) => {
      setStatus("failed");
      if (session === "wallet" && cause instanceof PublicError && cause.httpStatus === 401) {
        wallet.refresh();
        signIn("wallet");
      }
    });
  }

  return (
    <>
      <div className={styles.accountMenuLabel} id={labelId}>Accounts</div>
      <BlastMenuRadioGroup aria-labelledby={labelId} value={active}>
        {(privy.authenticated || active === "privy") && (
          <AccountRow session="privy" name="Privy" address={privyAddress} pending={pending} onSelect={select} />
        )}
        {wallet.active && (
          <AccountRow session="wallet" name={walletName} address={walletAddress} pending={pending} onSelect={select} />
        )}
      </BlastMenuRadioGroup>
      {privy.ready && !privy.authenticated && active === "wallet" && (
        <BlastMenuItem className={styles.mitem} closeOnClick={false} disabled={pending} onClick={() => signIn("privy")}>Sign in with Privy</BlastMenuItem>
      )}
      {!wallet.active && active === "privy" && (
        <BlastMenuItem className={styles.mitem} closeOnClick={false} disabled={pending} onClick={() => signIn("wallet")}>Sign in with Slush</BlastMenuItem>
      )}
      {pending && <LoadingIndicator className={styles.accountMenuPending} label="Switching accounts" />}
      {status === "failed" && <div className={styles.accountMenuLabel} role="alert"><DiagnosticText message={SWITCH_FAILED} /></div>}
    </>
  );
}

async function verifyPrivyAccount(getAccessToken: () => Promise<string | null>): Promise<void> {
  const result = await fetchWalletIdentity({ getAccessToken: () => requirePrivyAccessToken(getAccessToken) });
  if (result.status !== "ok") {
    throw new Error("Privy could not verify this account.");
  }
}

function AccountRow({ session, name, address, pending, onSelect }: Readonly<{
  session: AccountSession;
  name: string;
  address?: string | null;
  pending: boolean;
  onSelect: (session: AccountSession) => void;
}>) {
  return (
    <BlastMenuRadioItem
      className={styles.mitem}
      closeOnClick={false}
      disabled={pending}
      onClick={() => onSelect(session)}
      value={session}
    >
      <span className={styles.mtext}><b><span className="nm">{name}</span></b>{address && <span>{shortAddress(address)}</span>}</span>
      <BlastMenuRadioItemIndicator className={styles.accountMenuCheck} aria-hidden="true"><CheckIcon /></BlastMenuRadioItemIndicator>
    </BlastMenuRadioItem>
  );
}
