"use client";

import { PrivyProvider, type PrivyClientConfig } from "@privy-io/react-auth";
import { useMemo, useState, type ReactNode } from "react";
import { StyleSheetManager } from "styled-components";
import { documentNonce } from "./privy-nonce";

export function PrivyAuthProvider({
  appId,
  nonce,
  externalWallets,
  theme,
  children,
}: Readonly<{
  appId: string;
  nonce: string | null;
  externalWallets?: PrivyClientConfig["externalWallets"];
  theme?: "light" | "dark";
  children: ReactNode;
}>) {
  const config = useMemo<PrivyClientConfig>(
    () => ({
      loginMethods: ["twitter", "google"],
      externalWallets,
      appearance: theme ? { theme } : undefined,
    }),
    [externalWallets, theme],
  );
  // Client navigation carries a new request nonce; the document's CSP still uses its original.
  const [styleNonce] = useState(() => documentNonce(nonce));
  const session = (
    <PrivyProvider appId={appId} config={config}>
      {children}
    </PrivyProvider>
  );

  return styleNonce ? <StyleSheetManager nonce={styleNonce}>{session}</StyleSheetManager> : session;
}
