"use client";

import { useQuery } from "@tanstack/react-query";
import { normalizeSuiAddress } from "@mysten/sui/utils";
import {
  createContext,
  use,
  useLayoutEffect,
  useState,
  type ReactNode,
} from "react";

import { usePrivySession } from "#web/components/auth/privy-session.ts";
import { useSocialViewer } from "#web/components/social/SignInGate.tsx";
import { useWalletSession } from "#web/components/social/WalletSession.tsx";
import { walletIdentityQuery, walletIdentityScope } from "#web/components/social/queries.ts";
import type { SocialWallet } from "@blast/core/modules/social/contracts/coins.ts";
import { walletCommitSigner } from "#web/components/social/commit/commit-signers.ts";
import { useAppQueryClient } from "#web/lib/query/provider.tsx";

import { currentPrivySigner } from "../transaction/bridge-signers";
import { LaunchpadSignerSourceProvider } from "../transaction/LaunchpadSignerProvider";
import { LaunchpadWalletSignerProvider } from "../transaction/LaunchpadWalletSignerProvider";
import type { LaunchpadSigner } from "../transaction/signer";
import { createSessionSignerSource } from "./session-signer";

type WalletState = Readonly<{
  signedIn: boolean;
  pending: boolean;
  identity: string;
  address: string | null;
  network: string;
  problem: string | null;
  retry(): void;
}>;
const WalletContext = createContext<WalletState | null>(null);
export const useCoinTradeWallet = () => use(WalletContext);

type Props = Readonly<{
  privyAppId: string | null;
  network: string;
  nonce: string;
  children: ReactNode;
}>;

export function CoinTradeSignerProvider(props: Props) {
  const session = useWalletSession();
  if (!session.available) return <LaunchpadWalletSignerProvider {...props} />;
  return <PrivyTradeSignerProvider {...props} />;
}

function PrivyTradeSignerProvider({ network, children }: Props) {
  const privy = usePrivySession();
  const walletSession = useSocialViewer().sessionIdentity === "wallet";
  const runtime = walletSession ? null : privy.runtime;
  let embedded: LaunchpadSigner | null = null;
  if (runtime?.authenticated) {
    try {
      embedded = currentPrivySigner(
        { network, signRawHash: runtime.signRawHash, accessToken: runtime.getAccessToken },
        runtime.user,
      );
    } catch {
      // An incomplete embedded wallet must show recovery without crashing the coin page.
    }
  }
  return (
    <SharedTradeSignerProvider
      embedded={embedded}
      embeddedPending={!walletSession && !privy.ready}
      network={network}
    >
      {children}
    </SharedTradeSignerProvider>
  );
}

function SharedTradeSignerProvider({
  embedded,
  embeddedPending = false,
  network,
  children,
}: Readonly<{
  embedded: LaunchpadSigner | null;
  embeddedPending?: boolean;
  network: string;
  children: ReactNode;
}>) {
  const viewer = useSocialViewer();
  const active = viewer.signedIn && !viewer.sessionPending;
  const query = useQuery(
    {
      ...walletIdentityQuery(walletIdentityScope(viewer), viewer.getAccessToken ?? (async () => null)),
      enabled: active,
    },
    useAppQueryClient(),
  );
  const wallet = active && !query.isError ? query.data : null;
  const signer = canonicalSigner(wallet ?? null, embedded);
  const [session] = useState(createSessionSignerSource);
  useLayoutEffect(() => {
    session.update(signer);
  });
  useLayoutEffect(() => () => session.update(null), [session]);
  const pending = tradeWalletPending(
    viewer,
    query.isPending,
    wallet ?? null,
    embeddedPending,
  );
  const identity = signer
    ? `${viewer.sessionIdentity ?? ""}:${signer.kind}:${signer.address}:${signer.chain}`
    : "";
  return (
    <LaunchpadSignerSourceProvider source={session.source}>
      <WalletContext
        value={{
          signedIn: viewer.signedIn,
          pending,
          identity,
          address: signer?.address ?? null,
          network,
          problem:
            viewer.signedIn && !pending && !signer
              ? "Your Blast wallet could not load. Try again."
              : null,
          retry: () => void query.refetch(),
        }}
      >
        {children}
      </WalletContext>
    </LaunchpadSignerSourceProvider>
  );
}

function canonicalSigner(
  wallet: SocialWallet | null,
  embedded: LaunchpadSigner | null,
): LaunchpadSigner | null {
  if (wallet?.address) {
    if (
      wallet.signer === "privy" &&
      embedded &&
      normalizeSuiAddress(embedded.address) ===
        normalizeSuiAddress(wallet.address)
    )
      return embedded;
    if (wallet.signer === "wallet") {
      const direct = walletCommitSigner(wallet.address);
      return {
        kind: "wallet",
        label: "Blast wallet",
        address: direct.address,
        chain: "sui:mainnet",
        // The session's wallet read says whether Blast's gas pays (owner ruling 2026-11-20).
        sponsored: wallet.fee === "sponsored",
        signTransaction: async (bytes) => {
          const signed = await direct.signTransaction(bytes);
          if (typeof signed === "string")
            throw new Error(
              "The wallet did not return its signed transaction bytes.",
            );
          return signed;
        },
      };
    }
  }
  return null;
}

function tradeWalletPending(
  viewer: Pick<
    ReturnType<typeof useSocialViewer>,
    "sessionPending" | "signedIn"
  >,
  queryPending: boolean,
  wallet: SocialWallet | null,
  embeddedPending: boolean,
): boolean {
  return Boolean(
    viewer.sessionPending ||
      (viewer.signedIn &&
        (queryPending || (wallet?.signer === "privy" && embeddedPending))),
  );
}
