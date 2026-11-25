"use client";
import { vestingAttemptResponseSchema } from "@blast/core/modules/vesting/responses.ts";
import { useCallback, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { toBase64 } from "@mysten/sui/utils";
import { usePrivySessionMounted } from "#web/components/presale/providers/PrivySessionProvider.tsx";
import { useSocialViewer } from "#web/components/social/SignInGate.tsx";
import { walletIdentityQuery, walletIdentityScope } from "#web/components/social/queries.ts";
import { useAppQueryClient } from "#web/lib/query/provider.tsx";
import {
  PrivyCoinSignerBridge,
  type PrivyCoinSigner,
} from "#web/components/social/coins/signers.tsx";
import { walletCommitSigner } from "#web/components/social/commit/commit-signers.ts";
import { preparationMessage } from "@blast/core/modules/vesting/preparation-error.ts";
import { callSocialApi } from "#web/components/social/social-api.ts";
import type {
  VestingAttempt,
  VestingIntent,
} from "@blast/core/modules/vesting/model.ts";
import { VestingReviewRequiredError } from "./vesting-errors";

/** The send path (the node client, the sponsor), loaded at the first submission, not with the page. */
const loadVestingSend = () => import("./execute-reviewed");

export function useVestingWallet() {
  const viewer = useSocialViewer();
  const queries = useAppQueryClient();
  const privyMounted = usePrivySessionMounted();
  const privy = useRef<PrivyCoinSigner | null>(null);
  const onPrivy = useCallback((signer: PrivyCoinSigner | null) => {
    privy.current = signer;
  }, []);
  const [busy, setBusy] = useState(false);
  const [phase, setPhase] = useState("idle");
  const wallet = useQuery({
    ...walletIdentityQuery(walletIdentityScope(viewer), viewer.getAccessToken ?? (async () => null)),
    enabled: viewer.signedIn && !viewer.sessionPending,
  });
  const api = { getAccessToken: viewer.getAccessToken ?? (async () => null) };
  async function prepare(intent: VestingIntent): Promise<VestingAttempt> {
    const id = crypto.randomUUID();
    const result = await callSocialApi(
      api,
      `/api/social/me/vesting/attempts/${id}`,
      { method: "PUT", body: intent },
      vestingAttemptResponseSchema,
    );
    if (result.status !== "ok") {
      const reasons = result.status === "refused" ? result.reasons : undefined;
      const message =
        result.code === "invalid_request"
          ? "The schedule is no longer valid. Check your dates and amounts, then review again."
          : preparationMessage(reasons);
      throw new Error(
        `${message}${result.requestId ? ` Reference: ${result.requestId}` : ""}`,
      );
    }
    return result.body;
  }
  async function refresh(attempt: VestingAttempt): Promise<VestingAttempt> {
    const result = await callSocialApi(
      api,
      `/api/social/me/vesting/attempts/${attempt.request_id}`,
      { method: "GET" },
      vestingAttemptResponseSchema,
    );
    if (result.status !== "ok")
      throw new Error(
        `Unable to check transaction status. Your transaction ID is ${attempt.digest}. Retry checking before creating another schedule.`,
      );
    if (result.body.state !== "submitted")
      await queries.invalidateQueries({ queryKey: ["blast", "me"] });
    return result.body;
  }
  async function execute(attempt: VestingAttempt): Promise<VestingAttempt> {
    if (busy) throw new Error("A transaction is already awaiting your wallet.");
    setPhase("Checking transaction status…");
    setBusy(true);
    return loadVestingSend().then(
      ({ executeReviewedVesting }) => executeReviewedVesting(attempt, {
        refresh,
        signTransaction,
        setPhase,
        api,
      }),
      () => {
        // Nothing was signed or sent: a fresh review may replace these bytes.
        throw new VestingReviewRequiredError("The transaction could not start. Check your connection and try again.");
      },
    ).finally(() => {
      setBusy(false);
      setPhase("idle");
    });
  }
  async function signTransaction(bytes: Uint8Array): Promise<string> {
    const address = wallet.data?.address;
    if (!address) throw new Error("Your Blast wallet is not ready yet.");
    const embedded = privy.current?.signer();
    let signature: string;
    // A wallet session signs in its wallet, on Blast's gas (owner ruling
    // 2026-11-20); execute-reviewed sends only a sponsored review.
    if (wallet.data?.signer === "wallet") {
      const signer = walletCommitSigner(address);
      if (signer.fee !== "wallet")
        throw new Error("Wallet signer unavailable.");
      const signed = await signer.signTransaction(bytes);
      if (signed.bytes !== toBase64(bytes))
        throw new Error("The wallet changed the reviewed transaction.");
      signature = signed.signature;
    } else {
      if (!embedded || embedded.address !== address)
        throw new Error("Your wallet is not ready. Please retry.");
      signature = await embedded.signTransaction(bytes);
    }
    return signature;
  }
  return {
    viewer,
    wallet: viewer.signedIn && !viewer.sessionPending ? wallet.data?.address ?? null : null,
    fee: wallet.data?.fee ?? null,
    walletLoading: !!viewer.sessionPending || (viewer.signedIn && wallet.isPending),
    walletError: viewer.signedIn && wallet.isError,
    retryWallet: wallet.refetch,
    busy,
    phase,
    prepare,
    execute,
    refresh,
    node: privyMounted ? <PrivyCoinSignerBridge onChange={onPrivy} /> : null,
  };
}
