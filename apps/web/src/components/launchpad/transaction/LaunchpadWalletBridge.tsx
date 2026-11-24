"use client";

// The production wallet bridge. It is loaded and mounted only after a
// launchpad action asks for a signer, so public readers never initialize
// Privy or a wallet connection. It creates no Blast Account and calls no Blast
// backend: Privy supplies an embedded Sui key and a launchpad-owned dApp Kit a
// direct wallet. Both sign for the one `network` the provider names.

import { normalizeSuiAddress } from "@mysten/sui/utils";
import { useLogin, usePrivy, type User } from "@privy-io/react-auth";
import { useCreateWallet, useSignRawHash } from "@privy-io/react-auth/extended-chains";
import { useCallback, useEffect, useRef, useState } from "react";
import { PrivyAuthProvider } from "#web/components/auth/PrivyAuthProvider.tsx";

import type { SignerKind } from "./action-machine";
import {
  connectDirectWalletSigner,
  connectPrivySigner,
  currentDirectWalletSigner,
  currentPrivySigner,
  type DirectWalletState,
} from "./bridge-signers";
import { launchpadDAppKit, type LaunchpadDAppKit } from "./launchpad-dapp-kit";

import type { RegisterSignerBridge, SignerBridge } from "./launchpad-signer-provider-model";
import type { LaunchpadSigner } from "./signer";

type Part = Readonly<{ current(): LaunchpadSigner | null; connect(): Promise<LaunchpadSigner> }>;
type PartReady = (kind: SignerKind, part: Part) => void;

const PRIVY_READY_TIMEOUT_MS = 15_000;

function useLatest<Value>(value: Value) {
  const ref = useRef(value);
  useEffect(() => {
    ref.current = value;
  });
  return ref;
}

function WalletPart({
  onReady,
  network,
  dAppKit,
}: Readonly<{ onReady: PartReady; network: string; dAppKit: LaunchpadDAppKit }>) {
  useEffect(() => {
    type Connection = ReturnType<typeof dAppKit.stores.$connection.get>;
    const state = (): DirectWalletState<NonNullable<Connection["wallet"]>, NonNullable<Connection["account"]>> => ({
      ...dAppKit.stores.$connection.get(),
      wallets: dAppKit.stores.$wallets.get(),
      network,
      connect: async (wallet) => (await dAppKit.connectWallet({ wallet })).accounts,
      sign: (transaction, account) => dAppKit.signTransaction({ transaction, account, network }),
      signPersonalMessage: async (message, account) =>
        (await dAppKit.signPersonalMessage({ message, account, network })).signature,
    });
    const trackAccount = (signer: LaunchpadSigner): LaunchpadSigner => ({
      ...signer,
      isConnectedAccount: () => {
        const { account } = dAppKit.stores.$connection.get();
        return Boolean(account && signer.address === normalizeSuiAddress(account.address) && account.chains.some((chain) => chain === signer.chain));
      },
    });
    onReady("wallet", {
      current: () => {
        const signer = currentDirectWalletSigner(state());
        return signer && trackAccount(signer);
      },
      connect: async () => trackAccount(await connectDirectWalletSigner(state())),
    });
  }, [dAppKit, network, onReady]);
  return null;
}

function PrivyPart({ onReady, network }: Readonly<{ onReady: PartReady; network: string }>) {
  const privy = usePrivy();
  const pendingLogin = useRef<{
    resolve: (user: User) => void;
    reject: (error: Error) => void;
  } | null>(null);
  const { login } = useLogin({
    onComplete: ({ user }) => pendingLogin.current?.resolve(user),
    onError: (code) =>
      pendingLogin.current?.reject(new Error(`Privy sign-in did not finish (${code}).`)),
  });
  const latest = useLatest({
    privy,
    login,
    createWallet: useCreateWallet().createWallet,
    signRawHash: useSignRawHash().signRawHash,
  });

  useEffect(() => {
    const state = {
      network,
      async ready() {
        const startedAt = Date.now();
        while (!latest.current.privy.ready) {
          if (Date.now() - startedAt > PRIVY_READY_TIMEOUT_MS)
            throw new Error("Privy did not start. Try again.");
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        return latest.current.privy;
      },
      login: () =>
        new Promise<User>((resolve, reject) => {
          pendingLogin.current = { resolve, reject };
          latest.current.login();
        }),
      createWallet: () => latest.current.createWallet({ chainType: "sui" }),
      signRawHash: (input: Parameters<typeof latest.current.signRawHash>[0]) =>
        latest.current.signRawHash(input),
      accessToken: () => latest.current.privy.getAccessToken(),
    };
    onReady("privy", {
      current: () =>
        latest.current.privy.authenticated
          ? currentPrivySigner(state, latest.current.privy.user)
          : null,
      connect: () => connectPrivySigner(state),
    });
  }, [latest, network, onReady]);
  return null;
}

/** Mounts Privy (when configured) and a launchpad dApp Kit for `network`, then registers one signer bridge. */
export default function LaunchpadWalletBridge({
  register,
  privyAppId,
  network,
  nonce,
}: Readonly<{
  register: RegisterSignerBridge;
  privyAppId: string | null;
  network: string;
  nonce: string;
}>) {
  const [dAppKit] = useState(() => launchpadDAppKit(network));
  const parts = useRef<Partial<Record<SignerKind, Part>>>({});
  const lastKind = useRef<SignerKind | null>(null);
  const onReady = useCallback<PartReady>(
    (kind, part) => {
      parts.current[kind] = part;
      if (!parts.current.wallet || (privyAppId && !parts.current.privy)) return;
      const bridge: SignerBridge = {
        current: () =>
          lastKind.current ? (parts.current[lastKind.current]?.current() ?? null) : null,
        async connect(requestedKind) {
          const requested = parts.current[requestedKind];
          if (!requested) throw new Error("This signer is not available here.");
          const signer = await requested.connect();
          lastKind.current = requestedKind;
          return signer;
        },
      };
      register(bridge);
    },
    [privyAppId, register],
  );
  useEffect(() => () => register(null), [register]);

  return (
    <>
      <WalletPart onReady={onReady} network={network} dAppKit={dAppKit} />
      {privyAppId ? (
        <PrivyAuthProvider appId={privyAppId} nonce={nonce}>
          <PrivyPart onReady={onReady} network={network} />
        </PrivyAuthProvider>
      ) : null}
    </>
  );
}
