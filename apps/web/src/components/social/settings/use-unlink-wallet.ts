"use client";

import { useRef, useState } from "react";

import { useToast } from "#web/components/blast-ui/Toasts.tsx";
import { useCaptureViewerScope } from "#web/components/social/SignInGate.tsx";
import type { TokenSource } from "#web/components/social/social-api.ts";
import { diagnosticMessage, publicErrorMessage } from "#web/lib/errors.ts";
import { invalidateAfter } from "#web/lib/query/invalidate.ts";
import { useAppQueryClient } from "#web/lib/query/provider.tsx";
import type { SocialAccountWallet, SocialMeAccount } from "@blast/core/web/contracts/me.ts";

import { unlinkWallet } from "./settings-client";
import { LINK_WALLET_BUTTON_ID, UNLINK_FAILED } from "./settings-model";

type UnlinkTarget = Readonly<{ accountId: string; address: string; callsign: string; deleteAccount: boolean }>;

type Options = Readonly<{
  account: SocialMeAccount | null;
  getTokenSource(): TokenSource | undefined;
  refresh(): void;
  signOut?: () => Promise<void>;
}>;

export function useUnlinkWallet({ account, getTokenSource, refresh, signOut }: Options) {
  const client = useAppQueryClient();
  const toast = useToast();
  const captureViewer = useCaptureViewerScope();
  const [target, setTarget] = useState<UnlinkTarget | null>(null);
  const unlinked = useRef(false);

  function open(wallet: SocialAccountWallet) {
    if (!account) return;
    setTarget({
      accountId: account.account_id,
      address: wallet.address,
      callsign: account.callsign,
      deleteAccount: account.wallets.length === 1,
    });
  }

  function close() {
    setTarget(null);
    if (unlinked.current) {
      unlinked.current = false;
      document.getElementById(LINK_WALLET_BUTTON_ID)?.focus({ preventScroll: true });
    }
  }

  async function confirm(): Promise<string | null> {
    const source = getTokenSource();
    if (!source || !target || target.accountId !== account?.account_id) {
      return diagnosticMessage("Your session ended. Sign in again.", { code: "unauthorized" });
    }
    const sameViewer = captureViewer();
    const result = await unlinkWallet({ getAccessToken: source }, {
      account_id: target.accountId,
      address: target.address,
      confirm_account_deletion: target.deleteAccount,
    });
    if (!sameViewer()) return null;
    if (result.status !== "ok") {
      if (result.code === "wallet_unlink_changed") {
        refresh();
        toast(diagnosticMessage("Your wallet list changed. Review it before trying again.", result), { tone: "error" });
        return null;
      }
      return diagnosticMessage(UNLINK_FAILED, result);
    }
    unlinked.current = true;
    if (result.body.signed_out) {
      try {
        await signOut?.();
      } catch (error) {
        refresh();
        toast(publicErrorMessage(error, "Sign-out did not finish. Use Log out before linking Slush to another account."), { tone: "error" });
      }
    } else {
      refresh();
      void invalidateAfter(client, { kind: "balances" });
    }
    toast(result.body.account_deleted
      ? "Blast account deleted. Sign in to your other account to link Slush."
      : "Slush unlinked. You can now link it to another Blast account.");
    return null;
  }

  return { target, open, close, confirm };
}
