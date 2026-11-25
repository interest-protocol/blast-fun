"use client";

import { useCallback, useMemo, useRef, type ReactNode } from "react";

import { useFeelSound } from "#web/components/blast-feel/FeelProvider.tsx";
import { usePrivySessionMounted } from "#web/components/presale/providers/PrivySessionProvider.tsx";
import { invalidateAfter } from "#web/lib/query/invalidate.ts";
import { useAppQueryClient } from "#web/lib/query/provider.tsx";
import { SOCIAL_CLAIM_KINDS } from "@blast/core/web/contracts/claims.ts";
import { LAUNCH_CLAIM_KINDS } from "@blast/core/web/contracts/launch-claims.ts";

import { CREATOR_CAPS_KIND, isCreatorCapsClaimTarget, isLaunchClaimTarget, type ClaimKind, type ClaimOutcome, type ClaimPath } from "./claims";
import { PrivyCoinSignerBridge, type PrivyCoinSigner } from "../coins/signers";
import { blastWalletSigner } from "../commit/commit-signers";
import { walletQuery } from "../queries";
import { useSocialViewer } from "../SignInGate";
import type { ClaimSigner } from "./claim-flow";

/**
 * The shell's claim transaction (R3-63): the one `ClaimPath` every claim
 * button runs, handed down through `FeedOverlaysProvider` (`useShellClaimPath`)
 * to Blast mode's presale panel (`WorkspacePresalePanel`), the sale page's
 * side box (`SaleAside`), the presales aside and the portfolio.
 *
 * **Signing stays gated** exactly as the commit's: `presaleDeployed` is the
 * layout's server-side `PRESALE_DEPLOYMENT_MANIFEST` read (a mainnet
 * deployment), and while it is false — or for a visitor — there is no path,
 * so no claim button renders anywhere. The server refuses
 * `claim_unavailable` on its own as well.
 *
 * The signer is read at the press, from the Blast wallet read
 * (`GET /api/social/me/wallet`): a Privy embedded wallet signs with the
 * embedded key (the withdraw sheet's bridge), a wallet session (Slush) signs
 * in the wallet, and Blast's gas pool pays for both (owner ruling 2026-11-20,
 * reversing OA-17).
 * The flow is imported when a claim runs, so the SDK and the transaction
 * builder stay out of a page's first load.
 */

export type ClaimHostOptions = Readonly<{
  /** The server's manifest read: a mainnet presale deployment exists. */
  presaleDeployed: boolean;
}>;

export type ClaimHostValue = Readonly<{
  /** The claim transaction; undefined while claiming is off or nobody is signed in. */
  claimPath: ClaimPath | undefined;
  /** The Privy signer's bridge, mounted in the shell's overlays. */
  node: ReactNode;
}>;

export function useClaimHost({ presaleDeployed }: ClaimHostOptions): ClaimHostValue {
  const viewer = useSocialViewer();
  const { play } = useFeelSound();
  const queries = useAppQueryClient();
  const privyMounted = usePrivySessionMounted();
  const privy = useRef<PrivyCoinSigner | null>(null);
  const onPrivy = useCallback((signer: PrivyCoinSigner | null) => {
    privy.current = signer;
  }, []);
  const getAccessToken = viewer.getAccessToken;
  const signedIn = viewer.signedIn;

  const claimPath = useMemo<ClaimPath | undefined>(() => {
    if (!presaleDeployed || !signedIn) return undefined;
    const api = { getAccessToken: getAccessToken ?? (async () => null) };
    const signer = async (): Promise<ClaimSigner | null> => {
      // The shared `/me/wallet` read (OA-38): the address and the signer kind, fresh enough to sign with.
      const wallet = await queries.fetchQuery(walletQuery(api.getAccessToken)).catch(() => null);
      return blastWalletSigner(wallet, () => privy.current?.signer() ?? null);
    };
    const path = async (...args: Parameters<ClaimPath>) => {
      const [target, signal] = args;
      try {
        const deps = { api, signer };
        let outcome: ClaimOutcome;
        if (isCreatorCapsClaimTarget(target)) {
          const { runCreatorCapsClaim } = await import("./creator-caps-flow");
          outcome = await runCreatorCapsClaim(deps, target, signal);
        } else if (isLaunchClaimTarget(target)) {
          const { runLaunchClaim } = await import("./launch-claim-flow");
          outcome = await runLaunchClaim(deps, target, signal);
        } else {
          const { runClaim } = await import("./claim-flow");
          outcome = await runClaim(deps, target, signal);
        }
        if (!signal.aborted && outcome.status === "confirmed") play({ kind: "claim" });
        return outcome;
      } finally {
        // Confirmed or refused, the claim may have moved the wallet, the position and the log (OA-38).
        if (!signal?.aborted) void invalidateAfter(queries, { kind: "claim", presaleId: target.presaleId ?? null });
      }
    };
    // Refunds, tokens, vested shares (P-13), presale creator actions, launch creator fees (LP-12) and creator rights (LP-17).
    const kinds: readonly ClaimKind[] = [...SOCIAL_CLAIM_KINDS, ...LAUNCH_CLAIM_KINDS, CREATOR_CAPS_KIND];
    path.kinds = kinds;
    return path;
  }, [getAccessToken, play, presaleDeployed, queries, signedIn]);

  const node = privyMounted ? <PrivyCoinSignerBridge onChange={onPrivy} /> : null;
  return { claimPath, node };
}
