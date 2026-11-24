"use client";

import { createContext, use, useState, type ReactNode } from "react";

import type { SignerKind } from "./action-machine";
import type { SignerSource } from "./controller";

import { type RegisterSignerBridge, createLazySignerSource } from "./launchpad-signer-provider-model";

const SignerSourceContext = createContext<SignerSource | null>(null);

export function LaunchpadSignerSourceProvider({ source, children }: Readonly<{ source: SignerSource; children: ReactNode }>) {
  return <SignerSourceContext value={source}>{children}</SignerSourceContext>;
}

/**
 * Shares one signer source with every launchpad action below it. Public
 * readers never mount the wallet bridge: `renderBridge` renders only after an
 * action asks to connect a signer.
 */
export function LaunchpadSignerProvider({
  kinds,
  renderBridge,
  children,
}: Readonly<{
  kinds: readonly SignerKind[];
  renderBridge: (register: RegisterSignerBridge) => ReactNode;
  children: ReactNode;
}>) {
  const [active, setActive] = useState(false);
  const [{ source, register }] = useState(() => createLazySignerSource({ kinds, activate: () => setActive(true) }));
  return (
    <SignerSourceContext value={source}>
      {children}
      {active ? renderBridge(register) : null}
    </SignerSourceContext>
  );
}

export function useLaunchpadSigners(): SignerSource {
  const source = use(SignerSourceContext);
  if (!source) throw new Error("useLaunchpadSigners needs a LaunchpadSignerProvider.");
  return source;
}
