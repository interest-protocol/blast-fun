"use client";

import { lazy, Suspense, useMemo, type ReactNode } from "react";

import type { SignerKind } from "./action-machine";
import { LaunchpadSignerProvider } from "./LaunchpadSignerProvider";

// Loaded on the first signer request, never for public readers.
const LaunchpadWalletBridge = lazy(() => import("./LaunchpadWalletBridge"));

/**
 * The production signer provider for launchpad actions: Privy embedded
 * wallets (when `privyAppId` is configured) and direct Sui wallets, mounted on
 * demand. Both sign for `network`; direct wallets use a launchpad-owned dApp
 * Kit for that network only.
 */
export function LaunchpadWalletSignerProvider({
  privyAppId,
  network,
  nonce,
  children,
}: Readonly<{ privyAppId: string | null; network: string; nonce: string; children: ReactNode }>) {
  const kinds = useMemo<readonly SignerKind[]>(() => (privyAppId ? ["privy", "wallet"] : ["wallet"]), [privyAppId]);
  return (
    <LaunchpadSignerProvider
      kinds={kinds}
      renderBridge={(register) => (
        <Suspense fallback={null}>
          <LaunchpadWalletBridge register={register} privyAppId={privyAppId} network={network} nonce={nonce} />
        </Suspense>
      )}
    >
      {children}
    </LaunchpadSignerProvider>
  );
}
